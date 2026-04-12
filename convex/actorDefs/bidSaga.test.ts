/// <reference types="vite/client" />
/**
 * Unit tests for `bidSaga`. Drives the saga through `invokeHandler`
 * (for the `start` message) and `resolveSagaStep` (for each awaited ask
 * reply), inspecting the framework-owned `_saga` internals and the
 * emitted effects at each step.
 */
import { describe, expect, test } from "vitest";
import {
  invokeHandler,
  resolveSagaStep,
} from "../components/actors/client/testing";
import type { Effect } from "../components/actors/client";
import { bidSaga } from "./bidSaga";

const INPUT = { bidder: "alice", auctionName: "auction-1", amount: 50 };

function findEffect(effects: Effect[], actorType: string, msgType: string) {
  return effects.find((e) => e.actorType === actorType && e.msgType === msgType);
}

// ── start ─────────────────────────────────────────────────────

describe("bidSaga.start", () => {
  test("transitions to running and emits hold ask + userBids append", async () => {
    const result = await invokeHandler(bidSaga, {
      selfName: "bid-1",
      msgType: "start",
      payload: INPUT,
    });
    if (result.outcome !== "success") {
      throw new Error(`expected success, got ${result.outcome}`);
    }
    const saga = bidSaga.project!(result.state);
    expect(saga).toMatchObject({
      phase: "running",
      currentStep: "holdFunds",
      completedSteps: [], // ask step not marked completed until reply
    });

    // Fire-and-forget send to userBids (idempotent append).
    const append = findEffect(result.effects, "userBids", "append");
    expect(append).toBeDefined();
    expect(append!.name).toBe("alice");
    expect(append!.payload).toEqual({
      idempotencyKey: "bid-1",
      auctionName: "auction-1",
      amount: 50,
    });
    expect(append!.replyTo).toBeUndefined();

    // Ask to account.hold with replyTo pointing at holdFunds_reply.
    const hold = findEffect(result.effects, "account", "hold");
    expect(hold).toBeDefined();
    expect(hold!.name).toBe("alice");
    expect(hold!.payload).toEqual({
      holdId: "hold-bid-1",
      amount: 50,
    });
    expect(hold!.replyTo).toMatchObject({
      actorType: "bidSaga",
      name: "bid-1",
      handler: "holdFunds_reply",
    });
  });

  test("starting an already-running saga fails with saga_already_started", async () => {
    const first = await invokeHandler(bidSaga, {
      selfName: "bid-1",
      msgType: "start",
      payload: INPUT,
    });
    if (first.outcome !== "success") throw new Error("expected success");

    const second = await invokeHandler(bidSaga, {
      selfName: "bid-1",
      msgType: "start",
      payload: INPUT,
      state: first.state,
    });
    expect(second).toMatchObject({
      outcome: "fail",
      reason: "saga_already_started",
      details: { currentPhase: "running" },
    });
  });
});

// ── holdFunds ask reply ───────────────────────────────────────

