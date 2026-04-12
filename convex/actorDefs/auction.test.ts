/// <reference types="vite/client" />
/**
 * Unit tests for `auction` handler logic. Uses `invokeHandler` to run
 * each handler against a caller-supplied state and inspect the emitted
 * effects (scheduled self-ticks, reportState fan-out, releaseHold
 * fire-and-forgets, saga kickoffs).
 *
 * The tests deliberately avoid the drain loop so each transition can be
 * asserted on in isolation — state before/after + effect list.
 */
import { z } from "zod";
import { describe, expect, test } from "vitest";
import { invokeHandler } from "../components/actors/client/testing";
import type { Effect } from "../components/actors/client";
import { auction } from "./auction";

const T0 = 1_700_000_000_000;

const ITEM = {
  title: "Rare Item",
  description: "Something rare",
  imageUrl: "https://example.com/rare.png",
};

const CONFIG = {
  durationMs: 30_000,
  goingOnceMs: 10_000,
  goingTwiceMs: 10_000,
  minIncrement: 1,
};

type AuctionState = z.infer<typeof auction.state>;

function initialState(overrides: Partial<AuctionState> = {}): AuctionState {
  return {
    ...auction.initialState(),
    ...overrides,
  };
}

function activeState(overrides: Partial<AuctionState> = {}): AuctionState {
  return initialState({
    phase: "active",
    item: ITEM,
    seller: "seller-1",
    startingPrice: 10,
    config: CONFIG,
    phaseStartedAt: T0,
    ...overrides,
  });
}

function findEffect(effects: Effect[], actorType: string, msgType: string) {
  return effects.find((e) => e.actorType === actorType && e.msgType === msgType);
}

// ── init ──────────────────────────────────────────────────────

describe("auction.init", () => {
  test("initializing → active with config, schedules first tick, reports state", async () => {
    const result = await invokeHandler(auction, {
      selfName: "a1",
      now: T0,
      msgType: "init",
      payload: {
        item: ITEM,
        seller: "seller-1",
        startingPrice: 10,
        config: CONFIG,
      },
    });
    if (result.outcome !== "success") throw new Error("expected success");
    expect(result.state).toMatchObject({
      phase: "active",
      item: ITEM,
      seller: "seller-1",
      startingPrice: 10,
      config: CONFIG,
      phaseStartedAt: T0,
      tickEpoch: 0,
    });
    // Two effects: self.tick at T0+duration, reportState to auctionHouse:main
    const tick = findEffect(result.effects, "auction", "tick");
    expect(tick).toBeDefined();
    expect(tick!.name).toBe("a1");
    expect(tick!.deliverAt).toBe(T0 + CONFIG.durationMs);
    expect(tick!.payload).toEqual({ epoch: 0 });

    const report = findEffect(result.effects, "auctionHouse", "reportState");
    expect(report).toBeDefined();
    expect(report!.name).toBe("main");
    expect(report!.payload).toMatchObject({
      auctionName: "a1",
      phase: "active",
      currentBid: null,
    });
  });

  test("uses default config when config is omitted", async () => {
    const result = await invokeHandler(auction, {
      selfName: "a1",
      now: T0,
      msgType: "init",
      payload: { item: ITEM, seller: "s", startingPrice: 10 },
    });
    if (result.outcome !== "success") throw new Error("expected success");
    expect(result.state.config).toEqual({
      durationMs: 30_000,
      goingOnceMs: 10_000,
      goingTwiceMs: 10_000,
      minIncrement: 1,
    });
  });

  test("already-initialized fails with already_initialized", async () => {
    const result = await invokeHandler(auction, {
      selfName: "a1",
      msgType: "init",
      payload: { item: ITEM, seller: "s", startingPrice: 10 },
      state: activeState(),
    });
    expect(result).toMatchObject({
      outcome: "fail",
      reason: "already_initialized",
      details: { currentPhase: "active" },
    });
  });
});

// ── bid: validation ──────────────────────────────────────────

