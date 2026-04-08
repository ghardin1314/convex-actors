/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import {
  getActorRow,
  getMailboxRow,
  getOrCreateActorRow,
} from "./actors.js";
import schema from "./schema.js";

const modules = import.meta.glob("./**/*.ts");

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
      const { actor, mailbox } = await getOrCreateActorRow(ctx, {
        actorType: "counter",
        name: "a",
        initialState: () => ({ n: 0 }),
      });

      expect(actor.actorType).toBe("counter");
      expect(actor.name).toBe("a");
      expect(actor.state).toEqual({ n: 0 });

      expect(mailbox.actorId).toBe(actor._id);
      expect(mailbox.generation).toBe(0);
      expect(mailbox.drain).toEqual({ kind: "idle" });

      // Exactly one row of each.
      const actorRows = await ctx.db.query("actor").collect();
      const mailboxRows = await ctx.db.query("mailboxState").collect();
      expect(actorRows).toHaveLength(1);
      expect(mailboxRows).toHaveLength(1);
    });
  });

  test("is idempotent: second call returns existing rows and does not re-init state", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      let initCalls = 0;
      const init = () => {
        initCalls++;
        return { n: initCalls };
      };

      const first = await getOrCreateActorRow(ctx, {
        actorType: "counter",
        name: "a",
        initialState: init,
      });
      // Mutate state between calls to prove the second call does not
      // overwrite it with a fresh initial state.
      await ctx.db.patch(first.actor._id, { state: { n: 42 } });

      const second = await getOrCreateActorRow(ctx, {
        actorType: "counter",
        name: "a",
        initialState: init,
      });

      expect(second.actor._id).toBe(first.actor._id);
      expect(second.mailbox._id).toBe(first.mailbox._id);
      expect(second.actor.state).toEqual({ n: 42 });
      expect(initCalls).toBe(1);

      // Still exactly one pair.
      expect(await ctx.db.query("actor").collect()).toHaveLength(1);
      expect(await ctx.db.query("mailboxState").collect()).toHaveLength(1);
    });
  });

  test("distinct (type, name) tuples get distinct actors and mailboxes", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      const a = await getOrCreateActorRow(ctx, {
        actorType: "counter",
        name: "a",
        initialState: () => ({ n: 0 }),
      });
      const b = await getOrCreateActorRow(ctx, {
        actorType: "counter",
        name: "b",
        initialState: () => ({ n: 0 }),
      });
      const c = await getOrCreateActorRow(ctx, {
        actorType: "ping",
        name: "a",
        initialState: () => ({ hits: 0 }),
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
      const { actor, mailbox } = await getOrCreateActorRow(ctx, {
        actorType: "counter",
        name: "a",
        initialState: () => ({ n: 0 }),
      });
      const found = await getMailboxRow(ctx, actor._id);
      expect(found?._id).toBe(mailbox._id);
    });
  });
});
