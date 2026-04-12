/// <reference types="vite/client" />
/**
 * Integration tests for the auction demo. Covers account + auction actors
 * in isolation, supervisor + sagas, and full end-to-end lifecycle.
 */
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { internal } from "./_generated/api.js";
import schema from "./schema.js";
import componentSchema from "./components/actors/schema.js";

const appModules = import.meta.glob("./**/*.ts");
const componentModules = import.meta.glob("./components/actors/**/*.ts");

const T0 = 1_700_000_000_000;

const ITEM = {
  title: "Rare Item",
  description: "A very rare item",
  imageUrl: "https://example.com/item.png",
};

// Durations long enough that `drain` completes well before the first
// tick fires — use when you want to observe a particular phase.
const LONG_CONFIG = {
  durationMs: 60_000_000,
  goingOnceMs: 60_000_000,
  goingTwiceMs: 60_000_000,
  minIncrement: 1,
};

// Short config that lets the tick chain drive all the way to
// expired / settling within a single drain.
const SHORT_CONFIG = {
  durationMs: 2_000,
  goingOnceMs: 2_000,
  goingTwiceMs: 2_000,
  minIncrement: 1,
};

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

type ConvexT = ReturnType<typeof convexTest>;

/** Advance fake timers + drain the scheduled function queue. */
async function drain(t: ConvexT) {
  await t.finishAllScheduledFunctions(() => {
    vi.advanceTimersByTime(1000);
  });
}

function send(
  t: ConvexT,
  actorType: string,
  name: string,
  msgType: string,
  payload: unknown,
) {
  return t.mutation(internal.testHelpers.send, {
    actorType,
    name,
    msgType,
    payload,
  });
}

function peek(t: ConvexT, actorType: string, name: string) {
  return t.query(internal.testHelpers.peek, { actorType, name });
}

function getResponse(t: ConvexT, messageId: string) {
  return t.query(internal.testHelpers.getResponse, { messageId });
}

type AuctionProjection = {
  phase: string;
  currentBid: { bidder: string; amount: number } | null;
  previousBids: Array<{ bidder: string; amount: number; ts: number }>;
  phaseStartedAt: number;
  phaseEndsAt: number | null;
  expectedEndAt: number | null;
  settlementFailureReason: string | null;
};

type AuctionHouseProjection = {
  listings: Array<{
    name: string;
    phase: string;
    currentBid: { bidder: string; amount: number } | null;
    endsAt: number;
  }>;
  count: number;
  stuckAlerts: Array<{ auctionName: string; reason: string; ts: number }>;
};

type SagaProjection = {
  phase: "idle" | "running" | "completed" | "failed";
  currentStep: string | null;
  completedSteps: string[];
  failedStep: string | null;
  failReason: string | undefined;
};

// ── account ─────────────────────────────────────────────────────

describe("account", () => {
  test("deposit increases balance and availableBalance", async () => {
    const t = setup();
    await send(t, "account", "alice", "deposit", { amount: 100 });
    await drain(t);
    const state = await peek(t, "account", "alice");
    expect(state).toEqual({
      balance: 100,
      availableBalance: 100,
    });
  });

  test("hold reserves funds — availableBalance drops, balance unchanged", async () => {
    const t = setup();
    await send(t, "account", "alice", "deposit", { amount: 100 });
    await send(t, "account", "alice", "hold", { holdId: "h1", amount: 40 });
    await drain(t);
    const state = await peek(t, "account", "alice");
    expect(state).toMatchObject({ balance: 100, availableBalance: 60 });
  });

  test("hold fails when insufficient available funds", async () => {
    const t = setup();
    await send(t, "account", "alice", "deposit", { amount: 50 });
    await drain(t);
    const msgId = await send(t, "account", "alice", "hold", {
      holdId: "h1",
      amount: 100,
    });
    await drain(t);
    const response = await getResponse(t, msgId);
    expect(response!.response).toMatchObject({
      kind: "fail",
      reason: "insufficient_funds",
    });
    const state = await peek(t, "account", "alice");
    expect(state).toMatchObject({ balance: 50, availableBalance: 50 });
  });

  test("hold fails when combined holds exceed available", async () => {
    const t = setup();
    await send(t, "account", "alice", "deposit", { amount: 100 });
    await send(t, "account", "alice", "hold", { holdId: "h1", amount: 60 });
    await drain(t);
    const msgId = await send(t, "account", "alice", "hold", {
      holdId: "h2",
      amount: 50,
    });
    await drain(t);
    const response = await getResponse(t, msgId);
    expect(response!.response).toMatchObject({
      kind: "fail",
      reason: "insufficient_funds",
    });
  });

  test("releaseHold restores available balance", async () => {
    const t = setup();
    await send(t, "account", "alice", "deposit", { amount: 100 });
    await send(t, "account", "alice", "hold", { holdId: "h1", amount: 40 });
    await send(t, "account", "alice", "releaseHold", { holdId: "h1" });
    await drain(t);
    const state = await peek(t, "account", "alice");
    expect(state).toMatchObject({ balance: 100, availableBalance: 100 });
  });

  test("releaseHold on unknown holdId is a no-op", async () => {
    const t = setup();
    await send(t, "account", "alice", "deposit", { amount: 100 });
    const msgId = await send(t, "account", "alice", "releaseHold", {
      holdId: "ghost",
    });
    await drain(t);
    const response = await getResponse(t, msgId);
    expect(response!.response).toMatchObject({ kind: "success" });
  });

  test("settleHold debits balance and clears hold", async () => {
    const t = setup();
    await send(t, "account", "alice", "deposit", { amount: 100 });
    await send(t, "account", "alice", "hold", { holdId: "h1", amount: 40 });
    await send(t, "account", "alice", "settleHold", { holdId: "h1" });
    await drain(t);
    const state = await peek(t, "account", "alice");
    expect(state).toMatchObject({ balance: 60, availableBalance: 60 });
  });

  test("settleHold on unknown holdId fails", async () => {
    const t = setup();
    await send(t, "account", "alice", "deposit", { amount: 100 });
    const msgId = await send(t, "account", "alice", "settleHold", {
      holdId: "nope",
    });
    await drain(t);
    const response = await getResponse(t, msgId);
    expect(response!.response).toMatchObject({
      kind: "fail",
      reason: "hold_not_found",
    });
  });
});

