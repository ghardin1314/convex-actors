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

  test("wallet returns handler values in response", async () => {
    const t = setup();

    // Fund the wallet
    await t.mutation(api.actorFunctions.send, {
      actorType: "wallet",
      name: "alice",
      msgType: "deposit",
      payload: { amount: 100 },
    });
    await finishScheduled(t);

    // Withdraw and check response
    const msgId = await t.mutation(api.actorFunctions.send, {
      actorType: "wallet",
      name: "alice",
      msgType: "withdraw",
      payload: { amount: 30 },
    });
    await finishScheduled(t);

    const response = await t.query(api.actorFunctions.getResponse, {
      messageId: msgId,
    });
    expect(response!.response).toEqual({
      kind: "success",
      value: { newBalance: 70 },
    });
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

describe("integration: ask/reply (jobRunner → fragile)", () => {
  test("successful work: ask routes echo back to jobRunner", async () => {
    const t = setup();

    await t.mutation(api.actorFunctions.send, {
      actorType: "jobRunner",
      name: "runner-1",
      msgType: "dispatch",
      payload: { worker: "w1", value: "hello" },
    });
    await finishScheduled(t);

    const state = await t.query(api.actorFunctions.peek, {
      actorType: "jobRunner",
      name: "runner-1",
    });
    expect(state).toMatchObject({
      pending: 0,
      completed: [{ job: "hello", echo: "hello" }],
      failed: [],
    });
  });

  test("crash: defect routes back after max retries", async () => {
    const t = setup();

    await t.mutation(api.actorFunctions.send, {
      actorType: "jobRunner",
      name: "runner-2",
      msgType: "dispatchCrash",
      payload: { worker: "w-crash" },
    });
    // Needs multiple drain cycles for retry attempts + defect + reply routing
    await finishScheduled(t);

    const state = await t.query(api.actorFunctions.peek, {
      actorType: "jobRunner",
      name: "runner-2",
    });
    expect(state).toMatchObject({
      pending: 0,
      completed: [],
    });
    // Should have one failed job with the defect error
    expect((state as { failed: { job: string; error: string }[] }).failed).toHaveLength(1);
    expect((state as { failed: { job: string; error: string }[] }).failed[0].job).toBe("crash-w-crash");
  });

  test("mixed: success and crash in same runner", async () => {
    const t = setup();

    await t.mutation(api.actorFunctions.send, {
      actorType: "jobRunner",
      name: "runner-3",
      msgType: "dispatch",
      payload: { worker: "w-ok", value: "good-job" },
    });
    await t.mutation(api.actorFunctions.send, {
      actorType: "jobRunner",
      name: "runner-3",
      msgType: "dispatchCrash",
      payload: { worker: "w-bad" },
    });
    await finishScheduled(t);

    const state = await t.query(api.actorFunctions.peek, {
      actorType: "jobRunner",
      name: "runner-3",
    }) as { pending: number; completed: { job: string }[]; failed: { job: string }[] };
    expect(state.pending).toBe(0);
    expect(state.completed).toHaveLength(1);
    expect(state.completed[0].job).toBe("good-job");
    expect(state.failed).toHaveLength(1);
    expect(state.failed[0].job).toBe("crash-w-bad");
  });
});

describe("integration: ask/reply in regular actor (wallet.transfer)", () => {
  test("transfer asks target wallet to deposit, gets confirmation", async () => {
    const t = setup();

    // Fund alice
    await t.mutation(api.actorFunctions.send, {
      actorType: "wallet",
      name: "alice",
      msgType: "deposit",
      payload: { amount: 100 },
    });
    await finishScheduled(t);

    // Alice transfers to bob
    await t.mutation(api.actorFunctions.send, {
      actorType: "wallet",
      name: "alice",
      msgType: "transfer",
      payload: { to: "bob", amount: 40 },
    });
    // Drains: alice.transfer → bob.deposit → alice.transferDepositResult
    await finishScheduled(t);

    const alice = await t.query(api.actorFunctions.peek, {
      actorType: "wallet",
      name: "alice",
    });
    const bob = await t.query(api.actorFunctions.peek, {
      actorType: "wallet",
      name: "bob",
    });
    const a = alice as { balance: number; log: string[] };
    const b = bob as { balance: number; log: string[] };
    expect(a.balance).toBe(60);
    expect(b.balance).toBe(40);
    // Alice's log should show the confirmation
    expect(a.log.some((l: string) => l.includes("confirmed"))).toBe(true);
  });
});

describe("integration: ask/reply (transferSaga)", () => {
  test("successful transfer: withdraw → deposit via saga", async () => {
    const t = setup();

    // Fund source wallet
    await t.mutation(api.actorFunctions.send, {
      actorType: "wallet",
      name: "alice",
      msgType: "deposit",
      payload: { amount: 200 },
    });
    await finishScheduled(t);

    // Start the saga
    await t.mutation(api.actorFunctions.send, {
      actorType: "transferSaga",
      name: "tx-1",
      msgType: "start",
      payload: { from: "alice", to: "bob", amount: 75 },
    });
    // Let all scheduled drains fire (saga start → withdraw → withdrawResult → deposit → depositResult)
    await finishScheduled(t);

    // Saga should be done
    const sagaState = await t.query(api.actorFunctions.peek, {
      actorType: "transferSaga",
      name: "tx-1",
    });
    expect(sagaState).toMatchObject({ phase: "done", amount: 75 });

    // Wallets should reflect the transfer
    const alice = await t.query(api.actorFunctions.peek, {
      actorType: "wallet",
      name: "alice",
    });
    const bob = await t.query(api.actorFunctions.peek, {
      actorType: "wallet",
      name: "bob",
    });
    expect((alice as { balance: number }).balance).toBe(125);
    expect((bob as { balance: number }).balance).toBe(75);
  });

  test("failed transfer: insufficient funds routes fail to saga", async () => {
    const t = setup();

    // Fund source wallet with insufficient amount
    await t.mutation(api.actorFunctions.send, {
      actorType: "wallet",
      name: "poor",
      msgType: "deposit",
      payload: { amount: 10 },
    });
    await finishScheduled(t);

    // Start saga that tries to withdraw more than available
    await t.mutation(api.actorFunctions.send, {
      actorType: "transferSaga",
      name: "tx-fail",
      msgType: "start",
      payload: { from: "poor", to: "bob", amount: 999 },
    });
    await finishScheduled(t);

    // Saga should be failed
    const sagaState = await t.query(api.actorFunctions.peek, {
      actorType: "transferSaga",
      name: "tx-fail",
    });
    expect(sagaState).toMatchObject({
      phase: "failed",
      failReason: "insufficient_funds",
    });

    // Source wallet should be untouched
    const poor = await t.query(api.actorFunctions.peek, {
      actorType: "wallet",
      name: "poor",
    });
    expect((poor as { balance: number }).balance).toBe(10);
  });
});
