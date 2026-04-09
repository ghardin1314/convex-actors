/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { enqueueMessageHandler } from "./enqueue.js";
import { getActorRow, getMailboxRow } from "./actors.js";
import schema from "./schema.js";

const modules = import.meta.glob("./**/*.ts");

// Fixed wall clock so `deliverAt`/`sentAt` comparisons are stable and
// `now()` in the handler returns a known value.
const T0 = 1_700_000_000_000;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
});

describe("enqueueMessageHandler", () => {
  test("first effect to new (type, name) creates actor + mailbox + message + pending rows", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      const ids = await enqueueMessageHandler(ctx, [
        {
          actorType: "counter",
          name: "a",
          msgType: "inc",
          payload: { by: 1 },
          deliverAt: T0,
        },
      ]);

      expect(ids).toHaveLength(1);

      const actor = await getActorRow(ctx, "counter", "a");
      expect(actor).not.toBeNull();
      const mailbox = await getMailboxRow(ctx, actor!._id);
      expect(mailbox?.drain).toEqual({ kind: "idle" });

      const messages = await ctx.db.query("messages").collect();
      expect(messages).toHaveLength(1);
      expect(messages[0]).toMatchObject({
        _id: ids[0],
        actorId: actor!._id,
        msgType: "inc",
        payload: { by: 1 },
        deliverAt: T0,
        sentAt: T0,
      });

      const pending = await ctx.db.query("pendingMessages").collect();
      expect(pending).toHaveLength(1);
      expect(pending[0]).toMatchObject({
        messageId: ids[0],
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
      await enqueueMessageHandler(ctx, [
        {
          actorType: "counter",
          name: "a",
          msgType: "inc",
          payload: null,
          deliverAt: T0,
        },
      ]);
      await enqueueMessageHandler(ctx, [
        {
          actorType: "counter",
          name: "a",
          msgType: "inc",
          payload: null,
          deliverAt: T0 + 1000,
        },
      ]);

      const actors = await ctx.db.query("actor").collect();
      expect(actors).toHaveLength(1);
      const mailboxes = await ctx.db.query("mailboxState").collect();
      expect(mailboxes).toHaveLength(1);
      const messages = await ctx.db.query("messages").collect();
      expect(messages).toHaveLength(2);
      const pending = await ctx.db.query("pendingMessages").collect();
      expect(pending).toHaveLength(2);
    });
  });

  test("batch of N effects writes N messages + N pending with sendSeq 0..N-1", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      const ids = await enqueueMessageHandler(ctx, [
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
      ]);

      expect(ids).toHaveLength(3);
      const actor = (await getActorRow(ctx, "counter", "a"))!;

      const pending = await ctx.db
        .query("pendingMessages")
        .withIndex("by_actor_deliverable", (q) =>
          q.eq("actorId", actor._id),
        )
        .collect();

      expect(pending.map((p) => p.sendSeq)).toEqual([0, 1, 2]);
      expect(pending.map((p) => p.messageId)).toEqual(ids);
      for (const row of pending) {
        expect(row.attempts).toBe(0);
        expect(row.deliverAt).toBe(T0);
      }
    });
  });

  test("batch with multiple targets lazy-creates each distinct actor once", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
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
      ]);

      const actors = await ctx.db.query("actor").collect();
      expect(actors).toHaveLength(2);
      const mailboxes = await ctx.db.query("mailboxState").collect();
      expect(mailboxes).toHaveLength(2);

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
      // Actor "a" gets effects 0 and 2 → sendSeq 0, 2 preserved.
      expect(pendingA.map((p) => p.sendSeq)).toEqual([0, 2]);
      expect(pendingB.map((p) => p.sendSeq)).toEqual([1]);
    });
  });

  test("multi-target batch preserves per-target FIFO via sendSeq", async () => {
    // A batch targeting [a, b, a, b, a] must deliver to actor "a" in
    // the order its effects appeared in the input (markers 0, 2, 4)
    // and to "b" in input order too (markers 1, 3). This is the only
    // cross-target ordering guarantee enqueue provides; cross-target
    // interleaving is not preserved.
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
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
      ]);

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
      // Out-of-order deliverAts within a single call. sendSeq breaks ties.
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
      ]);

      const actor = (await getActorRow(ctx, "counter", "a"))!;
      const pending = await ctx.db
        .query("pendingMessages")
        .withIndex("by_actor_deliverable", (q) => q.eq("actorId", actor._id))
        .collect();

      // Join back to messages so we can read the payload marker.
      const order: Array<number> = [];
      for (const row of pending) {
        const msg = (await ctx.db.get(row.messageId))!;
        order.push((msg.payload as { i: number }).i);
      }
      // (T0, sendSeq 1), (T0, sendSeq 2), (T0+500, sendSeq 3), (T0+1000, sendSeq 0)
      expect(order).toEqual([1, 2, 3, 0]);
    });
  });
});
