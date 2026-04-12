/// <reference types="vite/client" />
/**
 * Unit tests for `userBids`. Covers idempotency of `append` by
 * `idempotencyKey` — the bidSaga fires this call fire-and-forget from
 * its `holdFunds` step, and saga retries re-send with the same key.
 */
import { describe, expect, test } from "vitest";
import { invokeHandler } from "../components/actors/client/testing";
import { userBids } from "./userBids";

const T0 = 1_700_000_000_000;

describe("userBids.append", () => {
  test("appends a new bid with placedAt stamped from ctx.now()", async () => {
    const result = await invokeHandler(userBids, {
      msgType: "append",
      payload: { idempotencyKey: "k1", auctionName: "a1", amount: 50 },
      now: T0,
    });
    expect(result).toMatchObject({
      outcome: "success",
      state: {
        bids: [
          {
            idempotencyKey: "k1",
            auctionName: "a1",
            amount: 50,
            placedAt: T0,
          },
        ],
      },
    });
  });

  test("duplicate idempotencyKey is a no-op", async () => {
    const result = await invokeHandler(userBids, {
      msgType: "append",
      payload: { idempotencyKey: "k1", auctionName: "a1", amount: 999 },
      state: {
        bids: [
          { idempotencyKey: "k1", auctionName: "a1", amount: 50, placedAt: T0 },
        ],
      },
      now: T0 + 5000,
    });
    expect(result).toMatchObject({
      outcome: "success",
      state: {
        bids: [
          { idempotencyKey: "k1", auctionName: "a1", amount: 50, placedAt: T0 },
        ],
      },
    });
  });

  test("distinct keys accumulate in order", async () => {
    const result = await invokeHandler(userBids, {
      msgType: "append",
      payload: { idempotencyKey: "k2", auctionName: "a2", amount: 75 },
      state: {
        bids: [
          { idempotencyKey: "k1", auctionName: "a1", amount: 50, placedAt: T0 },
        ],
      },
      now: T0 + 1000,
    });
    if (result.outcome !== "success") throw new Error("expected success");
    expect(result.state.bids).toHaveLength(2);
    expect(result.state.bids[1]).toEqual({
      idempotencyKey: "k2",
      auctionName: "a2",
      amount: 75,
      placedAt: T0 + 1000,
    });
  });
});
