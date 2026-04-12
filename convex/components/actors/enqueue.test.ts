/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { createFunctionHandle } from "convex/server";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api.js";
import { enqueueMessageHandler } from "./enqueue.js";
import { getActorRow, getSignalRow } from "./actors.js";
import schema from "./schema.js";

async function makeExecuteHandle() {
  return (await createFunctionHandle(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (api as any).kick.kickMailbox,
  )) as unknown as import("./kick.js").ExecuteFnHandle;
}

const modules = import.meta.glob("./**/*.ts");

const T0 = 1_700_000_000_000;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
});

describe("enqueueMessageHandler", () => {
  test("first effect to new (type, name) creates actor + signal + bookkeeping + message + pending rows", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      const executeFn = await makeExecuteHandle();
      const { messageIds, kickTargets } = await enqueueMessageHandler(ctx, [
        {
          actorType: "counter",
          name: "a",
          msgType: "inc",
          payload: { by: 1 },
          deliverAt: T0,
        },
      ], executeFn);

      expect(messageIds).toHaveLength(1);

      const actor = await getActorRow(ctx, "counter", "a");
      expect(actor).not.toBeNull();
      const signal = await getSignalRow(ctx, actor!._id);
      expect(signal?.drainKind).toBe("idle");

      expect(kickTargets.size).toBe(1);
      expect(kickTargets.get(actor!._id)).toEqual({ deliverAt: T0 });

      const messages = await ctx.db.query("messages").collect();
      expect(messages).toHaveLength(1);
      expect(messages[0]).toMatchObject({
        _id: messageIds[0],
        actorId: actor!._id,
        msgType: "inc",
        payload: { by: 1 },
        deliverAt: T0,
        sentAt: T0,
      });

      const pending = await ctx.db.query("pendingMessages").collect();
      expect(pending).toHaveLength(1);
      expect(pending[0]).toMatchObject({
        messageId: messageIds[0],
        actorId: actor!._id,
        deliverAt: T0,
        sendSeq: 0,
        attempts: 0,
      });
    });
  });

  test("second effect to same address reuses the actor row", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      const executeFn = await makeExecuteHandle();
      await enqueueMessageHandler(ctx, [
        {
          actorType: "counter",
          name: "a",
          msgType: "inc",
          payload: null,
          deliverAt: T0,
        },
      ], executeFn);
      await enqueueMessageHandler(ctx, [
        {
          actorType: "counter",
          name: "a",
          msgType: "inc",
          payload: null,
          deliverAt: T0 + 1000,
        },
      ], executeFn);

      const actors = await ctx.db.query("actor").collect();
      expect(actors).toHaveLength(1);
      const signals = await ctx.db.query("drainSignal").collect();
      expect(signals).toHaveLength(1);
      const messages = await ctx.db.query("messages").collect();
      expect(messages).toHaveLength(2);
      const pending = await ctx.db.query("pendingMessages").collect();
      expect(pending).toHaveLength(2);
    });
  });

  test("batch of N effects writes N messages + N pending with sendSeq 0..N-1", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      const executeFn = await makeExecuteHandle();
      const { messageIds } = await enqueueMessageHandler(ctx, [
        {
          actorType: "counter",
          name: "a",
          msgType: "inc",
          payload: { by: 1 },
          deliverAt: T0,
        },
        {
          actorType: "counter",
          name: "a",
          msgType: "inc",
          payload: { by: 2 },
          deliverAt: T0,
        },
        {
          actorType: "counter",
          name: "a",
          msgType: "inc",
          payload: { by: 3 },
          deliverAt: T0,
        },
      ], executeFn);

      expect(messageIds).toHaveLength(3);
      const actor = (await getActorRow(ctx, "counter", "a"))!;

      const pending = await ctx.db
        .query("pendingMessages")
        .withIndex("by_actor_deliverable", (q) =>
          q.eq("actorId", actor._id),
        )
        .collect();

      expect(pending.map((p) => p.sendSeq)).toEqual([0, 1, 2]);
      expect(pending.map((p) => p.messageId)).toEqual(messageIds);
      for (const row of pending) {
        expect(row.attempts).toBe(0);
        expect(row.deliverAt).toBe(T0);
      }
    });
  });

  test("batch with multiple targets lazy-creates each distinct actor once", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      const executeFn = await makeExecuteHandle();
      await enqueueMessageHandler(ctx, [
        {
          actorType: "counter",
          name: "a",
          msgType: "inc",
          payload: null,
          deliverAt: T0,
        },
        {
          actorType: "counter",
          name: "b",
          msgType: "inc",
          payload: null,
          deliverAt: T0,
        },
        {
          actorType: "counter",
          name: "a",
          msgType: "inc",
          payload: null,
          deliverAt: T0,
        },
      ], executeFn);

      const actors = await ctx.db.query("actor").collect();
      expect(actors).toHaveLength(2);
      const signals = await ctx.db.query("drainSignal").collect();
      expect(signals).toHaveLength(2);

      const a = (await getActorRow(ctx, "counter", "a"))!;
      const b = (await getActorRow(ctx, "counter", "b"))!;
      const pendingA = await ctx.db
        .query("pendingMessages")
        .withIndex("by_actor_deliverable", (q) => q.eq("actorId", a._id))
        .collect();
      const pendingB = await ctx.db
        .query("pendingMessages")
        .withIndex("by_actor_deliverable", (q) => q.eq("actorId", b._id))
        .collect();
      expect(pendingA.map((p) => p.sendSeq)).toEqual([0, 2]);
      expect(pendingB.map((p) => p.sendSeq)).toEqual([1]);
    });
  });

  test("multi-target batch preserves per-target FIFO via sendSeq", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      const executeFn = await makeExecuteHandle();
      await enqueueMessageHandler(ctx, [
        {
          actorType: "counter",
          name: "a",
          msgType: "inc",
          payload: { marker: 0 },
          deliverAt: T0,
        },
        {
          actorType: "counter",
          name: "b",
          msgType: "inc",
          payload: { marker: 1 },
          deliverAt: T0,
        },
        {
          actorType: "counter",
          name: "a",
          msgType: "inc",
          payload: { marker: 2 },
          deliverAt: T0,
        },
        {
          actorType: "counter",
          name: "b",
          msgType: "inc",
          payload: { marker: 3 },
          deliverAt: T0,
        },
        {
          actorType: "counter",
          name: "a",
          msgType: "inc",
          payload: { marker: 4 },
          deliverAt: T0,
        },
      ], executeFn);

      const a = (await getActorRow(ctx, "counter", "a"))!;
      const b = (await getActorRow(ctx, "counter", "b"))!;

      const readMarkers = async (actorId: typeof a._id) => {
        const rows = await ctx.db
          .query("pendingMessages")
          .withIndex("by_actor_deliverable", (q) => q.eq("actorId", actorId))
          .collect();
        return Promise.all(
          rows.map(async (r) => {
            const msg = (await ctx.db.get(r.messageId))!;
            return (msg.payload as { marker: number }).marker;
          }),
        );
      };

      expect(await readMarkers(a._id)).toEqual([0, 2, 4]);
      expect(await readMarkers(b._id)).toEqual([1, 3]);
    });
  });

  test("by_actor_deliverable index returns rows in (deliverAt, sendSeq) order", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      const executeFn = await makeExecuteHandle();
      await enqueueMessageHandler(ctx, [
        {
          actorType: "counter",
          name: "a",
          msgType: "inc",
          payload: { i: 0 },
          deliverAt: T0 + 1000,
        },
        {
          actorType: "counter",
          name: "a",
          msgType: "inc",
          payload: { i: 1 },
          deliverAt: T0,
        },
        {
          actorType: "counter",
          name: "a",
          msgType: "inc",
          payload: { i: 2 },
          deliverAt: T0,
        },
        {
          actorType: "counter",
          name: "a",
          msgType: "inc",
          payload: { i: 3 },
          deliverAt: T0 + 500,
        },
      ], executeFn);

      const actor = (await getActorRow(ctx, "counter", "a"))!;
      const pending = await ctx.db
        .query("pendingMessages")
        .withIndex("by_actor_deliverable", (q) => q.eq("actorId", actor._id))
        .collect();

      const order: Array<number> = [];
      for (const row of pending) {
        const msg = (await ctx.db.get(row.messageId))!;
        order.push((msg.payload as { i: number }).i);
      }
      expect(order).toEqual([1, 2, 3, 0]);
    });
  });

  test("batch returns earliest deliverAt per target in kickTargets", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      const executeFn = await makeExecuteHandle();
      const { kickTargets } = await enqueueMessageHandler(ctx, [
        {
          actorType: "counter",
          name: "a",
          msgType: "inc",
          payload: null,
          deliverAt: T0 + 2000,
        },
        {
          actorType: "counter",
          name: "a",
          msgType: "inc",
          payload: null,
          deliverAt: T0 + 500,
        },
        {
          actorType: "counter",
          name: "a",
          msgType: "inc",
          payload: null,
          deliverAt: T0 + 1500,
        },
      ], executeFn);

      const actor = (await getActorRow(ctx, "counter", "a"))!;
      expect(kickTargets.size).toBe(1);
      expect(kickTargets.get(actor._id)).toEqual({ deliverAt: T0 + 500 });
    });
  });

  test("second send to same target still returns that target in kickTargets", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      const executeFn = await makeExecuteHandle();
      await enqueueMessageHandler(ctx, [
        {
          actorType: "counter",
          name: "a",
          msgType: "inc",
          payload: null,
          deliverAt: T0 + 1000,
        },
      ], executeFn);

      const actor = (await getActorRow(ctx, "counter", "a"))!;

      const { kickTargets } = await enqueueMessageHandler(ctx, [
        {
          actorType: "counter",
          name: "a",
          msgType: "inc",
          payload: null,
          deliverAt: T0 + 10_000,
        },
      ], executeFn);

      expect(kickTargets.size).toBe(1);
      expect(kickTargets.get(actor._id)).toEqual({ deliverAt: T0 + 10_000 });
    });
  });

  test("multi-target batch returns every distinct target with earliest deliverAt", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      const executeFn = await makeExecuteHandle();
      const { kickTargets } = await enqueueMessageHandler(ctx, [
        {
          actorType: "counter",
          name: "a",
          msgType: "inc",
          payload: null,
          deliverAt: T0 + 1000,
        },
        {
          actorType: "counter",
          name: "b",
          msgType: "inc",
          payload: null,
          deliverAt: T0 + 2000,
        },
        {
          actorType: "counter",
          name: "a",
          msgType: "inc",
          payload: null,
          deliverAt: T0 + 500,
        },
      ], executeFn);

      const a = (await getActorRow(ctx, "counter", "a"))!;
      const b = (await getActorRow(ctx, "counter", "b"))!;

      expect(kickTargets.size).toBe(2);
      expect(kickTargets.get(a._id)).toEqual({ deliverAt: T0 + 500 });
      expect(kickTargets.get(b._id)).toEqual({ deliverAt: T0 + 2000 });
    });
  });
});
