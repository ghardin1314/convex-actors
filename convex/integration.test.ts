/// <reference types="vite/client" />
/**
 * Integration test: validates the full end-to-end path where:
 * 1. App-level `send` mutation enqueues a message
 * 2. Component `drainLoop` fires via scheduler
 * 3. drainLoop calls app-level `execute` via function handle
 * 4. State is committed, response row written
 *
 * This is the first test exercising the component→app cross-boundary
 * `ctx.runMutation(executeFn)` call with real scheduling.
 */
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { api } from "./_generated/api.js";
import schema from "./schema.js";
import componentSchema from "./components/actors/schema.js";

const appModules = import.meta.glob("./**/*.ts");
const componentModules = import.meta.glob("./components/actors/**/*.ts");

const T0 = 1_700_000_000_000;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
});
afterEach(() => {
  vi.useRealTimers();
});

function setup() {
  const t = convexTest(schema, appModules);
  t.registerComponent("actors", componentSchema, componentModules);
  return t;
}

async function finishScheduled(t: ReturnType<typeof convexTest>) {
  await t.finishAllScheduledFunctions(() => {
    vi.advanceTimersByTime(1000);
  });
}

describe("integration: scheduled drain via function handle", () => {
  test("send → scheduled drain fires → state updated, response written", async () => {
    const t = setup();

    const messageId = await t.mutation(api.actorFunctions.send, {
      actorType: "counter",
      name: "test-counter",
      msgType: "inc",
      payload: { by: 7 },
    });
    expect(typeof messageId).toBe("string");

    // Let the scheduled drainLoop fire
    await finishScheduled(t);

    // Verify state via peek
    const projection = await t.query(api.actorFunctions.peek, {
      actorType: "counter",
      name: "test-counter",
    });
    expect(projection).toEqual({ count: 7 });

    // Verify response row
    const response = await t.query(api.actorFunctions.getResponse, {
      messageId,
    });
    expect(response).not.toBeNull();
    expect(response!.response).toEqual({ kind: "success", value: null });
  });

  test("multiple sends accumulate state through scheduled drains", async () => {
    const t = setup();

    await t.mutation(api.actorFunctions.send, {
      actorType: "counter",
      name: "accum",
      msgType: "inc",
      payload: { by: 3 },
    });
    await finishScheduled(t);

    await t.mutation(api.actorFunctions.send, {
      actorType: "counter",
      name: "accum",
      msgType: "inc",
      payload: { by: 7 },
    });
    await finishScheduled(t);

    const projection = await t.query(api.actorFunctions.peek, {
      actorType: "counter",
      name: "accum",
    });
    expect(projection).toEqual({ count: 10 });
  });

  test("dec and reset messages work", async () => {
    const t = setup();

    await t.mutation(api.actorFunctions.send, {
      actorType: "counter",
      name: "ops",
      msgType: "inc",
      payload: { by: 10 },
    });
    await finishScheduled(t);

    await t.mutation(api.actorFunctions.send, {
      actorType: "counter",
      name: "ops",
      msgType: "dec",
      payload: { by: 3 },
    });
    await finishScheduled(t);

    let projection = await t.query(api.actorFunctions.peek, {
      actorType: "counter",
      name: "ops",
    });
    expect(projection).toEqual({ count: 7 });

    await t.mutation(api.actorFunctions.send, {
      actorType: "counter",
      name: "ops",
      msgType: "reset",
      payload: {},
    });
    await finishScheduled(t);

    projection = await t.query(api.actorFunctions.peek, {
      actorType: "counter",
      name: "ops",
    });
    expect(projection).toEqual({ count: 0 });
  });

  test("peek on nonexistent actor returns null", async () => {
    const t = setup();
    const result = await t.query(api.actorFunctions.peek, {
      actorType: "counter",
      name: "ghost",
    });
    expect(result).toBeNull();
  });

  test("independent actors maintain separate state", async () => {
    const t = setup();

    await t.mutation(api.actorFunctions.send, {
      actorType: "counter",
      name: "alice",
      msgType: "inc",
      payload: { by: 100 },
    });
    await t.mutation(api.actorFunctions.send, {
      actorType: "counter",
      name: "bob",
      msgType: "inc",
      payload: { by: 1 },
    });
    await finishScheduled(t);

    const alice = await t.query(api.actorFunctions.peek, {
      actorType: "counter",
      name: "alice",
    });
    const bob = await t.query(api.actorFunctions.peek, {
      actorType: "counter",
      name: "bob",
    });
    expect(alice).toEqual({ count: 100 });
    expect(bob).toEqual({ count: 1 });
  });
});
