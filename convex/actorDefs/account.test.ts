/// <reference types="vite/client" />
/**
 * Unit tests for `account` handler logic. Runs each handler through
 * `invokeHandler` — no convex-test, no drain, no DB. Each test builds
 * whatever starting state it needs and inspects the returned state
 * + fail reason directly.
 */
import { describe, expect, test } from "vitest";
import { invokeHandler } from "../components/actors/client/testing";
import { account } from "./account";

const T0 = 1_700_000_000_000;

const base = account.initialState();

describe("account.deposit", () => {
  test("credits balance", async () => {
    const result = await invokeHandler(account, {
      msgType: "deposit",
      payload: { amount: 100 },
      now: T0,
    });
    expect(result).toMatchObject({
      outcome: "success",
      state: { balance: 100, holds: {} },
      effects: [],
    });
  });

  test("accumulates across multiple deposits (caller threads state)", async () => {
    const first = await invokeHandler(account, {
      msgType: "deposit",
      payload: { amount: 60 },
    });
    if (first.outcome !== "success") throw new Error("expected success");
    const second = await invokeHandler(account, {
      msgType: "deposit",
      payload: { amount: 40 },
      state: first.state,
    });
    expect(second).toMatchObject({
      outcome: "success",
      state: { balance: 100 },
    });
  });
});

describe("account.hold", () => {
  test("reserves funds under the hold id", async () => {
    const result = await invokeHandler(account, {
      msgType: "hold",
      payload: { holdId: "h1", amount: 40 },
      state: { ...base, balance: 100, holds: {} },
    });
    expect(result).toMatchObject({
      outcome: "success",
      state: { balance: 100, holds: { h1: 40 } },
    });
  });

  test("duplicate hold id fails with hold_exists", async () => {
    const result = await invokeHandler(account, {
      msgType: "hold",
      payload: { holdId: "h1", amount: 20 },
      state: { balance: 100, holds: { h1: 40 } },
    });
    expect(result).toMatchObject({
      outcome: "fail",
      reason: "hold_exists",
      details: { holdId: "h1" },
    });
    // State preserved on fail.
    expect((result as { state: unknown }).state).toEqual({
      balance: 100,
      holds: { h1: 40 },
    });
  });

  test("insufficient funds fails with amounts in details", async () => {
    const result = await invokeHandler(account, {
      msgType: "hold",
      payload: { holdId: "h2", amount: 80 },
      state: { balance: 100, holds: { h1: 40 } },
    });
    expect(result).toMatchObject({
      outcome: "fail",
      reason: "insufficient_funds",
      details: { requested: 80, available: 60 },
    });
  });

  test("exact-available hold succeeds", async () => {
    const result = await invokeHandler(account, {
      msgType: "hold",
      payload: { holdId: "h2", amount: 60 },
      state: { balance: 100, holds: { h1: 40 } },
    });
    expect(result).toMatchObject({
      outcome: "success",
      state: { balance: 100, holds: { h1: 40, h2: 60 } },
    });
  });
});

describe("account.releaseHold", () => {
  test("removes the named hold", async () => {
    const result = await invokeHandler(account, {
      msgType: "releaseHold",
      payload: { holdId: "h1" },
      state: { balance: 100, holds: { h1: 40, h2: 20 } },
    });
    expect(result).toMatchObject({
      outcome: "success",
      state: { balance: 100, holds: { h2: 20 } },
    });
  });

  test("unknown holdId is a no-op (idempotent)", async () => {
    const result = await invokeHandler(account, {
      msgType: "releaseHold",
      payload: { holdId: "ghost" },
      state: { balance: 100, holds: { h1: 40 } },
    });
    expect(result).toMatchObject({
      outcome: "success",
      state: { balance: 100, holds: { h1: 40 } },
    });
  });
});

describe("account.settleHold", () => {
  test("debits balance and clears the hold", async () => {
    const result = await invokeHandler(account, {
      msgType: "settleHold",
      payload: { holdId: "h1" },
      state: { balance: 100, holds: { h1: 40 } },
    });
    expect(result).toMatchObject({
      outcome: "success",
      state: { balance: 60, holds: {} },
    });
  });

  test("unknown holdId fails with hold_not_found", async () => {
    const result = await invokeHandler(account, {
      msgType: "settleHold",
      payload: { holdId: "nope" },
      state: { balance: 100, holds: { h1: 40 } },
    });
    expect(result).toMatchObject({
      outcome: "fail",
      reason: "hold_not_found",
      details: { holdId: "nope" },
    });
    // Holds map untouched on fail.
    expect((result as { state: { holds: Record<string, number> } }).state.holds)
      .toEqual({ h1: 40 });
  });

  test("settles one hold and leaves the others", async () => {
    const result = await invokeHandler(account, {
      msgType: "settleHold",
      payload: { holdId: "h1" },
      state: { balance: 100, holds: { h1: 40, h2: 20 } },
    });
    expect(result).toMatchObject({
      outcome: "success",
      state: { balance: 60, holds: { h2: 20 } },
    });
  });
});
