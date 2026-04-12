/**
 * Tests for the test helpers themselves — unit tests for invokeHandler,
 * resolveAsk (actor ↔ actor), and resolveSagaStep (saga step reply
 * synthesis).
 */
import { z } from "zod";
import { describe, expect, test } from "vitest";
import {
  invokeHandler,
  resolveAsk,
  resolveSagaStep,
} from "./testing.js";
import { defineActor, reply } from "./defineActor.js";
import { defineSaga } from "./defineSaga.js";

// ── invokeHandler basics ─────────────────────────────────────

describe("invokeHandler", () => {
  const counter = defineActor({
    type: "counter",
    state: z.object({ n: z.number() }),
    messages: {
      inc: {
        payload: z.object({ by: z.number() }),
        response: z.object({ newN: z.number() }),
      },
      boom: { payload: z.object({}) },
    },
    initialState: () => ({ n: 0 }),
    handle: {
      inc: async (state, { by }, ctx) => {
        if (by < 0) ctx.fail("negative", { by });
        state.n += by;
        return { newN: state.n };
      },
      boom: async () => {
        throw new Error("kaboom");
      },
    },
  });

  test("success returns new state, response, and effects", async () => {
    const result = await invokeHandler(counter, {
      msgType: "inc",
      payload: { by: 5 },
    });
    expect(result).toMatchObject({
      outcome: "success",
      state: { n: 5 },
      response: { newN: 5 },
      effects: [],
    });
  });

  test("defaults state to def.initialState()", async () => {
    const result = await invokeHandler(counter, {
      msgType: "inc",
      payload: { by: 1 },
    });
    if (result.outcome !== "success") throw new Error("expected success");
    expect(result.state.n).toBe(1);
  });

  test("fail returns reason + details + unchanged state", async () => {
    const result = await invokeHandler(counter, {
      msgType: "inc",
      payload: { by: -1 },
      state: { n: 10 },
    });
    expect(result).toMatchObject({
      outcome: "fail",
      reason: "negative",
      details: { by: -1 },
      state: { n: 10 },
    });
  });

  test("throw is classified as defect with unchanged state", async () => {
    const result = await invokeHandler(counter, {
      msgType: "boom",
      payload: {},
      state: { n: 7 },
    });
    expect(result).toMatchObject({
      outcome: "defect",
      error: "kaboom",
      state: { n: 7 },
    });
  });
});

// ── resolveAsk: actor ↔ actor ────────────────────────────────

describe("resolveAsk", () => {
  const wallet = defineActor({
    type: "wallet",
    state: z.object({ balance: z.number() }),
    messages: {
      withdraw: {
        payload: z.object({ amount: z.number() }),
        response: z.object({ newBalance: z.number() }),
      },
    },
    initialState: () => ({ balance: 0 }),
    handle: {
      withdraw: async (state, { amount }, ctx) => {
        if (amount > state.balance) ctx.fail("insufficient_funds");
        state.balance -= amount;
        return { newBalance: state.balance };
      },
    },
  });

  const buyer = defineActor({
    type: "buyer",
    state: z.object({
      phase: z.enum(["idle", "paying", "paid", "refused"]),
      lastBalance: z.number().nullable(),
      failReason: z.string().nullable(),
    }),
    messages: {
      purchase: {
        payload: z.object({ wallet: z.string(), amount: z.number() }),
      },
      withdrawResult: {
        payload: reply(wallet, "withdraw", {
          context: z.object({ amount: z.number() }),
        }),
      },
    },
    initialState: () => ({
      phase: "idle" as const,
      lastBalance: null,
      failReason: null,
    }),
    handle: {
      purchase: async (state, { wallet: walletName, amount }, ctx) => {
        state.phase = "paying";
        ctx.stub(wallet, walletName).ask(
          "withdraw",
          { amount },
          { handler: "withdrawResult", context: { amount } },
        );
      },
      withdrawResult: async (state, { result }) => {
        if (result.kind === "success") {
          state.phase = "paid";
          state.lastBalance = result.value.newBalance;
        } else if (result.kind === "fail") {
          state.phase = "refused";
          state.failReason = result.reason;
        }
      },
    },
  });

  async function paying() {
    const result = await invokeHandler(buyer, {
      selfName: "b1",
      msgType: "purchase",
      payload: { wallet: "w1", amount: 50 },
    });
    if (result.outcome !== "success") throw new Error("expected success");
    return result;
  }

  test("resolves a success reply and invokes withdrawResult", async () => {
    const { state, effects } = await paying();
    const askEffect = effects.find((e) => e.replyTo !== undefined)!;
    expect(askEffect).toBeDefined();
    expect(askEffect.replyTo!.handler).toBe("withdrawResult");

    const next = await resolveAsk(buyer, {
      state,
      effect: askEffect,
      kind: "success",
      value: { newBalance: 950 },
    });
    if (next.outcome !== "success") throw new Error("expected success");
    expect(next.state).toEqual({
      phase: "paid",
      lastBalance: 950,
      failReason: null,
    });
  });

  test("resolves a fail reply and invokes withdrawResult", async () => {
    const { state, effects } = await paying();
    const askEffect = effects.find((e) => e.replyTo !== undefined)!;

    const next = await resolveAsk(buyer, {
      state,
      effect: askEffect,
      kind: "fail",
      reason: "insufficient_funds",
    });
    if (next.outcome !== "success") throw new Error("expected success");
    expect(next.state).toMatchObject({
      phase: "refused",
      failReason: "insufficient_funds",
    });
  });

  test("defaults selfName and from from the effect's replyTo + target", async () => {
    const { state, effects } = await paying();
    const askEffect = effects.find((e) => e.replyTo !== undefined)!;
    // effect target is wallet:w1, replyTo.name is buyer:b1
    expect(askEffect.name).toBe("w1");
    expect(askEffect.replyTo!.name).toBe("b1");

    // Sanity: resolving doesn't throw on default selfName / from.
    const next = await resolveAsk(buyer, {
      state,
      effect: askEffect,
      kind: "success",
      value: { newBalance: 0 },
    });
    expect(next.outcome).toBe("success");
  });

  test("throws on a send effect (no replyTo)", async () => {
    const sendActor = defineActor({
      type: "sender",
      state: z.object({}),
      messages: {
        go: { payload: z.object({}) },
      },
      initialState: () => ({}),
      handle: {
        go: async (_state, _payload, ctx) => {
          ctx.stub(wallet, "w1").send("withdraw", { amount: 1 });
        },
      },
    });
    const result = await invokeHandler(sendActor, {
      msgType: "go",
      payload: {},
    });
    if (result.outcome !== "success") throw new Error("expected success");
    await expect(
      resolveAsk(sendActor, {
        state: result.state,
        effect: result.effects[0],
        kind: "success",
        value: null,
      }),
    ).rejects.toThrow(/no replyTo — it was a send/);
  });

  test("throws when the def doesn't match the effect's replyTo.actorType", async () => {
    const { effects } = await paying();
    const askEffect = effects.find((e) => e.replyTo !== undefined)!;
    // Try to route the reply into `wallet` — replyTo.actorType is `buyer`.
    await expect(
      resolveAsk(wallet, {
        state: { balance: 0 },
        effect: askEffect,
        kind: "success",
        value: null,
      }),
    ).rejects.toThrow(/does not match def "wallet"/);
  });
});

