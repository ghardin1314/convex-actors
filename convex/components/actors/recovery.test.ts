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
import { getOrCreateActorRow, getSignalRow, getBookkeepingRow } from "./actors.js";
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
  test("no rows → empty", async () => {
    const t = convexTest(schema, modules);
    const result = await t.run(async (ctx) => {
      return await ctx.db.query("drainSignal").collect();
    });
    expect(result).toHaveLength(0);

    const stuck = await t.query(internal.recovery.listStuckMailboxes, {});
    expect(stuck).toHaveLength(0);
  });

  test("fresh running row (within threshold) → not stuck", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      const executeFn = await makeExecuteHandle();
      const { actor } = await getOrCreateActorRow(ctx, {
        actorType: "counter",
        name: "a",
        executeFn,
      });
      const signal = (await getSignalRow(ctx, actor._id))!;
      const bk = (await getBookkeepingRow(ctx, actor._id))!;
      await ctx.db.patch(signal._id, {
        drainKind: "running",
      });
      await ctx.db.patch(bk._id, {
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
      const { actor } = await getOrCreateActorRow(ctx, {
        actorType: "counter",
        name: "a",
        executeFn,
      });
      const signal = (await getSignalRow(ctx, actor._id))!;
      const bk = (await getBookkeepingRow(ctx, actor._id))!;
      await ctx.db.patch(signal._id, {
        drainKind: "running",
      });
      await ctx.db.patch(bk._id, {
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
      const { actor } = await getOrCreateActorRow(ctx, {
        actorType: "counter",
        name: "b",
        executeFn,
      });
      const signal = (await getSignalRow(ctx, actor._id))!;
      const bk = (await getBookkeepingRow(ctx, actor._id))!;
      const scheduledId = await ctx.scheduler.runAt(
        T0 + 5000,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        executeFn as any,
        { actorId: actor._id, generation: 0, executeFn },
      );
      await ctx.db.patch(signal._id, {
        drainKind: "scheduled",
      });
      await ctx.db.patch(bk._id, {
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
      const { actor } = await getOrCreateActorRow(ctx, {
        actorType: "counter",
        name: "a",
        executeFn,
      });
      const signal = (await getSignalRow(ctx, actor._id))!;
      const bk = (await getBookkeepingRow(ctx, actor._id))!;
      await ctx.db.patch(signal._id, {
        drainKind: "running",
      });
      await ctx.db.patch(bk._id, {
        drainStartedAt: T0 - RECOVERY_THRESHOLD_MS - 1,
        executeFn,
      });
      return actor._id;
    });

    await t.mutation(internal.recovery.recoverMailbox, { actorId });

    await t.run(async (ctx) => {
      const signal = (await getSignalRow(ctx, actorId))!;
      const bk = (await getBookkeepingRow(ctx, actorId))!;
      assert(signal.drainKind === "scheduled");
      expect(bk.drainAt).toBe(T0);
    });
  });

  test("fresh running (within threshold) → no-op", async () => {
    const t = convexTest(schema, modules);
    const actorId = await t.run(async (ctx) => {
      const executeFn = await makeExecuteHandle();
      const { actor } = await getOrCreateActorRow(ctx, {
        actorType: "counter",
        name: "a",
        executeFn,
      });
      const signal = (await getSignalRow(ctx, actor._id))!;
      const bk = (await getBookkeepingRow(ctx, actor._id))!;
      await ctx.db.patch(signal._id, {
        drainKind: "running",
      });
      await ctx.db.patch(bk._id, {
        drainStartedAt: T0,
        executeFn,
      });
      return actor._id;
    });

    await t.mutation(internal.recovery.recoverMailbox, { actorId });

    await t.run(async (ctx) => {
      const signal = (await getSignalRow(ctx, actorId))!;
      expect(signal.drainKind).toBe("running");
    });
  });

  test("idle drain → no-op", async () => {
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
      const signal = (await getSignalRow(ctx, actorId))!;
      expect(signal.drainKind).toBe("idle");
    });
  });

  test("concurrent recovery and drain — only one wins", async () => {
    const t = convexTest(schema, modules);
    const actorId = await t.run(async (ctx) => {
      const executeFn = await makeExecuteHandle();
      const { actor } = await getOrCreateActorRow(ctx, {
        actorType: "counter",
        name: "a",
        executeFn,
      });
      const signal = (await getSignalRow(ctx, actor._id))!;
      const bk = (await getBookkeepingRow(ctx, actor._id))!;
      await ctx.db.patch(signal._id, {
        generation: 5,
        drainKind: "running",
      });
      await ctx.db.patch(bk._id, {
        drainStartedAt: T0 - RECOVERY_THRESHOLD_MS - 1,
        executeFn,
      });
      return actor._id;
    });

    await Promise.all([
      t.mutation(internal.recovery.recoverMailbox, { actorId }),
      t.run(async (ctx) => {
        const signal = (await getSignalRow(ctx, actorId))!;
        if (signal.drainKind === "running") {
          await ctx.db.patch(signal._id, {
            generation: signal.generation + 1,
            drainKind: "idle",
          });
        }
      }),
    ]);

    await t.run(async (ctx) => {
      const signal = (await getSignalRow(ctx, actorId))!;
      expect(["idle", "scheduled"]).toContain(signal.drainKind);
    });
  });
});
