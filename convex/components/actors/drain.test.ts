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
import {
  getBookkeepingRow,
  getSignalRow,
  getActorStateRow,
  getOrCreateActorRow,
} from "./actors.js";
import { internal } from "./_generated/api.js";
import { enqueueMessageHandler } from "./enqueue.js";
import { kickMailbox, type ExecuteFnHandle } from "./kick.js";
import schema from "./schema.js";

const modules = import.meta.glob("./**/*.ts");

const T0 = 1_700_000_000_000;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
});
afterEach(() => {
  vi.useRealTimers();
});

async function getTestExecuteFn(): Promise<string> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return await createFunctionHandle((internal as any).testHelpers.testExecute);
}

/** Set up an actor with a pending message and kick it to scheduled state. */
async function setupActorWithMessage(
  t: ReturnType<typeof convexTest>,
  opts?: { actorType?: string; name?: string; msgType?: string; payload?: unknown; deliverAt?: number },
) {
  const actorType = opts?.actorType ?? "counter";
  const name = opts?.name ?? "a";
  const msgType = opts?.msgType ?? "inc";
  const payload = opts?.payload ?? { by: 1 };
  const deliverAt = opts?.deliverAt ?? T0;

  return await t.run(async (ctx) => {
    const executeFn = (await getTestExecuteFn()) as ExecuteFnHandle;
    const { actor } = await getOrCreateActorRow(ctx, {
      actorType,
      name,
      executeFn,
    });
    await enqueueMessageHandler(
      ctx,
      [{ actorType, name, msgType, payload, deliverAt }],
      executeFn,
    );
    await kickMailbox(ctx, {
      actorId: actor._id,
      deliverAt,
      executeFn,
    });
    const signal = (await getSignalRow(ctx, actor._id))!;
    return { actorId: actor._id, executeFn, generation: signal.generation };
  });
}

// ── drainLoop ────────────────────────────────────────────────────

