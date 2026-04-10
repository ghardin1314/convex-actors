import { z } from "zod";
import { describe, expect, expectTypeOf, test } from "vitest";

import { defineActor } from "./defineActor";
import { ActorSystem, type ActorsComponent } from "./system";

// Minimal stand-in for `components.actors`. Only the shape matters —
// `ActorSystem` in this step never dereferences any function on it.
const fakeComponent = {} as ActorsComponent;

const counter = defineActor({
  type: "counter",
  state: z.object({ n: z.number() }),
  messages: { inc: { payload: z.object({ by: z.number() }) } },
  initialState: () => ({ n: 0 }),
  handle: {
    inc: async (state, { by }) => {
      state.n += by;
    },
  },
});

const chatRoom = defineActor({
  type: "chatRoom",
  state: z.object({ members: z.array(z.string()) }),
  messages: { join: { payload: z.object({ user: z.string() }) } },
  initialState: () => ({ members: [] }),
  handle: {
    join: async (state, { user }) => {
      state.members.push(user);
    },
  },
});

describe("ActorSystem", () => {
  test("retrieves registered definitions by actor type", () => {
    const system = new ActorSystem(fakeComponent, { counter, chatRoom });

    expect(system.getDefinition("counter")).toBe(counter);
    expect(system.getDefinition("chatRoom")).toBe(chatRoom);
    expect(system.hasDefinition("counter")).toBe(true);
    expect(system.hasDefinition("chatRoom")).toBe(true);
  });

  test("throws on lookup of an unregistered type (with compile-time rejection)", () => {
    const system = new ActorSystem(fakeComponent, { counter });

    // `hasDefinition` accepts any string so it can guard untrusted input.
    expect(system.hasDefinition("chatRoom")).toBe(false);

    // `getDefinition` is constrained to the union of registered
    // `.type` literals. Passing an unregistered literal is a compile
    // error — asserted with `@ts-expect-error`. The runtime throw is
    // still exercised for the dynamic-string code path (`send`
    // decoding an over-the-wire arg, etc.).
    expect(() =>
      // @ts-expect-error "chatRoom" is not a registered actor type on this system
      system.getDefinition("chatRoom"),
    ).toThrow(/unknown actor type "chatRoom"/);
  });

  test("getDefinition return type is narrowed to the matching definition", () => {
    const system = new ActorSystem(fakeComponent, { counter, chatRoom });

    // Literal "counter" narrows the return to the counter def, so
    // `initialState()` is typed as `{ n: number }` not `unknown`.
    const def = system.getDefinition("counter");
    const s0 = def.initialState();
    expectTypeOf(s0).toEqualTypeOf<{ n: number }>();
    expect(s0).toEqual({ n: 0 });
  });

  test("throws on construction when two definitions share a type", () => {
    const counterAlias = defineActor({
      type: "counter",
      state: z.object({ n: z.number() }),
      messages: { inc: { payload: z.object({ by: z.number() }) } },
      initialState: () => ({ n: 0 }),
      handle: {
        inc: async (state, { by }) => {
          state.n += by;
        },
      },
    });

    expect(
      () =>
        new ActorSystem(fakeComponent, {
          counter,
          counterTwo: counterAlias,
        }),
    ).toThrow(/duplicate actor type "counter"/);
  });

  test("exposes the component reference and definitions record verbatim", () => {
    const defs = { counter, chatRoom };
    const system = new ActorSystem(fakeComponent, defs);

    expect(system.component).toBe(fakeComponent);
    expect(system.definitions).toBe(defs);
  });

  test("allDefinitions iterates in insertion order", () => {
    const system = new ActorSystem(fakeComponent, { counter, chatRoom });
    expect([...system.allDefinitions()].map((d) => d.type)).toEqual([
      "counter",
      "chatRoom",
    ]);
  });

  test("indexes by `definition.type`, not by the input record's key", () => {
    // Record key "myCounter" is ergonomic; the actual lookup string is
    // the definition's `type` field ("counter").
    const system = new ActorSystem(fakeComponent, { myCounter: counter });

    expect(system.getDefinition("counter")).toBe(counter);
    expect(system.hasDefinition("myCounter")).toBe(false);
  });
});
