/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { createFunctionHandle } from "convex/server";
import { v } from "convex/values";
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
  state: v.object({ n: v.number() }),
  messages: {
    inc: v.object({ by: v.number() }),
    reset: v.object({}),
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
      const messageId = await system.send(ctx, ref, {
        actorType: "counter",
        name: "a",
        msgType: "inc",
        payload: { by: 5 },
      });
      expect(typeof messageId).toBe("string");
      expect(messageId.length).toBeGreaterThan(0);
    });
  });

  test("unknown actorType throws before touching the component", async () => {
    const { t, system, ref } = setup({ counter });
    await t.run(async (ctx) => {
      await expect(
        system.send(ctx, ref, {
          actorType: "ghost",
          name: "a",
          msgType: "inc",
          payload: { by: 1 },
        }),
      ).rejects.toThrow(/unknown actor type "ghost"/);
    });
  });

  test("unknown msgType throws before touching the component", async () => {
    const { t, system, ref } = setup({ counter });
    await t.run(async (ctx) => {
      await expect(
        system.send(ctx, ref, {
          actorType: "counter",
          name: "a",
          msgType: "bogus",
          payload: {},
        }),
      ).rejects.toThrow(/unknown msgType "bogus"/);
    });
  });

  test("opts.at wins over opts.after when both set", async () => {
    const { t, system, ref } = setup({ counter });
    await t.run(async (ctx) => {
      const id = await system.send(ctx, ref, {
        actorType: "counter",
        name: "a",
        msgType: "inc",
        payload: { by: 1 },
        opts: { at: T0 + 1000, after: 500 },
      });
      expect(id).toBeTruthy();
    });
  });

  test("past opts.at is clamped to now", async () => {
    const { t, system, ref } = setup({ counter });
    await t.run(async (ctx) => {
      const id = await system.send(ctx, ref, {
        actorType: "counter",
        name: "a",
        msgType: "inc",
        payload: { by: 1 },
        opts: { at: T0 - 365 * 24 * 3600 * 1000 },
      });
      expect(id).toBeTruthy();
    });
  });

  test("no opts defaults deliverAt to Date.now()", async () => {
    const { t, system, ref } = setup({ counter });
    await t.run(async (ctx) => {
      const id = await system.send(ctx, ref, {
        actorType: "counter",
        name: "a",
        msgType: "inc",
        payload: { by: 1 },
      });
      expect(id).toBeTruthy();
    });
  });
});