// ── auction init + bidding ─────────────────────────────────────

describe("auction: init and bidding", () => {
  test("init transitions to active", async () => {
    const t = setup();
    await send(t, "auction", "a1", "init", {
      item: ITEM,
      seller: "seller-1",
      startingPrice: 10,
      config: LONG_CONFIG,
    });
    await drain(t);
    const state = await peek(t, "auction", "a1");
    expect(state).toMatchObject({
      phase: "active",
      item: ITEM,
      currentBid: null,
      previousBids: [],
    });
  });

  test("re-initializing an already-active auction fails", async () => {
    const t = setup();
    await send(t, "auction", "a2", "init", {
      item: ITEM,
      seller: "s",
      startingPrice: 10,
      config: LONG_CONFIG,
    });
    await drain(t);
    const msgId = await send(t, "auction", "a2", "init", {
      item: ITEM,
      seller: "s",
      startingPrice: 20,
    });
    await drain(t);
    const response = await getResponse(t, msgId);
    expect(response!.response).toMatchObject({
      kind: "fail",
      reason: "already_initialized",
    });
  });

  test("bid below starting price fails", async () => {
    const t = setup();
    await send(t, "auction", "a3", "init", {
      item: ITEM,
      seller: "s",
      startingPrice: 50,
      config: LONG_CONFIG,
    });
    await drain(t);
    const msgId = await send(t, "auction", "a3", "bid", {
      bidder: "alice",
      amount: 20,
      holdId: "h1",
    });
    await drain(t);
    const response = await getResponse(t, msgId);
    expect(response!.response).toMatchObject({
      kind: "fail",
      reason: "bid_too_low",
    });
  });

  test("bid below min increment above current bid fails", async () => {
    const t = setup();
    await send(t, "account", "alice", "deposit", { amount: 1_000 });
    await send(t, "auction", "a4", "init", {
      item: ITEM,
      seller: "s",
      startingPrice: 10,
      config: { ...LONG_CONFIG, minIncrement: 5 },
    });
    await send(t, "account", "alice", "hold", {
      holdId: "alice-h1",
      amount: 50,
    });
    await send(t, "auction", "a4", "bid", {
      bidder: "alice",
      amount: 50,
      holdId: "alice-h1",
    });
    await drain(t);
    // A later 52 is too low (need 50 + 5 = 55)
    const msgId = await send(t, "auction", "a4", "bid", {
      bidder: "bob",
      amount: 52,
      holdId: "bob-h1",
    });
    await drain(t);
    const response = await getResponse(t, msgId);
    expect(response!.response).toMatchObject({
      kind: "fail",
      reason: "bid_too_low",
    });
    const a = await peek(t, "auction", "a4");
    expect(a).toMatchObject({
      currentBid: { bidder: "alice", amount: 50 },
    });
  });

  test("displacing bid releases the previous bidder's hold", async () => {
    const t = setup();
    await send(t, "account", "alice", "deposit", { amount: 1_000 });
    await send(t, "account", "bob", "deposit", { amount: 1_000 });
    await send(t, "auction", "a5", "init", {
      item: ITEM,
      seller: "s",
      startingPrice: 10,
      config: LONG_CONFIG,
    });
    await send(t, "account", "alice", "hold", {
      holdId: "alice-h1",
      amount: 50,
    });
    await send(t, "auction", "a5", "bid", {
      bidder: "alice",
      amount: 50,
      holdId: "alice-h1",
    });
    await drain(t);

    // Bob displaces alice.
    await send(t, "account", "bob", "hold", {
      holdId: "bob-h1",
      amount: 60,
    });
    await send(t, "auction", "a5", "bid", {
      bidder: "bob",
      amount: 60,
      holdId: "bob-h1",
    });
    await drain(t);

    const alice = await peek(t, "account", "alice");
    const bobAcc = await peek(t, "account", "bob");
    const auctionState = (await peek(
      t,
      "auction",
      "a5",
    )) as AuctionProjection;

    // Alice's 50 hold should have been released — available back to 1000.
    expect(alice).toMatchObject({ balance: 1000, availableBalance: 1000 });
    expect(bobAcc).toMatchObject({ balance: 1000, availableBalance: 940 });
    expect(auctionState).toMatchObject({
      currentBid: { bidder: "bob", amount: 60 },
    });
    expect(auctionState.previousBids).toHaveLength(1);
    expect(auctionState.previousBids[0]).toMatchObject({
      bidder: "alice",
      amount: 50,
    });
  });
});