describe("drainLoop", () => {
  test("processes a pending message and writes actorState + response", async () => {
    const t = convexTest(schema, modules);
    const { actorId, executeFn, generation } = await setupActorWithMessage(t);

    await t.mutation(internal.drain.drainLoop, {
      actorId,
      generation,
      executeFn,
      cursorTs: T0,
    });

    await t.run(async (ctx) => {
      const stateRow = await getActorStateRow(ctx, actorId);
      expect(stateRow).not.toBeNull();
      expect(stateRow!.state).toEqual({ n: 1 });

      const responses = await ctx.db
        .query("responses")
        .withIndex("by_actor", (q) => q.eq("actorId", actorId))
        .collect();
      expect(responses).toHaveLength(1);
      expect(responses[0].response).toEqual({
        kind: "success",
        value: { newCount: 1 },
      });

      const pending = await ctx.db
        .query("pendingMessages")
        .withIndex("by_actor_deliverable", (q) => q.eq("actorId", actorId))
        .collect();
      expect(pending).toHaveLength(0);
    });
  });

  test("stale generation throws", async () => {
    const t = convexTest(schema, modules);
    const { actorId, executeFn } = await setupActorWithMessage(t);

    await expect(
      t.mutation(internal.drain.drainLoop, {
        actorId,
        generation: 999,
        executeFn,
        cursorTs: T0,
      }),
    ).rejects.toThrow(/stale drain/);
  });

  test("frozen cursor ignores messages beyond cursorTs", async () => {
    const t = convexTest(schema, modules);
    const executeFn = await t.run(getTestExecuteFn);

    // Set up actor with two messages: one at T0, one at T0+5000
    const { actorId, generation } = await t.run(async (ctx) => {
      const fn = executeFn as ExecuteFnHandle;
      const { actor } = await getOrCreateActorRow(ctx, {
        actorType: "counter",
        name: "a",
        executeFn: fn,
      });
      await enqueueMessageHandler(
        ctx,
        [
          { actorType: "counter", name: "a", msgType: "inc", payload: { by: 1 }, deliverAt: T0 },
          { actorType: "counter", name: "a", msgType: "inc", payload: { by: 10 }, deliverAt: T0 + 5000 },
        ],
        fn,
      );
      await kickMailbox(ctx, { actorId: actor._id, deliverAt: T0, executeFn: fn });
      const signal = (await getSignalRow(ctx, actor._id))!;
      return { actorId: actor._id, generation: signal.generation };
    });

    // Drain with cursorTs = T0 — should only process the first message
    await t.mutation(internal.drain.drainLoop, {
      actorId,
      generation,
      executeFn,
      cursorTs: T0,
    });

    await t.run(async (ctx) => {
      const stateRow = await getActorStateRow(ctx, actorId);
      expect(stateRow!.state).toEqual({ n: 1 });

      // Future message still pending
      const pending = await ctx.db
        .query("pendingMessages")
        .withIndex("by_actor_deliverable", (q) => q.eq("actorId", actorId))
        .collect();
      expect(pending).toHaveLength(1);
      expect(pending[0].deliverAt).toBe(T0 + 5000);
    });
  });

  test("self-schedules within cursor range when more work exists", async () => {
    const t = convexTest(schema, modules);
    const executeFn = await t.run(getTestExecuteFn);

    const { actorId, generation } = await t.run(async (ctx) => {
      const fn = executeFn as ExecuteFnHandle;
      const { actor } = await getOrCreateActorRow(ctx, {
        actorType: "counter",
        name: "a",
        executeFn: fn,
      });
      await enqueueMessageHandler(
        ctx,
        [
          { actorType: "counter", name: "a", msgType: "inc", payload: { by: 1 }, deliverAt: T0 },
          { actorType: "counter", name: "a", msgType: "inc", payload: { by: 2 }, deliverAt: T0 },
        ],
        fn,
      );
      await kickMailbox(ctx, { actorId: actor._id, deliverAt: T0, executeFn: fn });
      const signal = (await getSignalRow(ctx, actor._id))!;
      return { actorId: actor._id, generation: signal.generation };
    });

    // Process first message
    await t.mutation(internal.drain.drainLoop, {
      actorId,
      generation,
      executeFn,
      cursorTs: T0,
    });

    // Signal should still be running with bumped generation
    await t.run(async (ctx) => {
      const signal = (await getSignalRow(ctx, actorId))!;
      expect(signal.drainKind).toBe("running");
      expect(signal.generation).toBe(generation + 1);

      // One message still pending
      const pending = await ctx.db
        .query("pendingMessages")
        .withIndex("by_actor_deliverable", (q) => q.eq("actorId", actorId))
        .collect();
      expect(pending).toHaveLength(1);
    });
  });

  test("delegates to updateDrainStatus when cursor range exhausted", async () => {
    const t = convexTest(schema, modules);
    const { actorId, executeFn, generation } = await setupActorWithMessage(t);

    // Process the only message
    await t.mutation(internal.drain.drainLoop, {
      actorId,
      generation,
      executeFn,
      cursorTs: T0,
    });

    // After processing, drain delegates to updateDrainStatus (still "running")
    await t.run(async (ctx) => {
      const signal = (await getSignalRow(ctx, actorId))!;
      expect(signal.drainKind).toBe("running");
      expect(signal.generation).toBe(generation + 1);
    });
  });

  test("defect after MAX_ATTEMPTS writes defect response", async () => {
    const t = convexTest(schema, modules);
    const executeFn = await t.run(getTestExecuteFn);

    const { actorId, generation } = await t.run(async (ctx) => {
      const fn = executeFn as ExecuteFnHandle;
      const { actor } = await getOrCreateActorRow(ctx, {
        actorType: "throwActor",
        name: "a",
        executeFn: fn,
      });
      await enqueueMessageHandler(
        ctx,
        [{ actorType: "throwActor", name: "a", msgType: "boom", payload: {}, deliverAt: T0 }],
        fn,
      );
      await kickMailbox(ctx, { actorId: actor._id, deliverAt: T0, executeFn: fn });
      const signal = (await getSignalRow(ctx, actor._id))!;
      return { actorId: actor._id, generation: signal.generation };
    });

    // Drain 3 times (MAX_ATTEMPTS) — each defect increments attempts
    let gen = generation;
    for (let i = 0; i < 3; i++) {
      await t.mutation(internal.drain.drainLoop, {
        actorId,
        generation: gen,
        executeFn,
        cursorTs: T0,
      });
      const signal = await t.run(async (ctx) => (await getSignalRow(ctx, actorId))!);
      gen = signal.generation;
    }

    await t.run(async (ctx) => {
      const responses = await ctx.db
        .query("responses")
        .withIndex("by_actor", (q) => q.eq("actorId", actorId))
        .collect();
      expect(responses).toHaveLength(1);
      expect(responses[0].response.kind).toBe("defect");

      const pending = await ctx.db
        .query("pendingMessages")
        .withIndex("by_actor_deliverable", (q) => q.eq("actorId", actorId))
        .collect();
      expect(pending).toHaveLength(0);
    });
  });

  test("cross-actor effects schedule deferred kicks, skip self", async () => {
    const t = convexTest(schema, modules);
    const executeFn = await t.run(getTestExecuteFn);

    const { actorId, generation } = await t.run(async (ctx) => {
      const fn = executeFn as ExecuteFnHandle;
      const { actor } = await getOrCreateActorRow(ctx, {
        actorType: "senderActor",
        name: "s1",
        executeFn: fn,
      });
      // Pre-create the target actor so we can check its state after
      await getOrCreateActorRow(ctx, {
        actorType: "counter",
        name: "target",
        executeFn: fn,
      });
      await enqueueMessageHandler(
        ctx,
        [{
          actorType: "senderActor",
          name: "s1",
          msgType: "sendToCounter",
          payload: { counterName: "target", by: 42 },
          deliverAt: T0,
        }],
        fn,
      );
      await kickMailbox(ctx, { actorId: actor._id, deliverAt: T0, executeFn: fn });
      const signal = (await getSignalRow(ctx, actor._id))!;
      return { actorId: actor._id, generation: signal.generation };
    });

    await t.mutation(internal.drain.drainLoop, {
      actorId,
      generation,
      executeFn,
      cursorTs: T0,
    });

    // senderActor's state updated
    await t.run(async (ctx) => {
      const stateRow = await getActorStateRow(ctx, actorId);
      expect(stateRow!.state).toEqual({ sent: 1 });

      // Target actor should have a pending message from the effect
      const targetActor = (await ctx.db
        .query("actor")
        .withIndex("by_type_name", (q) =>
          q.eq("actorType", "counter").eq("name", "target"),
        )
        .unique())!;
      const targetPending = await ctx.db
        .query("pendingMessages")
        .withIndex("by_actor_deliverable", (q) =>
          q.eq("actorId", targetActor._id),
        )
        .collect();
      expect(targetPending).toHaveLength(1);
    });
  });
});

