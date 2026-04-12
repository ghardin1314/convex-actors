/// <reference types="vite/client" />
/**
 * Unit tests for `auctionHouse` handler logic. Exercises createAuction
 * (name allocation + init-stub side effect), reportState aggregation
 * and the lazy health-check bootstrap, and checkHealth stuck-settling
 * detection + self-termination.
 */
import { z } from "zod";
import { describe, expect, test } from "vitest";
import { invokeHandler } from "../components/actors/client/testing";
import type { Effect } from "../components/actors/client";
import { auctionHouse } from "./auctionHouse";

const T0 = 1_700_000_000_000;

const ITEM = {
  title: "Rare Item",
  description: "A very rare item",
  imageUrl: "https://example.com/item.png",
};

type HouseState = z.infer<typeof auctionHouse.state>;

function initialState(overrides: Partial<HouseState> = {}): HouseState {
  return { ...auctionHouse.initialState(), ...overrides };
}

function findEffect(effects: Effect[], actorType: string, msgType: string) {
  return effects.find((e) => e.actorType === actorType && e.msgType === msgType);
}

// ── createAuction ─────────────────────────────────────────────

describe("auctionHouse.createAuction", () => {
  test("allocates a name, writes placeholder entry, emits init to the auction", async () => {
    const result = await invokeHandler(auctionHouse, {
      selfName: "main",
      now: T0,
      msgType: "createAuction",
      payload: { item: ITEM, seller: "seller-1", startingPrice: 10 },
    });
    if (result.outcome !== "success") throw new Error("expected success");

    expect(result.response).toEqual({ auctionName: "auction-1" });
    expect(result.state.nextAuctionId).toBe(2);
    expect(result.state.auctions["auction-1"]).toMatchObject({
      item: { title: ITEM.title, imageUrl: ITEM.imageUrl },
      seller: "seller-1",
      phase: "initializing",
      currentBid: null,
      endsAt: 0,
      lastUpdate: T0,
    });

    const init = findEffect(result.effects, "auction", "init");
    expect(init).toBeDefined();
    expect(init!.name).toBe("auction-1");
    expect(init!.payload).toMatchObject({
      item: ITEM,
      seller: "seller-1",
      startingPrice: 10,
    });
  });

  test("does NOT start the health-check loop", async () => {
    const result = await invokeHandler(auctionHouse, {
      selfName: "main",
      now: T0,
      msgType: "createAuction",
      payload: { item: ITEM, seller: "s", startingPrice: 10 },
    });
    if (result.outcome !== "success") throw new Error("expected success");
    expect(result.state.healthCheckScheduled).toBe(false);
    expect(findEffect(result.effects, "auctionHouse", "checkHealth"))
      .toBeUndefined();
  });

  test("sequential calls allocate distinct names", async () => {
    const first = await invokeHandler(auctionHouse, {
      selfName: "main",
      now: T0,
      msgType: "createAuction",
      payload: { item: ITEM, seller: "s1", startingPrice: 10 },
    });
    if (first.outcome !== "success") throw new Error("expected success");
    const second = await invokeHandler(auctionHouse, {
      selfName: "main",
      now: T0 + 100,
      msgType: "createAuction",
      payload: { item: ITEM, seller: "s2", startingPrice: 20 },
      state: first.state,
    });
    if (second.outcome !== "success") throw new Error("expected success");
    expect(second.response).toEqual({ auctionName: "auction-2" });
    expect(Object.keys(second.state.auctions).sort()).toEqual([
      "auction-1",
      "auction-2",
    ]);
  });
});

// ── reportState ───────────────────────────────────────────────

describe("auctionHouse.reportState", () => {
  function withOneAuction(overrides: Partial<HouseState> = {}) {
    return initialState({
      nextAuctionId: 2,
      auctions: {
        "auction-1": {
          item: { title: ITEM.title, imageUrl: ITEM.imageUrl },
          seller: "s",
          phase: "initializing",
          currentBid: null,
          endsAt: 0,
          lastUpdate: T0,
        },
      },
      ...overrides,
    });
  }

  test("updates the registry entry for a known auction", async () => {
    const result = await invokeHandler(auctionHouse, {
      selfName: "main",
      now: T0 + 1000,
      msgType: "reportState",
      payload: {
        auctionName: "auction-1",
        phase: "active",
        currentBid: null,
        endsAt: T0 + 50_000,
      },
      state: withOneAuction(),
    });
    if (result.outcome !== "success") throw new Error("expected success");
    expect(result.state.auctions["auction-1"]).toMatchObject({
      phase: "active",
      currentBid: null,
      endsAt: T0 + 50_000,
      lastUpdate: T0 + 1000,
    });
    expect(result.effects).toEqual([]);
  });

  test("unknown auctionName is a silent no-op", async () => {
    const result = await invokeHandler(auctionHouse, {
      selfName: "main",
      msgType: "reportState",
      payload: {
        auctionName: "unregistered",
        phase: "active",
        currentBid: null,
        endsAt: T0 + 1000,
      },
      state: initialState(),
    });
    if (result.outcome !== "success") throw new Error("expected success");
    expect(result.state.auctions).toEqual({});
    expect(result.effects).toEqual([]);
  });

  test("first settling report lazily boots the health-check loop", async () => {
    const result = await invokeHandler(auctionHouse, {
      selfName: "main",
      now: T0 + 1000,
      msgType: "reportState",
      payload: {
        auctionName: "auction-1",
        phase: "settling",
        currentBid: { bidder: "alice", amount: 100 },
        endsAt: T0 + 5000,
      },
      state: withOneAuction(),
    });
    if (result.outcome !== "success") throw new Error("expected success");
    expect(result.state.healthCheckScheduled).toBe(true);
    const check = findEffect(result.effects, "auctionHouse", "checkHealth");
    expect(check).toBeDefined();
    expect(check!.name).toBe("main");
    expect(check!.deliverAt).toBe(
      T0 + 1000 + result.state.healthCheckIntervalMs,
    );
  });

  test("second settling report does NOT re-arm an already-running loop", async () => {
    const result = await invokeHandler(auctionHouse, {
      selfName: "main",
      msgType: "reportState",
      payload: {
        auctionName: "auction-1",
        phase: "settling",
        currentBid: { bidder: "alice", amount: 100 },
        endsAt: T0,
      },
      state: withOneAuction({ healthCheckScheduled: true }),
    });
    if (result.outcome !== "success") throw new Error("expected success");
    expect(findEffect(result.effects, "auctionHouse", "checkHealth"))
      .toBeUndefined();
  });
});