// ── state machine: timer-driven transitions ────────────────────

describe("auction: state machine", () => {
  test("no bids: active → going_once → going_twice → expired", async () => {
    const t = setup();
    await send(t, "auction", "a6", "init", {
      item: ITEM,
      seller: "s",
      startingPrice: 10,
      config: SHORT_CONFIG,
    });
    await drain(t);
    const state = await peek(t, "auction", "a6");
    expect(state).toMatchObject({ phase: "expired", currentBid: null });
  });

  test("winning bid drives through settlement to sold", async () => {
    const t = setup();
    await send(t, "account", "alice", "deposit", { amount: 1_000 });
    await send(t, "account", "seller-1", "deposit", { amount: 0 });
    await send(t, "account", "alice", "hold", {
      holdId: "alice-h1",
      amount: 100,
    });
    await send(t, "auction", "a7", "init", {
      item: ITEM,
      seller: "seller-1",
      startingPrice: 10,
      config: SHORT_CONFIG,
    });
    // Bid before drain — the message is queued with deliverAt=now, will
    // be processed in the same drain sweep as init → active.
    await send(t, "auction", "a7", "bid", {
      bidder: "alice",
      amount: 100,
      holdId: "alice-h1",
    });
    await drain(t);

    // The going_twice tick kicks off settlementSaga which drains
    // all the way through to `sold`.
    const state = await peek(t, "auction", "a7");
    expect(state).toMatchObject({
      phase: "sold",
      currentBid: { bidder: "alice", amount: 100 },
    });
    // Winner's hold is settled (debited), seller credited.
    const alice = await peek(t, "account", "alice");
    expect(alice).toMatchObject({ balance: 900, availableBalance: 900 });
    const seller = await peek(t, "account", "seller-1");
    expect(seller).toMatchObject({ balance: 100, availableBalance: 100 });
  });

  test("bid rejected once auction has expired (phase_closed)", async () => {
    const t = setup();
    await send(t, "account", "alice", "deposit", { amount: 1_000 });
    await send(t, "auction", "a9", "init", {
      item: ITEM,
      seller: "s",
      startingPrice: 10,
      config: SHORT_CONFIG,
    });
    // Drain all ticks → expired (no bid was placed).
    await drain(t);

    await send(t, "account", "alice", "hold", {
      holdId: "late-h1",
      amount: 50,
    });
    const msgId = await send(t, "auction", "a9", "bid", {
      bidder: "alice",
      amount: 50,
      holdId: "late-h1",
    });
    await drain(t);
    const response = await getResponse(t, msgId);
    expect(response!.response).toMatchObject({
      kind: "fail",
      reason: "phase_closed",
    });
  });
});

// ── projection: phaseEndsAt vs expectedEndAt ────────────────────