describe("auction.bid: validation", () => {
  test("fails with phase_closed in non-biddable phase", async () => {
    const result = await invokeHandler(auction, {
      selfName: "a1",
      msgType: "bid",
      payload: { bidder: "alice", amount: 100, holdId: "h1" },
      state: activeState({ phase: "expired" }),
    });
    expect(result).toMatchObject({
      outcome: "fail",
      reason: "phase_closed",
      details: { phase: "expired" },
    });
  });

  test("fails with bid_too_low when under starting price", async () => {
    const result = await invokeHandler(auction, {
      selfName: "a1",
      msgType: "bid",
      payload: { bidder: "alice", amount: 5, holdId: "h1" },
      state: activeState({ startingPrice: 10 }),
    });
    expect(result).toMatchObject({
      outcome: "fail",
      reason: "bid_too_low",
      details: { amount: 5, minAmount: 10 },
    });
  });

  test("fails with bid_too_low when under current bid + minIncrement", async () => {
    const state = activeState({
      startingPrice: 10,
      config: { ...CONFIG, minIncrement: 5 },
      currentBid: { bidder: "alice", amount: 50, holdId: "h1", ts: T0 },
    });
    const result = await invokeHandler(auction, {
      selfName: "a1",
      msgType: "bid",
      payload: { bidder: "bob", amount: 52, holdId: "h2" },
      state,
    });
    expect(result).toMatchObject({
      outcome: "fail",
      reason: "bid_too_low",
      details: { amount: 52, minAmount: 55 },
    });
  });
});

// ── bid: acceptance ──────────────────────────────────────────

describe("auction.bid: acceptance", () => {
  test("accepts opening bid, records currentBid, reports state", async () => {
    const result = await invokeHandler(auction, {
      selfName: "a1",
      now: T0 + 500,
      msgType: "bid",
      payload: { bidder: "alice", amount: 50, holdId: "h1" },
      state: activeState(),
    });
    if (result.outcome !== "success") throw new Error("expected success");
    expect(result.state.currentBid).toEqual({
      bidder: "alice",
      amount: 50,
      holdId: "h1",
      ts: T0 + 500,
    });
    expect(result.state.previousBids).toEqual([]);
    // No releaseHold on opening bid — there is no previous bidder.
    expect(findEffect(result.effects, "account", "releaseHold")).toBeUndefined();
    expect(findEffect(result.effects, "auctionHouse", "reportState"))
      .toBeDefined();
  });

  test("displacing bid archives the loser and releases their hold", async () => {
    const state = activeState({
      currentBid: { bidder: "alice", amount: 50, holdId: "alice-h1", ts: T0 },
    });
    const result = await invokeHandler(auction, {
      selfName: "a1",
      now: T0 + 1000,
      msgType: "bid",
      payload: { bidder: "bob", amount: 60, holdId: "bob-h1" },
      state,
    });
    if (result.outcome !== "success") throw new Error("expected success");
    expect(result.state.currentBid).toEqual({
      bidder: "bob",
      amount: 60,
      holdId: "bob-h1",
      ts: T0 + 1000,
    });
    expect(result.state.previousBids).toHaveLength(1);
    expect(result.state.previousBids[0]).toMatchObject({
      bidder: "alice",
      amount: 50,
      ts: T0, // carries original placement time, not displacement time
    });
    const release = findEffect(result.effects, "account", "releaseHold");
    expect(release).toBeDefined();
    expect(release!.name).toBe("alice");
    expect(release!.payload).toEqual({ holdId: "alice-h1" });
  });
});

// ── bid: snipe protection ────────────────────────────────────

describe("auction.bid: snipe protection", () => {
  test("late bid in going_once bumps epoch, resets timer, stays going_once", async () => {
    const state = activeState({
      phase: "going_once",
      tickEpoch: 1,
      phaseStartedAt: T0,
    });
    const result = await invokeHandler(auction, {
      selfName: "a1",
      now: T0 + 5_000,
      msgType: "bid",
      payload: { bidder: "alice", amount: 50, holdId: "h1" },
      state,
    });
    if (result.outcome !== "success") throw new Error("expected success");
    expect(result.state.phase).toBe("going_once");
    expect(result.state.tickEpoch).toBe(2);
    expect(result.state.phaseStartedAt).toBe(T0 + 5_000);
    const tick = findEffect(result.effects, "auction", "tick");
    expect(tick).toBeDefined();
    expect(tick!.name).toBe("a1");
    expect(tick!.payload).toEqual({ epoch: 2 });
    expect(tick!.deliverAt).toBe(T0 + 5_000 + CONFIG.goingOnceMs);
  });

  test("late bid in going_twice snaps phase back to going_once", async () => {
    const state = activeState({
      phase: "going_twice",
      tickEpoch: 2,
      phaseStartedAt: T0,
    });
    const result = await invokeHandler(auction, {
      selfName: "a1",
      now: T0 + 5_000,
      msgType: "bid",
      payload: { bidder: "alice", amount: 50, holdId: "h1" },
      state,
    });
    if (result.outcome !== "success") throw new Error("expected success");
    expect(result.state.phase).toBe("going_once");
    expect(result.state.tickEpoch).toBe(3);
    const tick = findEffect(result.effects, "auction", "tick");
    expect(tick!.deliverAt).toBe(T0 + 5_000 + CONFIG.goingOnceMs);
  });

  test("bid in active does NOT reset the tick timer", async () => {
    const result = await invokeHandler(auction, {
      selfName: "a1",
      now: T0 + 5_000,
      msgType: "bid",
      payload: { bidder: "alice", amount: 50, holdId: "h1" },
      state: activeState({ tickEpoch: 0 }),
    });
    if (result.outcome !== "success") throw new Error("expected success");
    // No new self.tick effect (the scheduled active-phase tick is still valid).
    expect(findEffect(result.effects, "auction", "tick")).toBeUndefined();
    expect(result.state.tickEpoch).toBe(0);
  });
});

