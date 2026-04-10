import { z } from "zod";
import { describe, expect, expectTypeOf, test } from "vitest";

import {
  defineActor,
  reply,
  type PayloadOf,
  type ProjectionOf,
  type ReplyContextOf,
  type ReplyPayload,
  type ReturnOf,
  type StateOf,
  type ValidReplyHandlers,
} from "./defineActor";

describe("defineActor", () => {
  const chatRoom = defineActor({
    type: "chatRoom",
    state: z.object({
      members: z.array(z.string()),
      messages: z.array(z.object({ from: z.string(), text: z.string() })),
      lastActivity: z.number(),
    }),
    messages: {
      join: z.object({ user: z.string() }),
      leave: z.object({ user: z.string() }),
      post: z.object({ from: z.string(), text: z.string() }),
    },
    initialState: () => ({ members: [], messages: [], lastActivity: 0 }),
    project: (state) => ({
      memberCount: state.members.length,
      lastActivity: state.lastActivity,
    }),
    handle: {
      join: async (state, { user }, ctx) => {
        state.members.push(user);
        state.lastActivity = ctx.now();
      },
      leave: async (state, { user }) => {
        state.members = state.members.filter((m) => m !== user);
      },
      post: async (state, { from, text }, ctx) => {
        state.messages.push({ from, text });
        state.lastActivity = ctx.now();
      },
    },
  });

  test("is a pure identity function (no registration side effects)", () => {
    const spec = {
      type: "counter" as const,
      state: z.object({ n: z.number() }),
      messages: { inc: z.object({ by: z.number() }) },
      initialState: () => ({ n: 0 }),
      handle: {
        inc: async (state: { n: number }, { by }: { by: number }) => {
          state.n += by;
        },
      },
    };
    const def = defineActor(spec);
    expect(def).toBe(spec);
  });

  test("pins the literal `type` field", () => {
    expect(chatRoom.type).toBe("chatRoom");
    expectTypeOf(chatRoom.type).toEqualTypeOf<"chatRoom">();
  });

  test("exposes the state + payload schemas at runtime", () => {
    // payload schemas are reachable at runtime (used for validation + type inference)
    expect(Object.keys(chatRoom.messages).sort()).toEqual([
      "join",
      "leave",
      "post",
    ]);
    // sanity: the schema is a real Zod schema (has `parse` method)
    expect(typeof chatRoom.messages.join.parse).toBe("function");
    expect(typeof chatRoom.state.parse).toBe("function");
  });

  test("initialState matches the state schema shape", () => {
    const s0 = chatRoom.initialState();
    expect(s0).toEqual({ members: [], messages: [], lastActivity: 0 });
    expectTypeOf(s0).toEqualTypeOf<{
      members: string[];
      messages: { from: string; text: string }[];
      lastActivity: number;
    }>();
  });

  test("project inference drives ProjectionOf", () => {
    const view = chatRoom.project!(chatRoom.initialState());
    expect(view).toEqual({ memberCount: 0, lastActivity: 0 });
    expectTypeOf<ProjectionOf<typeof chatRoom>>().toEqualTypeOf<{
      memberCount: number;
      lastActivity: number;
    }>();
  });

  test("StateOf / PayloadOf infer from the schemas", () => {
    expectTypeOf<StateOf<typeof chatRoom>>().toEqualTypeOf<{
      members: string[];
      messages: { from: string; text: string }[];
      lastActivity: number;
    }>();
    expectTypeOf<PayloadOf<typeof chatRoom, "join">>().toEqualTypeOf<{
      user: string;
    }>();
    expectTypeOf<PayloadOf<typeof chatRoom, "post">>().toEqualTypeOf<{
      from: string;
      text: string;
    }>();
  });

  test("definitions without `project` type ProjectionOf as undefined", () => {
    const counter = defineActor({
      type: "counter",
      state: z.object({ n: z.number() }),
      messages: { inc: z.object({ by: z.number() }) },
      initialState: () => ({ n: 0 }),
      handle: {
        inc: async (state, { by }) => {
          state.n += by;
        },
      },
    });
    expect(counter.project).toBeUndefined();
    expectTypeOf<ProjectionOf<typeof counter>>().toEqualTypeOf<undefined>();
  });

  test("Zod schemas validate payloads at runtime", () => {
    expect(() => chatRoom.messages.join.parse({ user: "alice" })).not.toThrow();
    expect(() => chatRoom.messages.join.parse({ user: 42 })).toThrow();
    expect(() => chatRoom.messages.join.parse({})).toThrow();
  });
});