describe("auction: countdown projection", () => {
  test(
    "phaseEndsAt / expectedEndAt track phase transitions",
    async () => {
      const t = setup();
      // Drain advances fake time by a couple of seconds, so the init
      // handler runs at some `ctx.now()` in [beforeInit, afterInit].
      // Assert on the relationship between phaseEndsAt and expectedEndAt
      // rather than absolute values.
      const beforeInit = Date.now();
      await send(t, "auction", "p1", "init", {
        item: ITEM,
        seller: "s",
        startingPrice: 10,
        config: LONG_CONFIG,
      });
      await drain(t);
      const afterInit = Date.now();

      // active: phaseEnds at durationMs, expectedEnds adds goingOnce+goingTwice.
      let state = (await peek(t, "auction", "p1")) as AuctionProjection;
      expect(state.phase).toBe("active");
      expect(state.phaseEndsAt!).toBeGreaterThanOrEqual(
        beforeInit + LONG_CONFIG.durationMs,
      );
      expect(state.phaseEndsAt!).toBeLessThanOrEqual(
        afterInit + LONG_CONFIG.durationMs,
      );
      expect(state.expectedEndAt).toBe(
        state.phaseEndsAt! +
          LONG_CONFIG.goingOnceMs +
          LONG_CONFIG.goingTwiceMs,
      );

      // Force active → going_once. phaseEnds is goingOnceMs out,
      // expectedEnds adds goingTwiceMs.
      const beforeGoingOnce = Date.now();
      await send(t, "auction", "p1", "tick", { epoch: 0 });
      await drain(t);
      const afterGoingOnce = Date.now();
      state = (await peek(t, "auction", "p1")) as AuctionProjection;
      expect(state.phase).toBe("going_once");
      // The handler stamps ctx.now() which is the drain's invocation
      // time — bounded between the times we captured around the call.
      expect(state.phaseEndsAt!).toBeGreaterThanOrEqual(
        beforeGoingOnce + LONG_CONFIG.goingOnceMs,
      );
      expect(state.phaseEndsAt!).toBeLessThanOrEqual(
        afterGoingOnce + LONG_CONFIG.goingOnceMs,
      );
      expect(state.expectedEndAt).toBe(
        state.phaseEndsAt! + LONG_CONFIG.goingTwiceMs,
      );

      // going_once → going_twice. phaseEnds == expectedEnds (last phase).
      await send(t, "auction", "p1", "tick", { epoch: 1 });
      await drain(t);
      state = (await peek(t, "auction", "p1")) as AuctionProjection;
      expect(state.phase).toBe("going_twice");
      expect(state.expectedEndAt).toBe(state.phaseEndsAt);
    },
  );

  test("terminal phases expose null countdown fields", async () => {
    const t = setup();
    await send(t, "auction", "p2", "init", {
      item: ITEM,
      seller: "s",
      startingPrice: 10,
      config: SHORT_CONFIG,
    });
    await drain(t);
    const state = (await peek(t, "auction", "p2")) as AuctionProjection;
    expect(state).toMatchObject({
      phase: "expired",
      phaseEndsAt: null,
      expectedEndAt: null,
    });
  });
});

// ── tick handler: epoch-based stale rejection ──────────────────

describe("auction: tick epoch guard", () => {
  test("tick with stale epoch is dropped", async () => {
    const t = setup();
    await send(t, "auction", "e1", "init", {
      item: ITEM,
      seller: "s",
      startingPrice: 10,
      config: LONG_CONFIG,
    });
    await drain(t);
    // Current tickEpoch is 0; send a bogus high-epoch tick which won't match.
    await send(t, "auction", "e1", "tick", { epoch: 999 });
    await drain(t);
    const state = await peek(t, "auction", "e1");
    expect(state).toMatchObject({ phase: "active" });
  });

  test("tick with current epoch advances the state machine", async () => {
    const t = setup();
    await send(t, "auction", "e2", "init", {
      item: ITEM,
      seller: "s",
      startingPrice: 10,
      config: LONG_CONFIG,
    });
    await drain(t);
    // epoch=0 matches; should drive active → going_once.
    await send(t, "auction", "e2", "tick", { epoch: 0 });
    await drain(t);
    const state = await peek(t, "auction", "e2");
    expect(state).toMatchObject({ phase: "going_once" });
  });
});

// ── snipe protection ───────────────────────────────────────────

