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

// Fixed wall clock so `deliverAt` math is stable.
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
  messages: {
    inc: { payload: z.object({ by: z.number() }) },
    reset: { payload: z.object({}) },
  },
  initialState: () => ({ n: 0 }),
  handle: {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    inc: async (state, { by }) => {
      state.n += by;
    },
    reset: async (state) => {
      state.n = 0;
    },
  },
});

/**
 * Stand-in executeRef thunk. Produces a function handle that is never
 * actually invoked in send-only tests (we never advance fake timers
 * past the scheduled drain). Using `componentApi.kick.kickMailbox`
 * as the target is arbitrary — any parseable reference works.
 */
function makeExecuteRef() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (componentApi as any).kick.kickMailbox;
}

function setup<
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  Defs extends Record<string, any>,
>(defs: Defs) {
  const t = convexTest(schema, appModules);
  t.registerComponent("actors", componentSchema, componentModules);
  const system = new ActorSystem(components.actors, defs);
  const ref = makeExecuteRef();
  return { t, system, ref };
}

describe("system.send", () => {
  test("happy path: inserts via enqueue, returns a message id string", async () => {
    const { t, system, ref } = setup({ counter });
    await t.run(async (ctx) => {
      const messageId = await system.send(
        ctx, ref, counter, "a", "inc", { by: 5 },
      );
      expect(typeof messageId).toBe("string");
      expect(messageId.length).toBeGreaterThan(0);
    });
  });

  test("unknown actorType throws before touching the component", async () => {
    const { t, system, ref } = setup({ counter });
    await t.run(async (ctx) => {
      const ghost = { ...counter, type: "ghost" };
      await expect(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        system.send(ctx, ref, ghost as any, "a", "inc", { by: 1 }),
      ).rejects.toThrow(/unknown actor type "ghost"/);
    });
  });

  test("unknown msgType throws before touching the component", async () => {
    const { t, system, ref } = setup({ counter });
    await t.run(async (ctx) => {
      await expect(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        system.send(ctx, ref, counter, "a", "bogus" as any, {}),
      ).rejects.toThrow(/unknown msgType "bogus"/);
    });
  });

  test("invalid payload throws before touching the component", async () => {
    const { t, system, ref } = setup({ counter });
    await t.run(async (ctx) => {
      await expect(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        system.send(ctx, ref, counter, "a", "inc", { by: "bad" } as any),
      ).rejects.toThrow(/invalid payload/);
    });
  });

  test("past opts.at is clamped to now", async () => {
    const { t, system, ref } = setup({ counter });
    await t.run(async (ctx) => {
      const id = await system.send(
        ctx, ref, counter, "a", "inc", { by: 1 },
        { at: T0 - 365 * 24 * 3600 * 1000 },
      );
      expect(id).toBeTruthy();
    });
  });

  test("no opts defaults deliverAt to Date.now()", async () => {
    const { t, system, ref } = setup({ counter });
    await t.run(async (ctx) => {
      const id = await system.send(
        ctx, ref, counter, "a", "inc", { by: 1 },
      );
      expect(id).toBeTruthy();
    });
  });
});
