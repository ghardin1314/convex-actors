/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { z } from "zod";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { components } from "../../../_generated/api.js";
import { api as componentApi } from "../_generated/api.js";
import componentSchema from "../schema.js";
import schema from "../../../schema.js";
import { defineActor } from "./defineActor.js";
import { ActorSystem } from "./system.js";

const appModules = import.meta.glob("../../../**/*.ts");
const componentModules = import.meta.glob("../**/*.ts");

const T0 = 1_700_000_000_000;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
});
afterEach(() => {
  vi.useRealTimers();
});

const counter = defineActor({
  type: "counter",
  state: z.object({ n: z.number() }),
  messages: { inc: { payload: z.object({ by: z.number() }) } },
  initialState: () => ({ n: 0 }),
  project: (state) => ({ count: state.n }),
  handle: {
    inc: async (state, { by }) => {
      state.n += by;
    },
  },
});

const noProjectActor = defineActor({
  type: "noProject",
  state: z.object({ x: z.number() }),
  messages: { poke: { payload: z.object({}) } },
  initialState: () => ({ x: 0 }),
  handle: {
    poke: async () => {},
  },
});

function makeExecuteRef() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (componentApi as any).kick.kickMailbox;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function setup(defs: Record<string, any>) {
  const t = convexTest(schema, appModules);
  t.registerComponent("actors", componentSchema, componentModules);
  const system = new ActorSystem(components.actors, defs);
  const ref = makeExecuteRef();
  return { t, system, ref };
}

describe("system.peek", () => {
  test("peek on a never-addressed actor returns null", async () => {
    const { t, system } = setup({ counter });
    await t.run(async (ctx) => {
      const result = await system.peek(ctx, counter, "nonexistent");
      expect(result).toBeNull();
    });
  });

  test("peek after send but before drain returns null (state absent)", async () => {
    const { t, system, ref } = setup({ counter });
    await t.run(async (ctx) => {
      await system.send(ctx, ref, counter, "a", "inc", { by: 1 });
      // Actor row exists but state is absent (drain hasn't run yet).
      const result = await system.peek(ctx, counter, "a");
      expect(result).toBeNull();
    });
  });

  test("peek on a definition without project returns null", async () => {
    const { t, system } = setup({ counter, noProjectActor });
    await t.run(async (ctx) => {
      const result = await system.peek(ctx, noProjectActor, "a");
      expect(result).toBeNull();
    });
  });

  test("unknown actorType throws", async () => {
    const { t, system } = setup({ counter });
    await t.run(async (ctx) => {
      const ghost = { ...counter, type: "ghost" };
      await expect(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        system.peek(ctx, ghost as any, "a"),
      ).rejects.toThrow(/unknown actor type "ghost"/);
    });
  });

  // "peek returns projection after state has been written" — deferred to
  // drain e2e tests. Can't write component rows from app-space in unit
  // tests; the full send → drain → peek flow exercises this path.
});