describe("auction: snipe protection", () => {
  test("late bid during going_once extends endsAt and keeps phase", async () => {
    const t = setup();
    await send(t, "account", "alice", "deposit", { amount: 1_000 });
    await send(t, "account", "alice", "hold", {
      holdId: "alice-h1",
      amount: 100,
    });
    await send(t, "auction", "s1", "init", {
      item: ITEM,
      seller: "s",
      startingPrice: 10,
      config: LONG_CONFIG,
    });
    await drain(t);

    // Force a transition into going_once by sending a matching-epoch
    // tick directly. This avoids juggling fake-timer windows.
    await send(t, "auction", "s1", "tick", { epoch: 0 });
    await drain(t);

    const before = (await peek(t, "auction", "s1")) as AuctionProjection;
    expect(before).toMatchObject({ phase: "going_once" });
    const phaseEndsAtBefore = before.phaseEndsAt!;
    const expectedEndAtBefore = before.expectedEndAt!;

    // Advance the wall clock a bit so the timestamps are measurably
    // shifted when the snipe-triggered bid recomputes them.
    vi.advanceTimersByTime(100);

    await send(t, "auction", "s1", "bid", {
      bidder: "alice",
      amount: 50,
      holdId: "alice-h1",
    });
    await drain(t);

    const after = (await peek(t, "auction", "s1")) as AuctionProjection;
    expect(after).toMatchObject({
      phase: "going_once",
      currentBid: { bidder: "alice", amount: 50 },
    });
    // Both timers extend forward (snipe extension).
    expect(after.phaseEndsAt!).toBeGreaterThan(phaseEndsAtBefore);
    expect(after.expectedEndAt!).toBeGreaterThan(expectedEndAtBefore);
  });

  test("stale tick at the old endsAt is dropped after snipe reset", async () => {
    const t = setup();
    await send(t, "account", "alice", "deposit", { amount: 1_000 });
    await send(t, "account", "alice", "hold", {
      holdId: "alice-h1",
      amount: 100,
    });
    await send(t, "auction", "s2", "init", {
      item: ITEM,
      seller: "s",
      startingPrice: 10,
      config: LONG_CONFIG,
    });
    await drain(t);

    // Advance to going_once via a direct tick (epoch 0).
    await send(t, "auction", "s2", "tick", { epoch: 0 });
    await drain(t);
    // epoch is now 1 (bumped when active → going_once).

    // Snipe-bid during going_once — this bumps epoch to 2 and resets
    // the timer.
    await send(t, "auction", "s2", "bid", {
      bidder: "alice",
      amount: 50,
      holdId: "alice-h1",
    });
    await drain(t);

    // Now simulate the originally-queued stale tick firing. It has
    // epoch=1 (the epoch that was stamped when going_once was entered),
    // but state.tickEpoch is now 2 → handler should ignore it.
    await send(t, "auction", "s2", "tick", { epoch: 1 });
    await drain(t);

    const state = await peek(t, "auction", "s2");
    expect(state).toMatchObject({
      phase: "going_once",
      currentBid: { bidder: "alice", amount: 50 },
    });
  });
});

// ── direct account↔auction bid flow ────────────────────────────

describe("auction: direct account↔auction bid flow", () => {
  test("displacing bid releases the losing bidder's hold across actors", async () => {
    const t = setup();
    await send(t, "account", "alice", "deposit", { amount: 1_000 });
    await send(t, "account", "bob", "deposit", { amount: 1_000 });
    await send(t, "auction", "duel", "init", {
      item: ITEM,
      seller: "seller-1",
      startingPrice: 10,
      config: LONG_CONFIG,
    });
    await drain(t);

    // Bob holds and bids.
    await send(t, "account", "bob", "hold", {
      holdId: "bob-h1",
      amount: 50,
    });
    await send(t, "auction", "duel", "bid", {
      bidder: "bob",
      amount: 50,
      holdId: "bob-h1",
    });
    await drain(t);

    let bob = await peek(t, "account", "bob");
    expect(bob).toMatchObject({ availableBalance: 950 });

    // Alice out-bids bob. Auction sends releaseHold back to bob's account.
    await send(t, "account", "alice", "hold", {
      holdId: "alice-h1",
      amount: 75,
    });
    await send(t, "auction", "duel", "bid", {
      bidder: "alice",
      amount: 75,
      holdId: "alice-h1",
    });
    await drain(t);

    bob = await peek(t, "account", "bob");
    const alice = await peek(t, "account", "alice");
    const auctionState = (await peek(
      t,
      "auction",
      "duel",
    )) as AuctionProjection;

    expect(bob).toMatchObject({ balance: 1000, availableBalance: 1000 });
    expect(alice).toMatchObject({ balance: 1000, availableBalance: 925 });
    expect(auctionState.currentBid).toEqual({ bidder: "alice", amount: 75 });
    expect(auctionState.previousBids).toHaveLength(1);
    expect(auctionState.previousBids[0]).toMatchObject({
      bidder: "bob",
      amount: 50,
    });
  });
});

// ── auctionHouse: createAuction + registry ──────────────────────