describe("bidSaga: holdFunds ask reply", () => {
  async function started() {
    const result = await invokeHandler(bidSaga, {
      selfName: "bid-1",
      msgType: "start",
      payload: INPUT,
    });
    if (result.outcome !== "success") throw new Error("expected success");
    return result.state;
  }

  test("success advances to placeBid and emits auction.bid ask", async () => {
    const state = await started();
    const result = await resolveSagaStep(bidSaga, {
      selfName: "bid-1",
      state,
      kind: "success",
      value: null,
    });
    if (result.outcome !== "success") throw new Error("expected success");

    const saga = bidSaga.project!(result.state);
    expect(saga).toMatchObject({
      phase: "running",
      currentStep: "placeBid",
      completedSteps: ["holdFunds"],
    });

    const bid = findEffect(result.effects, "auction", "bid");
    expect(bid).toBeDefined();
    expect(bid!.name).toBe("auction-1");
    expect(bid!.payload).toEqual({
      bidder: "alice",
      amount: 50,
      holdId: "hold-bid-1",
    });
    expect(bid!.replyTo).toMatchObject({
      actorType: "bidSaga",
      name: "bid-1",
      handler: "placeBid_reply",
    });
  });

  test("fail (insufficient_funds) → failed, no compensation (nothing completed)", async () => {
    const state = await started();
    const result = await resolveSagaStep(bidSaga, {
      selfName: "bid-1",
      state,
      kind: "fail",
      reason: "insufficient_funds",
    });
    if (result.outcome !== "success") throw new Error("expected success");

    const saga = bidSaga.project!(result.state);
    expect(saga).toMatchObject({
      phase: "failed",
      currentStep: null,
      completedSteps: [],
      failedStep: "holdFunds",
      failReason: "insufficient_funds",
    });
    // No holds were ever placed → holdFunds.compensate should not fire a
    // releaseHold effect, because compensate only walks *completed* steps.
    expect(findEffect(result.effects, "account", "releaseHold"))
      .toBeUndefined();
  });

  test("resolving an already-completed saga throws a clear error", async () => {
    const state = await started();
    const afterHold = await resolveSagaStep(bidSaga, {
      selfName: "bid-1",
      state,
      kind: "success",
      value: null,
    });
    if (afterHold.outcome !== "success") throw new Error("expected success");
    const afterPlace = await resolveSagaStep(bidSaga, {
      selfName: "bid-1",
      state: afterHold.state,
      kind: "success",
      value: null,
    });
    if (afterPlace.outcome !== "success") throw new Error("expected success");
    // Saga is completed — no ask is pending. resolveSagaStep should reject.
    await expect(
      resolveSagaStep(bidSaga, {
        selfName: "bid-1",
        state: afterPlace.state,
        kind: "success",
        value: null,
      }),
    ).rejects.toThrow(/not awaiting an ask reply/);
  });
});

// ── placeBid ask reply ───────────────────────────────────────

describe("bidSaga: placeBid ask reply", () => {
  async function afterHoldSuccess() {
    const started = await invokeHandler(bidSaga, {
      selfName: "bid-1",
      msgType: "start",
      payload: INPUT,
    });
    if (started.outcome !== "success") throw new Error("expected success");
    const afterHold = await resolveSagaStep(bidSaga, {
      selfName: "bid-1",
      state: started.state,
      kind: "success",
      value: null,
    });
    if (afterHold.outcome !== "success") throw new Error("expected success");
    return afterHold.state;
  }

  test("success completes the saga (no more effects)", async () => {
    const state = await afterHoldSuccess();
    const result = await resolveSagaStep(bidSaga, {
      selfName: "bid-1",
      state,
      kind: "success",
      value: null,
    });
    if (result.outcome !== "success") throw new Error("expected success");
    const saga = bidSaga.project!(result.state);
    expect(saga).toMatchObject({
      phase: "completed",
      currentStep: null,
      completedSteps: ["holdFunds", "placeBid"],
      failedStep: null,
    });
    expect(result.effects).toEqual([]);
  });

  test("fail (bid_too_low) walks back to holdFunds.compensate → releaseHold", async () => {
    const state = await afterHoldSuccess();
    const result = await resolveSagaStep(bidSaga, {
      selfName: "bid-1",
      state,
      kind: "fail",
      reason: "bid_too_low",
    });
    if (result.outcome !== "success") throw new Error("expected success");
    const saga = bidSaga.project!(result.state);
    expect(saga).toMatchObject({
      phase: "failed",
      currentStep: null,
      failedStep: "placeBid",
      failReason: "bid_too_low",
    });

    const release = findEffect(result.effects, "account", "releaseHold");
    expect(release).toBeDefined();
    expect(release!.name).toBe("alice");
    expect(release!.payload).toEqual({ holdId: "hold-bid-1" });
  });

  test("defect kind is treated as a failure with the defect message", async () => {
    const state = await afterHoldSuccess();
    const result = await resolveSagaStep(bidSaga, {
      selfName: "bid-1",
      state,
      kind: "defect",
      error: "kaboom",
    });
    if (result.outcome !== "success") throw new Error("expected success");
    const saga = bidSaga.project!(result.state);
    expect(saga.phase).toBe("failed");
    expect(saga.failReason).toBe("kaboom");
    expect(findEffect(result.effects, "account", "releaseHold")).toBeDefined();
  });
});