// ── checkHealth ────────────────────────────────────────────────

describe("auctionHouse.checkHealth", () => {
  function withSettlingAuction(lastUpdate: number, overrides: Partial<HouseState> = {}) {
    return initialState({
      healthCheckScheduled: true,
      auctions: {
        "auction-1": {
          item: { title: ITEM.title, imageUrl: ITEM.imageUrl },
          seller: "s",
          phase: "settling",
          currentBid: { bidder: "alice", amount: 100 },
          endsAt: T0,
          lastUpdate,
        },
      },
      ...overrides,
    });
  }

  test("flags an auction stuck past the threshold", async () => {
    const state = withSettlingAuction(T0);
    const now = T0 + state.stuckSettlingThresholdMs + 1_000;
    const result = await invokeHandler(auctionHouse, {
      selfName: "main",
      now,
      msgType: "checkHealth",
      payload: {},
      state,
    });
    if (result.outcome !== "success") throw new Error("expected success");
    expect(result.state.stuckAlerts).toHaveLength(1);
    expect(result.state.stuckAlerts[0]).toMatchObject({
      auctionName: "auction-1",
      reason: "stuck_settling",
      ts: now,
    });
    // Still settling → re-arm the loop.
    expect(findEffect(result.effects, "auctionHouse", "checkHealth"))
      .toBeDefined();
  });

  test("does not flag within the threshold", async () => {
    const state = withSettlingAuction(T0);
    const result = await invokeHandler(auctionHouse, {
      selfName: "main",
      now: T0 + 1000,
      msgType: "checkHealth",
      payload: {},
      state,
    });
    if (result.outcome !== "success") throw new Error("expected success");
    expect(result.state.stuckAlerts).toEqual([]);
    // Still settling → loop re-armed.
    expect(findEffect(result.effects, "auctionHouse", "checkHealth"))
      .toBeDefined();
  });

  test("de-dupes repeated alerts for the same stuck lastUpdate", async () => {
    const state = withSettlingAuction(T0, {
      stuckAlerts: [
        { auctionName: "auction-1", reason: "stuck_settling", ts: T0 + 80_000 },
      ],
    });
    const now = T0 + state.stuckSettlingThresholdMs + 25_000;
    const result = await invokeHandler(auctionHouse, {
      selfName: "main",
      now,
      msgType: "checkHealth",
      payload: {},
      state,
    });
    if (result.outcome !== "success") throw new Error("expected success");
    // Existing alert is newer than lastUpdate → no duplicate appended.
    expect(result.state.stuckAlerts).toHaveLength(1);
  });

  test("no settling auctions → loop self-terminates (no reschedule)", async () => {
    const state = initialState({
      healthCheckScheduled: true,
      auctions: {
        "auction-1": {
          item: { title: ITEM.title, imageUrl: ITEM.imageUrl },
          seller: "s",
          phase: "sold",
          currentBid: { bidder: "alice", amount: 100 },
          endsAt: T0,
          lastUpdate: T0,
        },
      },
    });
    const result = await invokeHandler(auctionHouse, {
      selfName: "main",
      now: T0 + 1000,
      msgType: "checkHealth",
      payload: {},
      state,
    });
    if (result.outcome !== "success") throw new Error("expected success");
    expect(result.state.healthCheckScheduled).toBe(false);
    expect(findEffect(result.effects, "auctionHouse", "checkHealth"))
      .toBeUndefined();
  });
});

// ── projection ────────────────────────────────────────────────

describe("auctionHouse.project", () => {
  test("projects listings + count + stuckAlerts", () => {
    const state = initialState({
      nextAuctionId: 3,
      auctions: {
        "auction-1": {
          item: { title: "a", imageUrl: "a.png" },
          seller: "s1",
          phase: "active",
          currentBid: null,
          endsAt: T0 + 1000,
          lastUpdate: T0,
        },
        "auction-2": {
          item: { title: "b", imageUrl: "b.png" },
          seller: "s2",
          phase: "sold",
          currentBid: { bidder: "alice", amount: 100 },
          endsAt: T0 + 2000,
          lastUpdate: T0,
        },
      },
      stuckAlerts: [
        { auctionName: "auction-3", reason: "stuck_settling", ts: T0 },
      ],
    });
    const view = auctionHouse.project!(state);
    expect(view.count).toBe(2);
    expect(view.listings.map((l) => l.name).sort()).toEqual([
      "auction-1",
      "auction-2",
    ]);
    expect(view.stuckAlerts).toHaveLength(1);
  });
});