describe("auctionHouse: createAuction and registry", () => {
  test("createAuction allocates a name and stubs the auction actor", async () => {
    const t = setup();

    const msgId = await send(t, "auctionHouse", "main", "createAuction", {
      item: ITEM,
      seller: "seller-1",
      startingPrice: 10,
      config: LONG_CONFIG,
    });
    await drain(t);

    // createAuction returns the allocated auction name.
    const response = await getResponse(t, msgId);
    expect(response!.response).toMatchObject({
      kind: "success",
      value: { auctionName: "auction-1" },
    });

    // The auction actor was initialized by the supervisor.
    const auctionState = (await peek(
      t,
      "auction",
      "auction-1",
    )) as AuctionProjection;
    expect(auctionState).toMatchObject({ phase: "active", currentBid: null });

    // And the supervisor has the auction in its registry with the
    // post-init phase — reportState fired back from auction → house.
    const house = (await peek(
      t,
      "auctionHouse",
      "main",
    )) as AuctionHouseProjection;
    expect(house.count).toBe(1);
    expect(house.listings[0]).toMatchObject({
      name: "auction-1",
      phase: "active",
      currentBid: null,
    });
    expect(house.listings[0].endsAt).toBeGreaterThan(T0);
  });

  test("registry reflects bids as they land via reportState", async () => {
    const t = setup();
    await send(t, "account", "alice", "deposit", { amount: 1_000 });
    await send(t, "auctionHouse", "main", "createAuction", {
      item: ITEM,
      seller: "seller-1",
      startingPrice: 10,
      config: LONG_CONFIG,
    });
    await drain(t);

    await send(t, "account", "alice", "hold", {
      holdId: "alice-h1",
      amount: 50,
    });
    await send(t, "auction", "auction-1", "bid", {
      bidder: "alice",
      amount: 50,
      holdId: "alice-h1",
    });
    await drain(t);

    const house = (await peek(
      t,
      "auctionHouse",
      "main",
    )) as AuctionHouseProjection;
    expect(house.listings[0]).toMatchObject({
      phase: "active",
      currentBid: { bidder: "alice", amount: 50 },
    });
  });

  test("sequential createAuction calls get distinct auction names", async () => {
    const t = setup();
    await send(t, "auctionHouse", "main", "createAuction", {
      item: ITEM,
      seller: "s1",
      startingPrice: 10,
      config: LONG_CONFIG,
    });
    await send(t, "auctionHouse", "main", "createAuction", {
      item: ITEM,
      seller: "s2",
      startingPrice: 20,
      config: LONG_CONFIG,
    });
    await drain(t);

    const house = (await peek(
      t,
      "auctionHouse",
      "main",
    )) as AuctionHouseProjection;
    expect(house.count).toBe(2);
    const names = house.listings.map((l) => l.name).sort();
    expect(names).toEqual(["auction-1", "auction-2"]);
  });
});

// ── auctionHouse: checkHealth ───────────────────────────────────

describe("auctionHouse: checkHealth", () => {
  test("flags an auction stuck in settling for > threshold", async () => {
    const t = setup();
    await send(t, "auctionHouse", "main", "createAuction", {
      item: ITEM,
      seller: "s",
      startingPrice: 10,
      config: LONG_CONFIG,
    });
    await drain(t);

    // Force the auction into settling via a direct reportState — this
    // is a unit test of checkHealth, not the saga path.
    await send(t, "auctionHouse", "main", "reportState", {
      auctionName: "auction-1",
      phase: "settling",
      currentBid: { bidder: "alice", amount: 100 },
      endsAt: T0 + 1000,
    });
    await drain(t);

    // Advance virtual time past the stuck threshold (default 60 s) so
    // the next checkHealth sees lastUpdate as stale.
    vi.setSystemTime(T0 + 120_000);
    await send(t, "auctionHouse", "main", "checkHealth", {});
    await drain(t);

    const house = (await peek(
      t,
      "auctionHouse",
      "main",
    )) as AuctionHouseProjection;
    expect(house.stuckAlerts).toHaveLength(1);
    expect(house.stuckAlerts[0]).toMatchObject({
      auctionName: "auction-1",
      reason: "stuck_settling",
    });
  });

  test("does not flag a settling auction within the threshold", async () => {
    const t = setup();
    await send(t, "auctionHouse", "main", "createAuction", {
      item: ITEM,
      seller: "s",
      startingPrice: 10,
      config: LONG_CONFIG,
    });
    await drain(t);
    await send(t, "auctionHouse", "main", "reportState", {
      auctionName: "auction-1",
      phase: "settling",
      currentBid: { bidder: "alice", amount: 100 },
      endsAt: T0 + 1000,
    });
    await drain(t);

    // Advance only a little — well under the 60s default threshold.
    vi.setSystemTime(T0 + 5_000);
    await send(t, "auctionHouse", "main", "checkHealth", {});
    await drain(t);

    const house = (await peek(
      t,
      "auctionHouse",
      "main",
    )) as AuctionHouseProjection;
    expect(house.stuckAlerts).toEqual([]);
  });
});

// ── bidSaga ─────────────────────────────────────────────────────