// ── tick: epoch guard and transitions ──────────────────────────

describe("auction.tick", () => {
  test("stale epoch is dropped without state change", async () => {
    const state = activeState({ tickEpoch: 5 });
    const result = await invokeHandler(auction, {
      selfName: "a1",
      msgType: "tick",
      payload: { epoch: 1 },
      state,
    });
    expect(result.outcome).toBe("success");
    if (result.outcome !== "success") throw new Error("expected success");
    expect(result.state.phase).toBe("active");
    expect(result.effects).toEqual([]);
  });

  test("active → going_once schedules next tick + reports", async () => {
    const result = await invokeHandler(auction, {
      selfName: "a1",
      now: T0 + CONFIG.durationMs,
      msgType: "tick",
      payload: { epoch: 0 },
      state: activeState({ tickEpoch: 0 }),
    });
    if (result.outcome !== "success") throw new Error("expected success");
    expect(result.state.phase).toBe("going_once");
    expect(result.state.tickEpoch).toBe(1);
    const tick = findEffect(result.effects, "auction", "tick");
    expect(tick!.payload).toEqual({ epoch: 1 });
    expect(tick!.deliverAt).toBe(T0 + CONFIG.durationMs + CONFIG.goingOnceMs);
    expect(findEffect(result.effects, "auctionHouse", "reportState"))
      .toBeDefined();
  });

  test("going_once → going_twice schedules next tick", async () => {
    const result = await invokeHandler(auction, {
      selfName: "a1",
      now: T0,
      msgType: "tick",
      payload: { epoch: 1 },
      state: activeState({ phase: "going_once", tickEpoch: 1 }),
    });
    if (result.outcome !== "success") throw new Error("expected success");
    expect(result.state.phase).toBe("going_twice");
    expect(result.state.tickEpoch).toBe(2);
    const tick = findEffect(result.effects, "auction", "tick");
    expect(tick!.payload).toEqual({ epoch: 2 });
    expect(tick!.deliverAt).toBe(T0 + CONFIG.goingTwiceMs);
  });

  test("going_twice with no bid → expired, no saga kicked", async () => {
    const result = await invokeHandler(auction, {
      selfName: "a1",
      now: T0,
      msgType: "tick",
      payload: { epoch: 2 },
      state: activeState({
        phase: "going_twice",
        tickEpoch: 2,
        currentBid: null,
      }),
    });
    if (result.outcome !== "success") throw new Error("expected success");
    expect(result.state.phase).toBe("expired");
    expect(findEffect(result.effects, "settlementSaga", "start"))
      .toBeUndefined();
  });

  test("going_twice with a bid → settling + settlementSaga.start emitted", async () => {
    const state = activeState({
      phase: "going_twice",
      tickEpoch: 2,
      currentBid: {
        bidder: "alice",
        amount: 100,
        holdId: "alice-h1",
        ts: T0,
      },
    });
    const result = await invokeHandler(auction, {
      selfName: "a1",
      now: T0 + 500,
      msgType: "tick",
      payload: { epoch: 2 },
      state,
    });
    if (result.outcome !== "success") throw new Error("expected success");
    expect(result.state.phase).toBe("settling");
    const start = findEffect(result.effects, "settlementSaga", "start");
    expect(start).toBeDefined();
    expect(start!.name).toBe("a1-settlement");
    expect(start!.payload).toEqual({
      auctionName: "a1",
      winner: "alice",
      seller: "seller-1",
      amount: 100,
      holdId: "alice-h1",
    });
  });

  test("tick in a terminal phase is a no-op", async () => {
    const result = await invokeHandler(auction, {
      selfName: "a1",
      msgType: "tick",
      payload: { epoch: 3 },
      state: activeState({ phase: "sold", tickEpoch: 3 }),
    });
    if (result.outcome !== "success") throw new Error("expected success");
    expect(result.state.phase).toBe("sold");
    expect(result.effects).toEqual([]);
  });
});

