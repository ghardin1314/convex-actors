/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { createFunctionHandle } from "convex/server";
import { describe, expect, test } from "vitest";
import {
  getActorRow,
  getMailboxRow,
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
  test("lazy-creates actor + paired mailbox on first call", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      const executeFn = await makeExecuteHandle();
      const { actor, mailbox } = await getOrCreateActorRow(ctx, {
        actorType: "counter",
        name: "a",
        executeFn,
      });

      expect(actor.actorType).toBe("counter");
      expect(actor.name).toBe("a");
      // State is populated by the drain loop on first handler
      // invocation, not by the component.
      expect(actor.state).toBeUndefined();

      expect(mailbox.actorId).toBe(actor._id);
      expect(mailbox.generation).toBe(0);
      expect(mailbox.drainKind).toBe("idle");

      // Exactly one row of each.
      const actorRows = await ctx.db.query("actor").collect();
      const mailboxRows = await ctx.db.query("mailboxState").collect();
      expect(actorRows).toHaveLength(1);
      expect(mailboxRows).toHaveLength(1);
    });
  });

  test("is idempotent: second call returns existing rows without touching state", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      const executeFn = await makeExecuteHandle();
      const first = await getOrCreateActorRow(ctx, {
        actorType: "counter",
        name: "a",
        executeFn,
      });
      // Simulate the drain loop populating state after first creation.
      await ctx.db.patch(first.actor._id, { state: { n: 42 } });

      const second = await getOrCreateActorRow(ctx, {
        actorType: "counter",
        name: "a",
        executeFn,
      });

      expect(second.actor._id).toBe(first.actor._id);
      expect(second.mailbox._id).toBe(first.mailbox._id);
      expect(second.actor.state).toEqual({ n: 42 });

      // Still exactly one pair.
      expect(await ctx.db.query("actor").collect()).toHaveLength(1);
      expect(await ctx.db.query("mailboxState").collect()).toHaveLength(1);
    });
  });

  test("distinct (type, name) tuples get distinct actors and mailboxes", async () => {
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

      const mailboxIds = new Set([
        a.mailbox._id,
        b.mailbox._id,
        c.mailbox._id,
      ]);
      expect(mailboxIds.size).toBe(3);

      // getActorRow can find each back by address.
      expect((await getActorRow(ctx, "counter", "a"))?._id).toBe(a.actor._id);
      expect((await getActorRow(ctx, "counter", "b"))?._id).toBe(b.actor._id);
      expect((await getActorRow(ctx, "ping", "a"))?._id).toBe(c.actor._id);
    });
  });
});

describe("getMailboxRow", () => {
  test("finds the paired mailbox for an actor", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      const executeFn = await makeExecuteHandle();
      const { actor, mailbox } = await getOrCreateActorRow(ctx, {
        actorType: "counter",
        name: "a",
        executeFn,
      });
      const found = await getMailboxRow(ctx, actor._id);
      expect(found?._id).toBe(mailbox._id);
    });
  });
});

