import { z } from "zod";
import { describe, expect, test } from "vitest";

import { createProcessCtx, FailSentinel } from "./ctx.js";
import { createLogger } from "../logging.js";
import type { Effect } from "../shared.js";
import { defineActor, reply } from "./defineActor.js";

const T0 = 1_700_000_000_000;

const counter = defineActor({
  type: "counter",
  state: z.object({ n: z.number() }),
  messages: {
    inc: { payload: z.object({ by: z.number() }) },
    reset: { payload: z.object({}) },
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
  state: z.object({ items: z.array(z.string()) }),
  messages: { notify: { payload: z.object({ text: z.string() }) } },
  initialState: () => ({ items: [] }),
  handle: {
    notify: async (state, { text }) => {
      state.items.push(text);
    },
  },
});

const wallet = defineActor({
  type: "wallet",
  state: z.object({ balance: z.number() }),
  messages: {
    deposit: {
      payload: z.object({ amount: z.number() }),
      response: z.object({ newBalance: z.number() }),
    },
    withdraw: {
      payload: z.object({ amount: z.number() }),
      response: z.object({ newBalance: z.number() }),
    },
  },
  initialState: () => ({ balance: 0 }),
  handle: {
    deposit: async (state, { amount }) => {
      state.balance += amount;
      return { newBalance: state.balance };
    },
    withdraw: async (state, { amount }, ctx) => {
      if (amount > state.balance) ctx.fail("insufficient_funds");
      state.balance -= amount;
      return { newBalance: state.balance };
    },
  },
});

const saga = defineActor({
  type: "saga",
  state: z.object({ phase: z.string() }),
  messages: {
    start: { payload: z.object({ target: z.string(), amount: z.number() }) },
    withdrawResult: {
      payload: reply(wallet, "withdraw", {
        context: z.object({ target: z.string() }),
      }),
    },
  },
  initialState: () => ({ phase: "init" }),
  handle: {
    start: async (state, { target, amount }, ctx) => {
      state.phase = "withdrawing";
      ctx.stub(wallet, target).ask(
        "withdraw",
        { amount },
        {
          handler: "withdrawResult",
          context: { target },
        },
      );
    },
    withdrawResult: async (state, { result }) => {
      state.phase = result.kind === "success" ? "done" : "failed";
    },
  },
});

function makeCtx(
  overrides?: Partial<Parameters<typeof createProcessCtx>[0]>,
) {
  return createProcessCtx({
    selfDefinition: counter,
    selfName: "a",
    now: T0,
    logger: createLogger(),
    peekFn: async () => null,
    ...overrides,
  });
}

describe("InternalProcessCtx", () => {
  test("self carries the current process address", () => {
    const { ctx } = makeCtx();
    expect(ctx.self.type).toBe("counter");
    expect(ctx.self.name).toBe("a");
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
    } satisfies Effect);
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

  test("stub.send throws on unknown msgType", () => {
    const { ctx } = makeCtx();
    expect(() =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (ctx.stub(inbox, "a") as any).send("bogus", {}),
    ).toThrow(/unknown msgType "bogus"/);
  });

  test("stub.send throws on invalid payload", () => {
    const { ctx } = makeCtx();
    expect(() =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ctx.stub(inbox, "a").send("notify", { text: 42 } as any),
    ).toThrow(/invalid payload/);
  });

  test("stub.peek calls the injected peekFn", async () => {
    const { ctx } = makeCtx({
      peekFn: async (type: string, name: string) => ({
        type,
        name,
        peeked: true,
      }),
    });
    const result = await ctx.stub(inbox, "user1").peek();
    expect(result).toEqual({ type: "inbox", name: "user1", peeked: true });
  });

  test("self.send pushes an effect targeting self", () => {
    const { ctx, internals } = makeCtx();
    ctx.self.send("inc", { by: 3 });
    expect(internals.effects).toHaveLength(1);
    expect(internals.effects[0]).toEqual({
      actorType: "counter",
      name: "a",
      msgType: "inc",
      payload: { by: 3 },
      deliverAt: T0,
    });
  });

  test("self.send throws on unknown msgType", () => {
    const { ctx } = makeCtx();
    expect(() => ctx.self.send("bogus", {})).toThrow(
      /unknown msgType "bogus"/,
    );
  });

  test("self.send throws on invalid payload", () => {
    const { ctx } = makeCtx();
    expect(() => ctx.self.send("inc", { by: "not a number" })).toThrow(
      /invalid payload/,
    );
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

  test("effects list starts empty and is shared across stubs + self", () => {
    const { ctx, internals } = makeCtx();
    expect(internals.effects).toHaveLength(0);
    ctx.stub(inbox, "a").send("notify", { text: "1" });
    ctx.self.send("inc", { by: 1 });
    expect(internals.effects).toHaveLength(2);
  });
});

describe("pushAsk / ActorStub.ask", () => {
  function makeSagaCtx(
    overrides?: Partial<Parameters<typeof createProcessCtx>[0]>,
  ) {
    return createProcessCtx({
      selfDefinition: saga,
      selfName: "saga-1",
      now: T0,
      logger: createLogger(),
      peekFn: async () => null,
      ...overrides,
    });
  }

  test("pushAsk emits an effect with replyTo metadata", () => {
    const { ctx, internals } = makeSagaCtx();
    ctx.pushAsk(
      wallet,
      "alice",
      "withdraw",
      { amount: 50 },
      "withdrawResult",
      { target: "alice" },
    );
    expect(internals.effects).toHaveLength(1);
    const effect = internals.effects[0];
    expect(effect.actorType).toBe("wallet");
    expect(effect.name).toBe("alice");
    expect(effect.msgType).toBe("withdraw");
    expect(effect.payload).toEqual({ amount: 50 });
    expect(effect.deliverAt).toBe(T0);
    expect(effect.replyTo).toEqual({
      actorType: "saga",
      name: "saga-1",
      handler: "withdrawResult",
      context: { target: "alice" },
    });
  });

  test("pushAsk with null context preserves the null", () => {
    const simpleSaga = defineActor({
      type: "simpleSaga",
      state: z.object({ phase: z.string() }),
      messages: {
        go: { payload: z.object({}) },
        depositResult: { payload: reply(wallet, "deposit") },
      },
      initialState: () => ({ phase: "init" }),
      handle: {
        go: async () => {},
        depositResult: async () => {},
      },
    });
    const { ctx, internals } = createProcessCtx({
      selfDefinition: simpleSaga,
      selfName: "s1",
      now: T0,
      logger: createLogger(),
      peekFn: async () => null,
    });
    ctx.pushAsk(
      wallet,
      "bob",
      "deposit",
      { amount: 10 },
      "depositResult",
      null,
    );
    expect(internals.effects[0].replyTo?.context).toBeNull();
  });

  test("pushAsk validates target message payload", () => {
    const { ctx } = makeSagaCtx();
    expect(() =>
      ctx.pushAsk(
        wallet,
        "alice",
        "withdraw",
        { amount: "bad" },
        "withdrawResult",
        { target: "alice" },
      ),
    ).toThrow(/invalid payload/);
  });

  test("pushAsk throws on unknown target msgType", () => {
    const { ctx } = makeSagaCtx();
    expect(() =>
      ctx.pushAsk(
        wallet,
        "alice",
        "bogus",
        {},
        "withdrawResult",
        { target: "alice" },
      ),
    ).toThrow(/unknown msgType "bogus"/);
  });

  test("pushAsk throws on unknown reply handler", () => {
    const { ctx } = makeSagaCtx();
    expect(() =>
      ctx.pushAsk(
        wallet,
        "alice",
        "withdraw",
        { amount: 10 },
        "nonexistent",
        { target: "alice" },
      ),
    ).toThrow(/unknown reply handler "nonexistent"/);
  });

  test("ActorStub.ask wraps pushAsk behind the typed surface", () => {
    // Calling through the user-facing actor stub should produce the
    // same effect shape that pushAsk does directly.
    const { ctx, internals } = makeSagaCtx();
    // Run the wrapped saga.start handler — it calls
    // ctx.stub(wallet, 'alice').ask('withdraw', ...) inside.
    saga.handle.start(
      { phase: "init" },
      { target: "alice", amount: 50 },
      ctx,
    );
    expect(internals.effects).toHaveLength(1);
    const effect = internals.effects[0];
    expect(effect.actorType).toBe("wallet");
    expect(effect.msgType).toBe("withdraw");
    expect(effect.replyTo?.handler).toBe("withdrawResult");
    expect(effect.replyTo?.context).toEqual({ target: "alice" });
  });
});