describe("bidSaga: hold → bid flow", () => {
  test("successful bid: hold placed, auction updated, saga completed", async () => {
    const t = setup();
    await send(t, "account", "alice", "deposit", { amount: 1_000 });
    await send(t, "auctionHouse", "main", "createAuction", {
      item: ITEM,
      seller: "s",
      startingPrice: 10,
      config: LONG_CONFIG,
    });
    await drain(t);

    await send(t, "bidSaga", "bid-1", "start", {
      bidder: "alice",
      auctionName: "auction-1",
      amount: 50,
    });
    await drain(t);

    const saga = (await peek(t, "bidSaga", "bid-1")) as SagaProjection;
    expect(saga).toMatchObject({ phase: "completed" });
    expect(saga.completedSteps).toEqual(["holdFunds", "placeBid"]);

    const alice = await peek(t, "account", "alice");
    expect(alice).toMatchObject({ balance: 1000, availableBalance: 950 });

    const auctionState = (await peek(
      t,
      "auction",
      "auction-1",
    )) as AuctionProjection;
    expect(auctionState.currentBid).toEqual({ bidder: "alice", amount: 50 });
  });

  test("bid rejection triggers compensation (releaseHold)", async () => {
    const t = setup();
    await send(t, "account", "alice", "deposit", { amount: 1_000 });
    await send(t, "account", "bob", "deposit", { amount: 1_000 });
    await send(t, "auctionHouse", "main", "createAuction", {
      item: ITEM,
      seller: "s",
      startingPrice: 10,
      config: { ...LONG_CONFIG, minIncrement: 10 },
    });
    await drain(t);

    // Alice establishes the current bid at 100.
    await send(t, "bidSaga", "bid-alice", "start", {
      bidder: "alice",
      auctionName: "auction-1",
      amount: 100,
    });
    await drain(t);

    // Bob bids too low (needs at least 110) — saga should fail in
    // placeBid and roll back holdFunds.
    await send(t, "bidSaga", "bid-bob", "start", {
      bidder: "bob",
      auctionName: "auction-1",
      amount: 105,
    });
    await drain(t);

    const sagaBob = (await peek(
      t,
      "bidSaga",
      "bid-bob",
    )) as SagaProjection;
    expect(sagaBob).toMatchObject({
      phase: "failed",
      failReason: "bid_too_low",
    });

    // Bob's hold should have been compensated — full available balance.
    const bob = await peek(t, "account", "bob");
    expect(bob).toMatchObject({ balance: 1000, availableBalance: 1000 });

    // Alice's bid still stands on the auction.
    const auctionState = (await peek(
      t,
      "auction",
      "auction-1",
    )) as AuctionProjection;
    expect(auctionState.currentBid).toEqual({ bidder: "alice", amount: 100 });
  });

  test("insufficient funds fails the saga with no compensation needed", async () => {
    const t = setup();
    await send(t, "account", "poor", "deposit", { amount: 5 });
    await send(t, "auctionHouse", "main", "createAuction", {
      item: ITEM,
      seller: "s",
      startingPrice: 10,
      config: LONG_CONFIG,
    });
    await drain(t);

    await send(t, "bidSaga", "bid-poor", "start", {
      bidder: "poor",
      auctionName: "auction-1",
      amount: 50,
    });
    await drain(t);

    const saga = (await peek(
      t,
      "bidSaga",
      "bid-poor",
    )) as SagaProjection;
    expect(saga).toMatchObject({
      phase: "failed",
      failReason: "insufficient_funds",
    });
    // No hold was ever placed — source account untouched.
    const poor = await peek(t, "account", "poor");
    expect(poor).toMatchObject({ balance: 5, availableBalance: 5 });
  });
});

// ── settlementSaga ──────────────────────────────────────────────

describe("settlementSaga: settle → payout → notify", () => {
  test("successful settlement: winner debited, seller credited, auction sold", async () => {
    const t = setup();
    await send(t, "account", "alice", "deposit", { amount: 1_000 });
    await send(t, "account", "seller-1", "deposit", { amount: 0 });
    await drain(t);

    // Queue createAuction and the bidSaga together — if we drain between
    // them the auction's tick chain races ahead through the SHORT_CONFIG
    // budget and reaches `expired` before the bid lands. Sending both
    // before the first drain keeps the bid ahead of the first tick.
    await send(t, "auctionHouse", "main", "createAuction", {
      item: ITEM,
      seller: "seller-1",
      startingPrice: 10,
      config: SHORT_CONFIG,
    });
    await send(t, "bidSaga", "bid-1", "start", {
      bidder: "alice",
      auctionName: "auction-1",
      amount: 100,
    });
    await drain(t);

    // Auction should have reached `sold` via the settlementSaga.
    const auctionState = (await peek(
      t,
      "auction",
      "auction-1",
    )) as AuctionProjection;
    expect(auctionState.phase).toBe("sold");

    const alice = await peek(t, "account", "alice");
    expect(alice).toMatchObject({ balance: 900, availableBalance: 900 });

    const seller = await peek(t, "account", "seller-1");
    expect(seller).toMatchObject({ balance: 100, availableBalance: 100 });

    // Supervisor reflects the terminal sold phase.
    const house = (await peek(
      t,
      "auctionHouse",
      "main",
    )) as AuctionHouseProjection;
    expect(house.listings[0].phase).toBe("sold");
  });

  test("settleHold failure fails the saga and compensation chain runs", async () => {
    // Kick the saga with a bogus holdId so `settleWinnerHold` fails
    // immediately. The `begin` marker step should still be in
    // completedSteps, so its compensate runs (firing settlementFailed
    // at the auction).
    const t = setup();
    await send(t, "account", "alice", "deposit", { amount: 1_000 });
    await send(t, "account", "seller-1", "deposit", { amount: 0 });
    await drain(t);

    await send(t, "settlementSaga", "orphan-settle", "start", {
      auctionName: "nonexistent-auction",
      winner: "alice",
      seller: "seller-1",
      amount: 100,
      holdId: "bogus-hold-id",
    });
    await drain(t);

    const saga = (await peek(
      t,
      "settlementSaga",
      "orphan-settle",
    )) as SagaProjection;
    expect(saga).toMatchObject({
      phase: "failed",
      failReason: "hold_not_found",
    });
    // begin (the sync marker step) is in completedSteps — it ran and
    // pushed itself before settleWinnerHold was even attempted. Its
    // compensate was invoked as part of the failure walk.
    expect(saga.completedSteps).toContain("begin");

    // Neither account moved — nothing was settled or deposited.
    const alice = await peek(t, "account", "alice");
    expect(alice).toMatchObject({ balance: 1000 });
    const seller = await peek(t, "account", "seller-1");
    expect(seller).toMatchObject({ balance: 0 });
  });
});

