/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { createFunctionHandle } from "convex/server";
import {
  afterEach,
  assert,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from "vitest";
import { getOrCreateActorRow, getMailboxRow } from "./actors.js";
import { api, internal } from "./_generated/api.js";
import schema from "./schema.js";
import { RECOVERY_THRESHOLD_MS } from "./shared.js";

const modules = import.meta.glob("./**/*.ts");

const T0 = 1_700_000_000_000;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
});
afterEach(() => {
  vi.useRealTimers();
});

async function makeExecuteHandle() {
  return (await createFunctionHandle(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (api as any).kick.kickMailbox,
  )) as unknown as import("./kick.js").ExecuteFnHandle;
}

describe("listStuckMailboxes", () => {
  test("no mailboxes → empty", async () => {
    const t = convexTest(schema, modules);
    const result = await t.run(async (ctx) => {
      return await ctx.db.query("mailboxState").collect();
    });
    expect(result).toHaveLength(0);

    const stuck = await t.query(internal.recovery.listStuckMailboxes, {});
    expect(stuck).toHaveLength(0);
  });

  test("fresh running row (within threshold) → not stuck", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      const executeFn = await makeExecuteHandle();
      const { mailbox } = await getOrCreateActorRow(ctx, {
        actorType: "counter",
        name: "a",
        executeFn,
      });
      await ctx.db.patch(mailbox._id, {
        drainKind: "running",
        drainStartedAt: T0,
      });
    });

    const stuck = await t.query(internal.recovery.listStuckMailboxes, {});
    expect(stuck).toHaveLength(0);
  });

  test("stale running row → stuck", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      const executeFn = await makeExecuteHandle();
      const { mailbox } = await getOrCreateActorRow(ctx, {
        actorType: "counter",
        name: "a",
        executeFn,
      });
      await ctx.db.patch(mailbox._id, {
        drainKind: "running",
        drainStartedAt: T0 - RECOVERY_THRESHOLD_MS - 1,
      });
    });

    const stuck = await t.query(internal.recovery.listStuckMailboxes, {});
    expect(stuck).toHaveLength(1);
  });

  test("idle and scheduled rows are ignored", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      const executeFn = await makeExecuteHandle();
      // idle
      await getOrCreateActorRow(ctx, { actorType: "counter", name: "a", executeFn });
      // scheduled
      const { mailbox } = await getOrCreateActorRow(ctx, {
        actorType: "counter",
        name: "b",
        executeFn,
      });
      const scheduledId = await ctx.scheduler.runAt(
        T0 + 5000,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        executeFn as any,
        { actorId: mailbox.actorId, generation: 0, executeFn },
      );
      await ctx.db.patch(mailbox._id, {
        drainKind: "scheduled",
        drainScheduledId: scheduledId,
        drainAt: T0 + 5000,
      });
    });

    const stuck = await t.query(internal.recovery.listStuckMailboxes, {});
    expect(stuck).toHaveLength(0);
  });
});

describe("recoverMailbox", () => {
  test("stale running → rescheduled, back to scheduled state", async () => {
    const t = convexTest(schema, modules);
    const actorId = await t.run(async (ctx) => {
      const executeFn = await makeExecuteHandle();
      const { actor, mailbox } = await getOrCreateActorRow(ctx, {
        actorType: "counter",
        name: "a",
        executeFn,
      });
      await ctx.db.patch(mailbox._id, {
        drainKind: "running",
        drainStartedAt: T0 - RECOVERY_THRESHOLD_MS - 1,
        executeFn,
      });
      return actor._id;
    });

    await t.mutation(internal.recovery.recoverMailbox, { actorId });

    await t.run(async (ctx) => {
      const mailbox = (await getMailboxRow(ctx, actorId))!;
      assert(mailbox.drainKind === "scheduled");
      expect(mailbox.drainAt).toBe(T0);
    });
  });

  test("fresh running (within threshold) → no-op", async () => {
    const t = convexTest(schema, modules);
    const actorId = await t.run(async (ctx) => {
      const executeFn = await makeExecuteHandle();
      const { actor, mailbox } = await getOrCreateActorRow(ctx, {
        actorType: "counter",
        name: "a",
        executeFn,
      });
      await ctx.db.patch(mailbox._id, {
        drainKind: "running",
        drainStartedAt: T0,
        executeFn,
      });
      return actor._id;
    });

    await t.mutation(internal.recovery.recoverMailbox, { actorId });

    await t.run(async (ctx) => {
      const mailbox = (await getMailboxRow(ctx, actorId))!;
      // Still running — not recovered
      expect(mailbox.drainKind).toBe("running");
    });
  });

  test("idle mailbox → no-op", async () => {
    const t = convexTest(schema, modules);
    const actorId = await t.run(async (ctx) => {
      const executeFn = await makeExecuteHandle();
      const { actor } = await getOrCreateActorRow(ctx, {
        actorType: "counter",
        name: "a",
        executeFn,
      });
      return actor._id;
    });

    await t.mutation(internal.recovery.recoverMailbox, { actorId });

    await t.run(async (ctx) => {
      const mailbox = (await getMailboxRow(ctx, actorId))!;
      expect(mailbox.drainKind).toBe("idle");
    });
  });

  test("concurrent recovery and drain — only one wins", async () => {
    const t = convexTest(schema, modules);
    const actorId = await t.run(async (ctx) => {
      const executeFn = await makeExecuteHandle();
      const { actor, mailbox } = await getOrCreateActorRow(ctx, {
        actorType: "counter",
        name: "a",
        executeFn,
      });
      await ctx.db.patch(mailbox._id, {
        generation: 5,
        drainKind: "running",
        drainStartedAt: T0 - RECOVERY_THRESHOLD_MS - 1,
        executeFn,
      });
      return actor._id;
    });

    // Both recovery and a simulated drain-finish run concurrently.
    // In convex-test each t.run/t.mutation is its own transaction.
    // We run both; whichever sees the running state first wins,
    // the other sees a different drain.kind and no-ops.
    await Promise.all([
      t.mutation(internal.recovery.recoverMailbox, { actorId }),
      // Simulate a drain finishing: transition running → idle
      t.run(async (ctx) => {
        const mailbox = (await getMailboxRow(ctx, actorId))!;
        if (mailbox.drainKind === "running") {
          await ctx.db.patch(mailbox._id, {
            generation: mailbox.generation + 1,
            drainKind: "idle",
            drainStartedAt: undefined,
          });
        }
      }),
    ]);

    // After both complete, mailbox should be in a consistent state.
    // Either recovery won (scheduled) or drain won (idle), but not
    // corrupted.
    await t.run(async (ctx) => {
      const mailbox = (await getMailboxRow(ctx, actorId))!;
      expect(["idle", "scheduled"]).toContain(mailbox.drainKind);
    });
  });
});