describe("returns + reply()", () => {
  const wallet = defineActor({
    type: "wallet",
    state: z.object({ balance: z.number() }),
    messages: {
      deposit: z.object({ amount: z.number() }),
      withdraw: z.object({ amount: z.number() }),
    },
    returns: {
      deposit: z.object({ newBalance: z.number() }),
      withdraw: z.object({ newBalance: z.number() }),
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

  test("ReturnOf infers return type from returns schemas", () => {
    expectTypeOf<ReturnOf<typeof wallet, "deposit">>().toEqualTypeOf<{
      newBalance: number;
    }>();
    expectTypeOf<ReturnOf<typeof wallet, "withdraw">>().toEqualTypeOf<{
      newBalance: number;
    }>();
  });

  test("reply() produces a valid Zod schema", () => {
    const schema = reply(wallet, "deposit", {
      context: z.object({ memo: z.string() }),
    });
    const valid = {
      result: { kind: "success" as const, value: { newBalance: 100 } },
      context: { memo: "test" },
      from: { type: "wallet", name: "alice" },
    };
    expect(() => schema.parse(valid)).not.toThrow();
  });

  test("reply() schema rejects invalid result kinds", () => {
    const schema = reply(wallet, "deposit");
    expect(() =>
      schema.parse({
        result: { kind: "bogus" },
        context: null,
        from: { type: "wallet", name: "alice" },
      }),
    ).toThrow();
  });

  test("reply() without context defaults to z.null()", () => {
    const schema = reply(wallet, "deposit");
    const valid = {
      result: { kind: "success" as const, value: { newBalance: 50 } },
      context: null,
      from: { type: "wallet", name: "alice" },
    };
    expect(() => schema.parse(valid)).not.toThrow();
  });

  test("ReplyContextOf extracts context type from reply schema", () => {
    const saga = defineActor({
      type: "saga",
      state: z.object({ phase: z.string() }),
      messages: {
        start: z.object({}),
        result: reply(wallet, "deposit", {
          context: z.object({ holdId: z.string() }),
        }),
      },
      initialState: () => ({ phase: "init" }),
      handle: {
        start: async () => {},
        result: async () => {},
      },
    });
    expectTypeOf<ReplyContextOf<typeof saga, "result">>().toEqualTypeOf<{
      holdId: string;
    }>();
    // Non-reply message returns null
    expectTypeOf<ReplyContextOf<typeof saga, "start">>().toEqualTypeOf<null>();
  });

  test("reply() inferred payload type has correct result.value type", () => {
    const schema = reply(wallet, "withdraw", {
      context: z.object({ txId: z.string() }),
    });
    type Payload = z.infer<typeof schema>;
    type SuccessResult = Extract<Payload["result"], { kind: "success" }>;
    expectTypeOf<SuccessResult["value"]>().toEqualTypeOf<{
      newBalance: number;
    }>();
    expectTypeOf<Payload["context"]>().toEqualTypeOf<{ txId: string }>();
  });

  test("ReplyPayload type matches reply() schema inference", () => {
    type Expected = ReplyPayload<{ newBalance: number }, { txId: string }>;
    expectTypeOf<Expected["context"]>().toEqualTypeOf<{ txId: string }>();
    type SuccessResult = Extract<Expected["result"], { kind: "success" }>;
    expectTypeOf<SuccessResult["value"]>().toEqualTypeOf<{
      newBalance: number;
    }>();
  });

  test("ValidReplyHandlers only allows reply-typed handlers matching the target", () => {
    const saga = defineActor({
      type: "saga",
      state: z.object({ phase: z.string() }),
      messages: {
        start: z.object({ amount: z.number() }),
        depositResult: reply(wallet, "deposit", {
          context: z.object({ memo: z.string() }),
        }),
        withdrawResult: reply(wallet, "withdraw"),
        unrelated: z.object({ foo: z.string() }),
      },
      initialState: () => ({ phase: "init" }),
      handle: {
        start: async () => {},
        depositResult: async () => {},
        withdrawResult: async () => {},
        unrelated: async () => {},
      },
    });

    // Both depositResult and withdrawResult match wallet.deposit's return type
    // (both return { newBalance }) so both are valid
    type DepositHandlers = ValidReplyHandlers<typeof saga, typeof wallet, "deposit">;
    expectTypeOf<"depositResult">().toMatchTypeOf<DepositHandlers>();
    expectTypeOf<"withdrawResult">().toMatchTypeOf<DepositHandlers>();

    // "start" is not a reply handler — should be excluded
    expectTypeOf<"start">().not.toMatchTypeOf<DepositHandlers>();

    // "unrelated" is not a reply handler — should be excluded
    expectTypeOf<"unrelated">().not.toMatchTypeOf<DepositHandlers>();
  });
});