// ── updateDrainStatus ────────────────────────────────────────────

describe("updateDrainStatus", () => {
  test("no pending messages → idle", async () => {
    const t = convexTest(schema, modules);
    const executeFn = await t.run(getTestExecuteFn);

    const { actorId, generation } = await t.run(async (ctx) => {
      const fn = executeFn as ExecuteFnHandle;
      const { actor } = await getOrCreateActorRow(ctx, {
        actorType: "counter",
        name: "a",
        executeFn: fn,
      });
      const signal = (await getSignalRow(ctx, actor._id))!;
      const bk = (await getBookkeepingRow(ctx, actor._id))!;
      // Simulate running state
      await ctx.db.patch(signal._id, { drainKind: "running", generation: 5 });
      await ctx.db.patch(bk._id, { drainStartedAt: T0 });
      return { actorId: actor._id, generation: 5 };
    });

    await t.mutation(internal.drain.updateDrainStatus, {
      actorId,
      generation,
      executeFn,
    });

    await t.run(async (ctx) => {
      const signal = (await getSignalRow(ctx, actorId))!;
      expect(signal.drainKind).toBe("idle");
      const bk = (await getBookkeepingRow(ctx, actorId))!;
      expect(bk.drainScheduledId).toBeUndefined();
      expect(bk.drainAt).toBeUndefined();
      expect(bk.drainStartedAt).toBeUndefined();
    });
  });

  test("deliverable message → running, schedules drainLoop immediately", async () => {
    const t = convexTest(schema, modules);
    const executeFn = await t.run(getTestExecuteFn);

    const { actorId, generation } = await t.run(async (ctx) => {
      const fn = executeFn as ExecuteFnHandle;
      const { actor } = await getOrCreateActorRow(ctx, {
        actorType: "counter",
        name: "a",
        executeFn: fn,
      });
      await enqueueMessageHandler(
        ctx,
        [{ actorType: "counter", name: "a", msgType: "inc", payload: { by: 1 }, deliverAt: T0 }],
        fn,
      );
      const signal = (await getSignalRow(ctx, actor._id))!;
      const bk = (await getBookkeepingRow(ctx, actor._id))!;
      await ctx.db.patch(signal._id, { drainKind: "running", generation: 3 });
      await ctx.db.patch(bk._id, { drainStartedAt: T0 });
      return { actorId: actor._id, generation: 3 };
    });

    await t.mutation(internal.drain.updateDrainStatus, {
      actorId,
      generation,
      executeFn,
    });

    await t.run(async (ctx) => {
      const signal = (await getSignalRow(ctx, actorId))!;
      expect(signal.drainKind).toBe("running");
      const bk = (await getBookkeepingRow(ctx, actorId))!;
      expect(bk.drainStartedAt).toBe(T0);
    });
  });

  test("future message → scheduled at deliverAt", async () => {
    const t = convexTest(schema, modules);
    const executeFn = await t.run(getTestExecuteFn);
    const futureAt = T0 + 10_000;

    const { actorId, generation } = await t.run(async (ctx) => {
      const fn = executeFn as ExecuteFnHandle;
      const { actor } = await getOrCreateActorRow(ctx, {
        actorType: "counter",
        name: "a",
        executeFn: fn,
      });
      await enqueueMessageHandler(
        ctx,
        [{ actorType: "counter", name: "a", msgType: "inc", payload: { by: 1 }, deliverAt: futureAt }],
        fn,
      );
      const signal = (await getSignalRow(ctx, actor._id))!;
      const bk = (await getBookkeepingRow(ctx, actor._id))!;
      await ctx.db.patch(signal._id, { drainKind: "running", generation: 2 });
      await ctx.db.patch(bk._id, { drainStartedAt: T0 });
      return { actorId: actor._id, generation: 2 };
    });

    await t.mutation(internal.drain.updateDrainStatus, {
      actorId,
      generation,
      executeFn,
    });

    await t.run(async (ctx) => {
      const signal = (await getSignalRow(ctx, actorId))!;
      expect(signal.drainKind).toBe("scheduled");
      const bk = (await getBookkeepingRow(ctx, actorId))!;
      expect(bk.drainAt).toBe(futureAt);
      expect(bk.drainScheduledId).toBeDefined();
      expect(bk.drainStartedAt).toBeUndefined();

      const scheduled = await ctx.db.system.get(bk.drainScheduledId!);
      assert(scheduled && "state" in scheduled);
      expect(scheduled.state.kind).toBe("pending");
      expect(scheduled.scheduledTime).toBe(futureAt);
    });
  });

  test("stale generation throws", async () => {
    const t = convexTest(schema, modules);
    const executeFn = await t.run(getTestExecuteFn);

    const actorId = await t.run(async (ctx) => {
      const fn = executeFn as ExecuteFnHandle;
      const { actor } = await getOrCreateActorRow(ctx, {
        actorType: "counter",
        name: "a",
        executeFn: fn,
      });
      return actor._id;
    });

    await expect(
      t.mutation(internal.drain.updateDrainStatus, {
        actorId,
        generation: 999,
        executeFn,
      }),
    ).rejects.toThrow(/stale drain/);
  });
});

// ── kickActor (schedulable wrapper) ──────────────────────────────

describe("kickActor", () => {
  test("kicks an idle actor to scheduled", async () => {
    const t = convexTest(schema, modules);
    const executeFn = await t.run(getTestExecuteFn);

    const actorId = await t.run(async (ctx) => {
      const fn = executeFn as ExecuteFnHandle;
      const { actor } = await getOrCreateActorRow(ctx, {
        actorType: "counter",
        name: "a",
        executeFn: fn,
      });
      return actor._id;
    });

    await t.mutation(internal.kick.kickActor, {
      actorId,
      deliverAt: T0 + 1000,
      executeFn,
    });

    await t.run(async (ctx) => {
      const signal = (await getSignalRow(ctx, actorId))!;
      expect(signal.drainKind).toBe("scheduled");
      const bk = (await getBookkeepingRow(ctx, actorId))!;
      expect(bk.drainAt).toBe(T0 + 1000);
    });
  });
});
