import { z } from "zod";
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
