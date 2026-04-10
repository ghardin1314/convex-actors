import { v } from "convex/values";
import { describe, expect, test } from "vitest";

import {
  createActorCtx,
  FailSentinel,
  type EffectDescriptor,
} from "./ctx.js";
import { defineActor, type AnyActorDefinition } from "./defineActor.js";

const T0 = 1_700_000_000_000;

const counter = defineActor({
  type: "counter",
  state: v.object({ n: v.number() }),
  messages: {
    inc: v.object({ by: v.number() }),
    reset: v.object({}),
  },
  initialState: () => ({ n: 0 }),
  handle: {
    inc: async (state, { by }) => {
      state.n += by;
    },
    reset: async (state) => {
      state.n = 0;
    },
  },
});

const inbox = defineActor({
  type: "inbox",
  state: v.object({ items: v.array(v.string()) }),
  messages: { notify: v.object({ text: v.string() }) },
  initialState: () => ({ items: [] }),
  handle: {
    notify: async (state, { text }) => {
      state.items.push(text);
    },
  },
});

const defs: Record<string, AnyActorDefinition> = { counter, inbox };

function makeCtx(
  overrides?: Partial<Parameters<typeof createActorCtx>[0]>,
) {
  return createActorCtx({
    selfType: "counter",
    selfName: "a",
    now: T0,
    peekFn: async () => null,
    getDefinition: (t) => {
      const d = defs[t];
      if (!d) throw new Error(`unknown type ${t}`);
      return d;
    },
    ...overrides,
  });
}

describe("ActorCtx", () => {
  test("self() returns the current actor address", () => {
    const { ctx } = makeCtx();
    expect(ctx.self()).toEqual({ type: "counter", name: "a" });
  });

  test("now() returns the stable timestamp", () => {
    const { ctx } = makeCtx();
    expect(ctx.now()).toBe(T0);
    expect(ctx.now()).toBe(T0);
  });

  test("stub.send pushes an effect descriptor onto the list", () => {
    const { ctx, internals } = makeCtx();
    ctx.stub(inbox, "user1").send("notify", { text: "hello" });
    expect(internals.effects).toHaveLength(1);
    expect(internals.effects[0]).toEqual({
      actorType: "inbox",
      name: "user1",
      msgType: "notify",
      payload: { text: "hello" },
      deliverAt: T0,
    } satisfies EffectDescriptor);
  });

  test("multiple stub.send calls accumulate in order", () => {
    const { ctx, internals } = makeCtx();
    ctx.stub(inbox, "a").send("notify", { text: "1" });
    ctx.stub(inbox, "b").send("notify", { text: "2" });
    ctx.stub(counter, "c").send("inc", { by: 5 });
    expect(internals.effects).toHaveLength(3);
    expect(internals.effects.map((e) => e.name)).toEqual(["a", "b", "c"]);
  });

  test("stub.send with opts.at clamps past to now", () => {
    const { ctx, internals } = makeCtx();
    ctx.stub(inbox, "a").send("notify", { text: "x" }, { at: T0 - 999 });
    expect(internals.effects[0].deliverAt).toBe(T0);
  });

  test("stub.send with opts.after offsets from now", () => {
    const { ctx, internals } = makeCtx();
    ctx.stub(inbox, "a").send("notify", { text: "x" }, { after: 5000 });
    expect(internals.effects[0].deliverAt).toBe(T0 + 5000);
  });

  test("stub.send with opts.at wins over opts.after", () => {
    const { ctx, internals } = makeCtx();
    const future = T0 + 10_000;
    ctx.stub(inbox, "a").send("notify", { text: "x" }, {
      at: future,
      after: 500,
    });
    expect(internals.effects[0].deliverAt).toBe(future);
  });

  test("stub.send throws on unknown msgType", () => {
    const { ctx } = makeCtx();
    expect(() =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (ctx.stub(inbox, "a") as any).send("bogus", {}),
    ).toThrow(/unknown msgType "bogus"/);
  });

  test("stub.peek calls the injected peekFn", async () => {
    const { ctx } = makeCtx({
      peekFn: async (type, name) => ({ type, name, peeked: true }),
    });
    const result = await ctx.stub(inbox, "user1").peek();
    expect(result).toEqual({ type: "inbox", name: "user1", peeked: true });
  });

  test("sendSelf pushes an effect targeting self", () => {
    const { ctx, internals } = makeCtx();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (ctx as any).sendSelf("inc", { by: 3 });
    expect(internals.effects).toHaveLength(1);
    expect(internals.effects[0]).toEqual({
      actorType: "counter",
      name: "a",
      msgType: "inc",
      payload: { by: 3 },
      deliverAt: T0,
    });
  });

  test("sendSelf throws on unknown msgType", () => {
    const { ctx } = makeCtx();
    expect(() =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (ctx as any).sendSelf("bogus", {}),
    ).toThrow(/unknown msgType "bogus"/);
  });

  test("fail throws a FailSentinel with reason and details", () => {
    const { ctx } = makeCtx();
    let caught: FailSentinel | undefined;
    try {
      ctx.fail("insufficient_funds", { available: 42 });
    } catch (e) {
      if (e instanceof FailSentinel) caught = e;
    }
    expect(caught).toBeInstanceOf(FailSentinel);
    expect(caught!.reason).toBe("insufficient_funds");
    expect(caught!.details).toEqual({ available: 42 });
  });

  test("fail without details sets details to undefined", () => {
    const { ctx } = makeCtx();
    let caught: FailSentinel | undefined;
    try {
      ctx.fail("nope");
    } catch (e) {
      if (e instanceof FailSentinel) caught = e;
    }
    expect(caught).toBeInstanceOf(FailSentinel);
    expect(caught!.details).toBeUndefined();
  });

  test("effects list starts empty and is shared across stubs", () => {
    const { ctx, internals } = makeCtx();
    expect(internals.effects).toHaveLength(0);
    ctx.stub(inbox, "a").send("notify", { text: "1" });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (ctx as any).sendSelf("inc", { by: 1 });
    expect(internals.effects).toHaveLength(2);
  });
});