// ── settlementComplete / settlementFailed ────────────────────

describe("auction settlement callbacks", () => {
  test("settlementComplete in settling → sold + reports state", async () => {
    const result = await invokeHandler(auction, {
      selfName: "a1",
      now: T0 + 1000,
      msgType: "settlementComplete",
      payload: {},
      state: activeState({ phase: "settling" }),
    });
    if (result.outcome !== "success") throw new Error("expected success");
    expect(result.state.phase).toBe("sold");
    expect(result.state.phaseStartedAt).toBe(T0 + 1000);
    const report = findEffect(result.effects, "auctionHouse", "reportState");
    expect(report!.payload).toMatchObject({ phase: "sold" });
  });

  test("settlementComplete outside settling is silently dropped", async () => {
    const result = await invokeHandler(auction, {
      selfName: "a1",
      msgType: "settlementComplete",
      payload: {},
      state: activeState({ phase: "sold" }),
    });
    if (result.outcome !== "success") throw new Error("expected success");
    expect(result.state.phase).toBe("sold");
    expect(result.effects).toEqual([]);
  });

  test("settlementFailed in settling → settlement_failed with reason", async () => {
    const result = await invokeHandler(auction, {
      selfName: "a1",
      now: T0 + 1000,
      msgType: "settlementFailed",
      payload: { reason: "settlement_saga_failed" },
      state: activeState({ phase: "settling" }),
    });
    if (result.outcome !== "success") throw new Error("expected success");
    expect(result.state.phase).toBe("settlement_failed");
    expect(result.state.settlementFailureReason).toBe("settlement_saga_failed");
    expect(findEffect(result.effects, "auctionHouse", "reportState"))
      .toBeDefined();
  });

  test("settlementFailed outside settling is dropped", async () => {
    const result = await invokeHandler(auction, {
      selfName: "a1",
      msgType: "settlementFailed",
      payload: { reason: "stale" },
      state: activeState({ phase: "sold" }),
    });
    if (result.outcome !== "success") throw new Error("expected success");
    expect(result.state.phase).toBe("sold");
    expect(result.state.settlementFailureReason).toBeNull();
    expect(result.effects).toEqual([]);
  });
});

// ── projection ────────────────────────────────────────────────

describe("auction.project", () => {
  test("minNextBid is startingPrice before any bids", () => {
    const view = auction.project!(activeState({ startingPrice: 25 }));
    expect(view.minNextBid).toBe(25);
  });

  test("minNextBid is currentBid + minIncrement after a bid", () => {
    const view = auction.project!(
      activeState({
        startingPrice: 10,
        config: { ...CONFIG, minIncrement: 5 },
        currentBid: {
          bidder: "alice",
          amount: 50,
          holdId: "h1",
          ts: T0,
        },
      }),
    );
    expect(view.minNextBid).toBe(55);
  });

  test("phaseEndsAt / expectedEndAt are null in terminal phases", () => {
    const sold = auction.project!(activeState({ phase: "sold" }));
    expect(sold.phaseEndsAt).toBeNull();
    expect(sold.expectedEndAt).toBeNull();

    const failed = auction.project!(
      activeState({ phase: "settlement_failed" }),
    );
    expect(failed.phaseEndsAt).toBeNull();
    expect(failed.expectedEndAt).toBeNull();
  });

  test("expectedEndAt sums remaining phase budgets in active", () => {
    const view = auction.project!(
      activeState({ phase: "active", phaseStartedAt: T0 }),
    );
    expect(view.phaseEndsAt).toBe(T0 + CONFIG.durationMs);
    expect(view.expectedEndAt).toBe(
      T0 + CONFIG.durationMs + CONFIG.goingOnceMs + CONFIG.goingTwiceMs,
    );
  });

  test("expectedEndAt equals phaseEndsAt in going_twice", () => {
    const view = auction.project!(
      activeState({ phase: "going_twice", phaseStartedAt: T0 }),
    );
    expect(view.phaseEndsAt).toBe(T0 + CONFIG.goingTwiceMs);
    expect(view.expectedEndAt).toBe(T0 + CONFIG.goingTwiceMs);
  });
});