// ── resolveSagaStep ──────────────────────────────────────────

describe("resolveSagaStep", () => {
  const target = defineActor({
    type: "target",
    state: z.object({}),
    messages: {
      work: {
        payload: z.object({}),
        response: z.object({ done: z.boolean() }),
      },
    },
    initialState: () => ({}),
    handle: {
      work: async () => ({ done: true }),
    },
  });

  const twoStep = defineSaga({
    type: "twoStep",
    input: z.object({}),
    context: z.object({ count: z.number() }),
    initialContext: () => ({ count: 0 }),
    firstStep: "stepA",
    steps: {
      stepA: {
        run: (_input, _ctx, stepCtx) =>
          stepCtx.stub(target, "t1").ask("work", {}),
        onSuccess: (_value, _input, context) => ({
          next: "stepB" as const,
          context: { count: context.count + 1 },
        }),
      },
      stepB: {
        run: (_input, _ctx, stepCtx) =>
          stepCtx.stub(target, "t2").ask("work", {}),
        onSuccess: () => ({ next: null }),
      },
    },
  });

  async function started() {
    const result = await invokeHandler(twoStep, {
      selfName: "s1",
      msgType: "start",
      payload: {},
    });
    if (result.outcome !== "success") throw new Error("expected success");
    return result.state;
  }

  test("resolves the currently awaited step without knowing its name", async () => {
    const s0 = await started();
    const afterA = await resolveSagaStep(twoStep, {
      selfName: "s1",
      state: s0,
      kind: "success",
      value: { done: true },
    });
    if (afterA.outcome !== "success") throw new Error("expected success");
    expect(twoStep.project!(afterA.state)).toMatchObject({
      currentStep: "stepB",
      completedSteps: ["stepA"],
    });
  });

  test("throws when the saga is not awaiting an ask reply", async () => {
    const s0 = await started();
    const afterA = await resolveSagaStep(twoStep, {
      selfName: "s1",
      state: s0,
      kind: "success",
      value: { done: true },
    });
    if (afterA.outcome !== "success") throw new Error("expected success");
    const afterB = await resolveSagaStep(twoStep, {
      selfName: "s1",
      state: afterA.state,
      kind: "success",
      value: { done: true },
    });
    if (afterB.outcome !== "success") throw new Error("expected success");
    // Saga is now completed.
    await expect(
      resolveSagaStep(twoStep, {
        selfName: "s1",
        state: afterB.state,
        kind: "success",
        value: { done: true },
      }),
    ).rejects.toThrow(/not awaiting an ask reply/);
  });
});
