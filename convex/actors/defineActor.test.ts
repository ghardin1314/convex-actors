import { v } from "convex/values";
import { describe, expect, expectTypeOf, test } from "vitest";

import {
  defineActor,
  type PayloadOf,
  type ProjectionOf,
  type StateOf,
} from "./defineActor";

describe("defineActor", () => {
  const chatRoom = defineActor({
    type: "chatRoom",
    state: v.object({
      members: v.array(v.string()),
      messages: v.array(v.object({ from: v.string(), text: v.string() })),
      lastActivity: v.number(),
    }),
    messages: {
      join: v.object({ user: v.string() }),
      leave: v.object({ user: v.string() }),
      post: v.object({ from: v.string(), text: v.string() }),
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
      state: v.object({ n: v.number() }),
      messages: { inc: v.object({ by: v.number() }) },
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

  test("exposes the state + payload validators at runtime", () => {
    // payload validators are reachable for enqueue-time validation
    expect(Object.keys(chatRoom.messages).sort()).toEqual([
      "join",
      "leave",
      "post",
    ]);
    // sanity: the validator is a real Convex validator (has `kind` field)
    expect("kind" in chatRoom.messages.join).toBe(true);
    expect("kind" in chatRoom.state).toBe(true);
  });

  test("initialState matches the state validator shape", () => {
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

  test("StateOf / PayloadOf infer from the validators", () => {
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
      state: v.object({ n: v.number() }),
      messages: { inc: v.object({ by: v.number() }) },
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
});
