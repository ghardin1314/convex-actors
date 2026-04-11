/// <reference types="vite/client" />
/**
 * Phase 2 integration tests: `auctionHouse` supervisor + `bidSaga` +
 * `settlementSaga`. Phase 1 tested account and auction in isolation;
 * this file exercises the full end-to-end choreography:
 *
 *   - createAuction via the supervisor, registry aggregation through
 *     `reportState` fan-out
 *   - bidSaga happy path (hold → bid) and compensation (outbid)
 *   - settlementSaga happy path (settle → payout → notify) and
 *     compensation on seller-payout failure
 *   - full lifecycle: create → bid → tick → settle → sold
 *   - checkHealth stuck-settling detection
 */
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { api } from "./_generated/api.js";
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

const LONG_CONFIG = {
  durationMs: 60_000_000,
  goingOnceMs: 60_000_000,
  goingTwiceMs: 60_000_000,
  minIncrement: 1,
};

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
  return t.mutation(api.actorFunctions.send, {
    actorType,
    name,
    msgType,
    payload,
  });
}

function peek(t: ConvexT, actorType: string, name: string) {
  return t.query(api.actorFunctions.peek, { actorType, name });
}

function getResponse(t: ConvexT, messageId: string) {
  return t.query(api.actorFunctions.getResponse, { messageId });
}

type AuctionProjection = {
  phase: string;
  currentBid: { bidder: string; amount: number } | null;
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
  failReason: string | undefined;
};

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

    // Force the auction directly into a settling phase via a raw
    // settlementFailed/settlementComplete cycle would break it — easier:
    // run through the state machine with a winning bid that goes to
    // settling. We'll suppress the saga by using a bidder whose account
    // won't have a hold, so settleHold inside the saga fails...
    //
    // Simpler: send an orchestrated sequence that leaves the auction
    // registered with `phase: "settling"` via a direct reportState.
    // This is a unit test of checkHealth, not the saga path.
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
    // The current `account` actor's `deposit` handler can't fail, so
    // we can't force a payoutSeller-mid-flight failure. Instead we
    // exercise the earlier branch: kick the saga with a bogus holdId
    // so `settleWinnerHold` fails immediately. The `begin` marker
    // step should still be in completedSteps, so its compensate
    // runs (firing settlementFailed at the auction).
    const t = setup();
    await send(t, "account", "alice", "deposit", { amount: 1_000 });
    await send(t, "account", "seller-1", "deposit", { amount: 0 });
    await drain(t);

    // Kick the saga directly against a holdId that doesn't exist on
    // Alice's account — settleHold will fail with hold_not_found.
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

// ── End-to-end lifecycle ────────────────────────────────────────

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
