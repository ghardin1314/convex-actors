/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { createFunctionHandle } from "convex/server";
import { describe, expect, test } from "vitest";
import {
  getActorRow,
  getSignalRow,
  getBookkeepingRow,
  getOrCreateActorRow,
} from "./actors.js";
import { api } from "./_generated/api.js";
import schema from "./schema.js";

const modules = import.meta.glob("./**/*.ts");

async function makeExecuteHandle() {
  return (await createFunctionHandle(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (api as any).kick.kickMailbox,
  )) as unknown as import("./kick.js").ExecuteFnHandle;
}

describe("getActorRow", () => {
  test("returns null for unknown (type, name)", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      expect(await getActorRow(ctx, "counter", "missing")).toBeNull();
    });
  });
});

describe("getOrCreateActorRow", () => {
  test("lazy-creates actor + paired signal and bookkeeping on first call", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      const executeFn = await makeExecuteHandle();
      const { actor } = await getOrCreateActorRow(ctx, {
        actorType: "counter",
        name: "a",
        executeFn,
      });

      expect(actor.actorType).toBe("counter");
      expect(actor.name).toBe("a");

      const signal = await getSignalRow(ctx, actor._id);
      expect(signal).not.toBeNull();
      expect(signal!.actorId).toBe(actor._id);
      expect(signal!.generation).toBe(0);
      expect(signal!.drainKind).toBe("idle");

      const bk = await getBookkeepingRow(ctx, actor._id);
      expect(bk).not.toBeNull();
      expect(bk!.actorId).toBe(actor._id);
      expect(bk!.executeFn).toBe(executeFn);

      const actorRows = await ctx.db.query("actor").collect();
      const signalRows = await ctx.db.query("drainSignal").collect();
      const bkRows = await ctx.db.query("drainBookkeeping").collect();
      expect(actorRows).toHaveLength(1);
      expect(signalRows).toHaveLength(1);
      expect(bkRows).toHaveLength(1);
    });
  });

  test("is idempotent: second call returns existing rows", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      const executeFn = await makeExecuteHandle();
      const first = await getOrCreateActorRow(ctx, {
        actorType: "counter",
        name: "a",
        executeFn,
      });
      await ctx.db.insert("actorState", { actorId: first.actor._id, state: { n: 42 } });

      const second = await getOrCreateActorRow(ctx, {
        actorType: "counter",
        name: "a",
        executeFn,
      });

      expect(second.actor._id).toBe(first.actor._id);

      expect(await ctx.db.query("actor").collect()).toHaveLength(1);
      expect(await ctx.db.query("drainSignal").collect()).toHaveLength(1);
      expect(await ctx.db.query("drainBookkeeping").collect()).toHaveLength(1);
    });
  });

  test("distinct (type, name) tuples get distinct actors", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      const executeFn = await makeExecuteHandle();
      const a = await getOrCreateActorRow(ctx, {
        actorType: "counter",
        name: "a",
        executeFn,
      });
      const b = await getOrCreateActorRow(ctx, {
        actorType: "counter",
        name: "b",
        executeFn,
      });
      const c = await getOrCreateActorRow(ctx, {
        actorType: "ping",
        name: "a",
        executeFn,
      });

      const ids = new Set([a.actor._id, b.actor._id, c.actor._id]);
      expect(ids.size).toBe(3);

      const signalA = await getSignalRow(ctx, a.actor._id);
      const signalB = await getSignalRow(ctx, b.actor._id);
      const signalC = await getSignalRow(ctx, c.actor._id);
      const signalIds = new Set([signalA!._id, signalB!._id, signalC!._id]);
      expect(signalIds.size).toBe(3);

      expect((await getActorRow(ctx, "counter", "a"))?._id).toBe(a.actor._id);
      expect((await getActorRow(ctx, "counter", "b"))?._id).toBe(b.actor._id);
      expect((await getActorRow(ctx, "ping", "a"))?._id).toBe(c.actor._id);
    });
  });
});

describe("getSignalRow / getBookkeepingRow", () => {
  test("finds the paired rows for an actor", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      const executeFn = await makeExecuteHandle();
      const { actor } = await getOrCreateActorRow(ctx, {
        actorType: "counter",
        name: "a",
        executeFn,
      });
      const foundSignal = await getSignalRow(ctx, actor._id);
      expect(foundSignal).not.toBeNull();
      expect(foundSignal!.actorId).toBe(actor._id);
      const foundBk = await getBookkeepingRow(ctx, actor._id);
      expect(foundBk).not.toBeNull();
      expect(foundBk!.actorId).toBe(actor._id);
    });
  });
});
