/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { createFunctionHandle } from "convex/server";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { api, internal } from "../_generated/api.js";
import schema from "../schema.js";
import { counter } from "../testHelpers.js";

const modules = import.meta.glob("../**/*.ts");

const T0 = 1_700_000_000_000;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
});
afterEach(() => {
  vi.useRealTimers();
});

// ── Helpers ───────────────────────────────────────────────────────

function setup() {
  return convexTest(schema, modules);
}

/**
 * Get a function handle for testExecute. Must be called inside t.run.
 */
async function getExecuteFn(): Promise<string> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return await createFunctionHandle((internal as any).testHelpers.testExecute);
}

/**
 * Send a message via enqueueMessage, then drain until idle.
 */
async function sendAndDrain(
  t: ReturnType<typeof convexTest>,
  args: {
    actorType: string;
    name: string;
    msgType: string;
    payload: unknown;
  },
) {
  const executeFn = await t.run(getExecuteFn);

  const messageIds = await t.mutation(api.enqueue.enqueueMessage, {
    effects: [
      {
        actorType: args.actorType,
        name: args.name,
        msgType: args.msgType,
        payload: args.payload,
        deliverAt: Date.now(),
      },
    ],
    executeFn,
  });

  await drainUntilIdle(t, args.actorType, args.name);
  return messageIds[0];
}

/**
 * Call drainLoop directly in a loop until the mailbox is idle.
 */
async function drainUntilIdle(
  t: ReturnType<typeof convexTest>,
  actorType: string,
  name: string,
  maxIterations = 20,
) {
  const executeFn = await t.run(getExecuteFn);

  for (let i = 0; i < maxIterations; i++) {
    const info = await t.query(api.actors.getMailboxInfo, {
      actorType,
      name,
    });
    if (!info || info.drainKind === "idle") break;

    await t.mutation(internal.drain.drainLoop, {
      actorId: info.actorId,
      generation: info.generation,
      executeFn,
    });
  }
}

// ── Tests ─────────────────────────────────────────────────────────

describe("drain e2e", () => {
  test("success path: send → drain → state patched, response row, peek projection", async () => {
    const t = setup();

    const messageId = await sendAndDrain(t, {
      actorType: "counter",
      name: "a",
      msgType: "inc",
      payload: { by: 5 },
    });

    const response = await t.query(api.responses.getResponseRow, {
      messageId,
    });
    expect(response).not.toBeNull();
    expect(response!.response).toEqual({
      kind: "success",
      value: { newCount: 5 },
    });

    const state = await t.query(api.actors.getActorState, {
      actorType: "counter",
      name: "a",
    });
    const projected = counter.project!(state);
    expect(projected).toEqual({ count: 5 });
  });

  test("multiple sends accumulate state", async () => {
    const t = setup();

    await sendAndDrain(t, {
      actorType: "counter",
      name: "b",
      msgType: "inc",
      payload: { by: 3 },
    });
    await sendAndDrain(t, {
      actorType: "counter",
      name: "b",
      msgType: "inc",
      payload: { by: 7 },
    });

    const state = await t.query(api.actors.getActorState, {
      actorType: "counter",
      name: "b",
    });
    const projected = counter.project!(state);
    expect(projected).toEqual({ count: 10 });
  });

  test("ctx.fail path: state unchanged, fail response", async () => {
    const t = setup();

    const messageId = await sendAndDrain(t, {
      actorType: "failActor",
      name: "x",
      msgType: "doFail",
      payload: { reason: "nope" },
    });

    const response = await t.query(api.responses.getResponseRow, {
      messageId,
    });
    expect(response).not.toBeNull();
    expect(response!.response).toEqual({
      kind: "fail",
      reason: "nope",
      details: { extra: 42 },
    });
  });

  test("handler throw → defect after 3 attempts", async () => {
    const t = setup();

    const messageId = await sendAndDrain(t, {
      actorType: "throwActor",
      name: "y",
      msgType: "boom",
      payload: {},
    });

    const response = await t.query(api.responses.getResponseRow, {
      messageId,
    });
    expect(response).not.toBeNull();
    expect(response!.response.kind).toBe("defect");
    if (response!.response.kind === "defect") {
      expect(response!.response.error).toContain("kaboom");
      expect(response!.response.attempts).toBe(3);
    }
  });

  test("cross-actor effect: handler sends to another actor", async () => {
    const t = setup();

    await sendAndDrain(t, {
      actorType: "senderActor",
      name: "s1",
      msgType: "sendToCounter",
      payload: { counterName: "target", by: 42 },
    });

    await drainUntilIdle(t, "counter", "target");

    const state = await t.query(api.actors.getActorState, {
      actorType: "counter",
      name: "target",
    });
    const projected = counter.project!(state);
    expect(projected).toEqual({ count: 42 });
  });

  test("handler with void return → response.value is null", async () => {
    const t = setup();

    const messageId = await sendAndDrain(t, {
      actorType: "counter",
      name: "c",
      msgType: "reset",
      payload: {},
    });

    const response = await t.query(api.responses.getResponseRow, {
      messageId,
    });
    expect(response).not.toBeNull();
    expect(response!.response).toEqual({
      kind: "success",
      value: null,
    });
  });
});