// ── end-to-end lifecycle ────────────────────────────────────────

describe("end-to-end auction lifecycle via supervisor + sagas", () => {
  test("create → bid → snipe → settle → sold, registry reflects each step", async () => {
    const t = setup();
    await send(t, "account", "alice", "deposit", { amount: 1_000 });
    await send(t, "account", "bob", "deposit", { amount: 1_000 });
    await send(t, "account", "seller-1", "deposit", { amount: 0 });

    // Create via the supervisor.
    await send(t, "auctionHouse", "main", "createAuction", {
      item: ITEM,
      seller: "seller-1",
      startingPrice: 10,
      config: { ...LONG_CONFIG, minIncrement: 5 },
    });
    await drain(t);

    // Bob bids 50 via the bid saga.
    await send(t, "bidSaga", "bob-bid-1", "start", {
      bidder: "bob",
      auctionName: "auction-1",
      amount: 50,
    });
    await drain(t);

    // Alice displaces Bob at 60 via another bid saga.
    await send(t, "bidSaga", "alice-bid-1", "start", {
      bidder: "alice",
      auctionName: "auction-1",
      amount: 60,
    });
    await drain(t);

    // Bob's hold should have been released (displaced bidder path
    // inside the auction actor).
    const bob = await peek(t, "account", "bob");
    expect(bob).toMatchObject({ balance: 1000, availableBalance: 1000 });

    // Registry reflects Alice's leading bid.
    const houseMid = (await peek(
      t,
      "auctionHouse",
      "main",
    )) as AuctionHouseProjection;
    expect(houseMid.listings[0]).toMatchObject({
      phase: "active",
      currentBid: { bidder: "alice", amount: 60 },
    });

    // Force the auction through its tick timeline via direct tick
    // sends — avoids juggling 60-million-ms fake timers.
    await send(t, "auction", "auction-1", "tick", { epoch: 0 });
    await drain(t);
    await send(t, "auction", "auction-1", "tick", { epoch: 1 });
    await drain(t);
    // going_twice tick with a bid: kicks the settlementSaga
    await send(t, "auction", "auction-1", "tick", { epoch: 2 });
    await drain(t);

    // End state: auction sold, alice debited, seller credited.
    const auctionState = (await peek(
      t,
      "auction",
      "auction-1",
    )) as AuctionProjection;
    expect(auctionState.phase).toBe("sold");
    expect(auctionState.currentBid).toEqual({ bidder: "alice", amount: 60 });

    const alice = await peek(t, "account", "alice");
    expect(alice).toMatchObject({ balance: 940, availableBalance: 940 });

    const seller = await peek(t, "account", "seller-1");
    expect(seller).toMatchObject({ balance: 60, availableBalance: 60 });

    // Supervisor shows the terminal sold phase.
    const houseFinal = (await peek(
      t,
      "auctionHouse",
      "main",
    )) as AuctionHouseProjection;
    expect(houseFinal.listings[0].phase).toBe("sold");
  });

  test("expired auction (no bid): supervisor reflects terminal phase", async () => {
    const t = setup();
    await send(t, "auctionHouse", "main", "createAuction", {
      item: ITEM,
      seller: "s",
      startingPrice: 10,
      config: SHORT_CONFIG,
    });
    await drain(t);

    // With SHORT_CONFIG, the tick chain drives straight to expired.
    const auctionState = (await peek(
      t,
      "auction",
      "auction-1",
    )) as AuctionProjection;
    expect(auctionState.phase).toBe("expired");

    const house = (await peek(
      t,
      "auctionHouse",
      "main",
    )) as AuctionHouseProjection;
    expect(house.listings[0].phase).toBe("expired");
  });
});
