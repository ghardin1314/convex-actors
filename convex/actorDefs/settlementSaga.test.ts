/// <reference types="vite/client" />
/**
 * Unit tests for `settlementSaga`. Drives each synthesized handler one
 * at a time (start, settleWinnerHold_reply, payoutSeller_reply,
 * notifyAuction flows straight through) and inspects both the
 * framework-owned saga internals and the emitted effects.
 *
 * Particular attention to the `begin` sync marker step: its compensate
 * must fire on *any* downstream failure, even a failure in the very
 * first ask (settleWinnerHold). That's what guarantees the auction is
 * notified via `settlementFailed` in every compensation path.
 */
import { describe, expect, test } from "vitest";
import {
  invokeHandler,
  resolveSagaStep,
} from "../components/actors/client/testing";
import type { Effect } from "../components/actors/client";
import { settlementSaga } from "./settlementSaga";

const INPUT = {
  auctionName: "auction-1",
  winner: "alice",
  seller: "seller-1",
  amount: 100,
  holdId: "hold-bid-1",
};

function findEffect(effects: Effect[], actorType: string, msgType: string) {
  return effects.find((e) => e.actorType === actorType && e.msgType === msgType);
}

async function started() {
  const result = await invokeHandler(settlementSaga, {
    selfName: "auction-1-settlement",
    msgType: "start",
    payload: INPUT,
  });
  if (result.outcome !== "success") throw new Error("expected success");
  return result;
}

// ── start ─────────────────────────────────────────────────────

describe("settlementSaga.start", () => {
  test("chains begin (sync) → settleWinnerHold ask in one dispatch", async () => {
    const result = await started();
    const saga = settlementSaga.project!(result.state);
    // `begin` is sync → marked completed inline. `settleWinnerHold` is
    // an ask → currentStep but not in completedSteps yet.
    expect(saga).toMatchObject({
      phase: "running",
      currentStep: "settleWinnerHold",
      completedSteps: ["begin"],
    });

    const settle = findEffect(result.effects, "account", "settleHold");
    expect(settle).toBeDefined();
    expect(settle!.name).toBe("alice");
    expect(settle!.payload).toEqual({ holdId: "hold-bid-1" });
    expect(settle!.replyTo).toMatchObject({
      actorType: "settlementSaga",
      name: "auction-1-settlement",
      handler: "settleWinnerHold_reply",
    });
  });
});

// ── happy path: settleWinnerHold → payoutSeller ──────────────

describe("settlementSaga: happy path", () => {
  test("settleWinnerHold success → payoutSeller ask", async () => {
    const { state } = await started();
    const result = await resolveSagaStep(settlementSaga, {
      selfName: "auction-1-settlement",
      state,
      kind: "success",
      value: null,
    });
    if (result.outcome !== "success") throw new Error("expected success");
    const saga = settlementSaga.project!(result.state);
    expect(saga).toMatchObject({
      phase: "running",
      currentStep: "payoutSeller",
      completedSteps: ["begin", "settleWinnerHold"],
    });

    const payout = findEffect(result.effects, "account", "deposit");
    expect(payout).toBeDefined();
    expect(payout!.name).toBe("seller-1");
    expect(payout!.payload).toEqual({ amount: 100 });
    expect(payout!.replyTo).toMatchObject({
      handler: "payoutSeller_reply",
    });
  });

  test("payoutSeller success → notifyAuction → settlementComplete + completed", async () => {
    const { state: s1 } = await started();
    const afterSettle = await resolveSagaStep(settlementSaga, {
      selfName: "auction-1-settlement",
      state: s1,
      kind: "success",
      value: null,
    });
    if (afterSettle.outcome !== "success") throw new Error("expected success");

    const result = await resolveSagaStep(settlementSaga, {
      selfName: "auction-1-settlement",
      state: afterSettle.state,
      kind: "success",
      value: { newBalance: 100 },
    });
    if (result.outcome !== "success") throw new Error("expected success");
    const saga = settlementSaga.project!(result.state);
    expect(saga).toMatchObject({
      phase: "completed",
      currentStep: null,
      completedSteps: ["begin", "settleWinnerHold", "payoutSeller", "notifyAuction"],
      failedStep: null,
    });

    // notifyAuction fires settlementComplete at the auction.
    const complete = findEffect(result.effects, "auction", "settlementComplete");
    expect(complete).toBeDefined();
    expect(complete!.name).toBe("auction-1");
  });
});

// ── compensation: failure at settleWinnerHold ────────────────

describe("settlementSaga: compensation on settleWinnerHold failure", () => {
  test("fail walks back to begin.compensate → auction.settlementFailed", async () => {
    const { state } = await started();
    const result = await resolveSagaStep(settlementSaga, {
      selfName: "auction-1-settlement",
      state,
      kind: "fail",
      reason: "hold_not_found",
    });
    if (result.outcome !== "success") throw new Error("expected success");
    const saga = settlementSaga.project!(result.state);
    expect(saga).toMatchObject({
      phase: "failed",
      failedStep: "settleWinnerHold",
      failReason: "hold_not_found",
    });
    // settleWinnerHold itself wasn't marked completed (ask hadn't succeeded),
    // so its compensate (deposit refund) does NOT fire — there's nothing to
    // refund. Only `begin`'s compensate runs.
    const refund = findEffect(result.effects, "account", "deposit");
    expect(refund).toBeUndefined();

    const notify = findEffect(result.effects, "auction", "settlementFailed");
    expect(notify).toBeDefined();
    expect(notify!.name).toBe("auction-1");
    expect(notify!.payload).toEqual({ reason: "settlement_saga_failed" });
  });
});

// ── compensation: failure at payoutSeller ────────────────────

describe("settlementSaga: compensation on payoutSeller failure", () => {
  test("refund winner + notify auction settlementFailed", async () => {
    const { state: s1 } = await started();
    const afterSettle = await resolveSagaStep(settlementSaga, {
      selfName: "auction-1-settlement",
      state: s1,
      kind: "success",
      value: null,
    });
    if (afterSettle.outcome !== "success") throw new Error("expected success");

    const result = await resolveSagaStep(settlementSaga, {
      selfName: "auction-1-settlement",
      state: afterSettle.state,
      kind: "fail",
      reason: "seller_account_closed",
    });
    if (result.outcome !== "success") throw new Error("expected success");
    const saga = settlementSaga.project!(result.state);
    expect(saga).toMatchObject({
      phase: "failed",
      failedStep: "payoutSeller",
      failReason: "seller_account_closed",
    });

    // Compensation order: settleWinnerHold.compensate (refund winner via
    // deposit) then begin.compensate (notify auction).
    const deposits = result.effects.filter(
      (e) => e.actorType === "account" && e.msgType === "deposit",
    );
    expect(deposits).toHaveLength(1);
    expect(deposits[0].name).toBe("alice");
    expect(deposits[0].payload).toEqual({ amount: 100 });

    const notify = findEffect(result.effects, "auction", "settlementFailed");
    expect(notify).toBeDefined();
    expect(notify!.payload).toEqual({ reason: "settlement_saga_failed" });

    // Effects list is appended in compensation order: refund then notify.
    const refundIdx = result.effects.findIndex(
      (e) => e.actorType === "account" && e.msgType === "deposit",
    );
    const notifyIdx = result.effects.findIndex(
      (e) => e.actorType === "auction" && e.msgType === "settlementFailed",
    );
    expect(refundIdx).toBeLessThan(notifyIdx);
  });
});
