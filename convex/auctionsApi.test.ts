/// <reference types="vite/client" />
/**
 * Phase 3 API-layer tests: the typed `convex/auctions.ts` queries and
 * mutations that the UI will call. Verifies the wiring (auth gate,
 * validation, reactive response read) on top of the actor stack rather than
 * re-testing the supervisor / sagas / state machine — those are
 * exercised exhaustively by `auctionPhase2.test.ts`.
 */
import { convexTest } from 'convex-test'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import { api } from './_generated/api.js'
import schema from './schema.js'
import componentSchema from './components/actors/schema.js'

const appModules = import.meta.glob('./**/*.ts')
const componentModules = import.meta.glob('./components/actors/**/*.ts')

const T0 = 1_700_000_000_000

const ITEM = {
  title: 'Vintage Lamp',
  description: 'A very vintage lamp',
  imageUrl: 'https://example.com/lamp.png',
}

const LONG_CONFIG = {
  durationMs: 60_000_000,
  goingOnceMs: 60_000_000,
  goingTwiceMs: 60_000_000,
  minIncrement: 1,
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(T0)
})
afterEach(() => {
  vi.useRealTimers()
})

function setup() {
  const t = convexTest(schema, appModules)
  t.registerComponent('actors', componentSchema, componentModules)
  return t
}

type ConvexT = ReturnType<typeof convexTest>

async function drain(t: ConvexT) {
  await t.finishAllScheduledFunctions(() => {
    vi.advanceTimersByTime(1000)
  })
}

// ── list / getAuction (no auth) ─────────────────────────────────

describe('auctions.list', () => {
  test('returns an empty shape before any auction exists', async () => {
    const t = setup()
    const lobby = await t.query(api.auctions.list, {})
    expect(lobby).toEqual({ listings: [], count: 0, stuckAlerts: [] })
  })

  test('reflects auctions created via the API', async () => {
    const t = setup()
    const msgId = await t.mutation(api.auctions.createAuction, {
      user: 'seller-1',
      item: ITEM,
      startingPrice: 10,
      config: LONG_CONFIG,
    })
    await drain(t)

    // The mutation returns a messageId; the auction name is on the reply.
    const response = await t.query(api.auctions.getResponse, {
      messageId: msgId,
    })
    expect(response?.response).toMatchObject({
      kind: 'success',
      value: { auctionName: 'auction-1' },
    })

    const lobby = await t.query(api.auctions.list, {})
    expect(lobby.count).toBe(1)
    expect(lobby.listings[0]).toMatchObject({
      name: 'auction-1',
      seller: 'seller-1',
      phase: 'active',
    })
  })
})

describe('auctions.getAuction', () => {
  test('returns null for an unknown auction', async () => {
    const t = setup()
    const a = await t.query(api.auctions.getAuction, { name: 'nope' })
    expect(a).toBeNull()
  })

  test('returns the projection once the auction is initialised', async () => {
    const t = setup()
    await t.mutation(api.auctions.createAuction, {
      user: 'seller-1',
      item: ITEM,
      startingPrice: 10,
      config: LONG_CONFIG,
    })
    await drain(t)

    const a = await t.query(api.auctions.getAuction, { name: 'auction-1' })
    expect(a).toMatchObject({ phase: 'active', currentBid: null })
    expect(a?.item).toEqual(ITEM)
  })
})

// ── deposit / getAccount ────────────────────────────────────────

describe('auctions.deposit and getAccount', () => {
  test('deposits credit the actor and surface via getAccount', async () => {
    const t = setup()
    await t.mutation(api.auctions.deposit, { user: 'alice', amount: 250 })
    await drain(t)

    const acct = await t.query(api.auctions.getAccount, { user: 'alice' })
    expect(acct).toMatchObject({ balance: 250, availableBalance: 250 })
  })

  test('rejects non-positive amounts', async () => {
    const t = setup()
    await expect(
      t.mutation(api.auctions.deposit, { user: 'alice', amount: 0 }),
    ).rejects.toThrow(/positive number/)
    await expect(
      t.mutation(api.auctions.deposit, { user: 'alice', amount: -10 }),
    ).rejects.toThrow(/positive number/)
  })
})

// ── placeBid ────────────────────────────────────────────────────

describe('auctions.placeBid', () => {
  test('end-to-end: deposit → create → bid → balance reflects hold', async () => {
    const t = setup()

    await t.mutation(api.auctions.deposit, { user: 'alice', amount: 1_000 })
    await t.mutation(api.auctions.createAuction, {
      user: 'seller-1',
      item: ITEM,
      startingPrice: 10,
      config: LONG_CONFIG,
    })
    await drain(t)

    const bidMsgId = await t.mutation(api.auctions.placeBid, {
      user: 'alice',
      auctionName: 'auction-1',
      amount: 50,
      idempotencyKey: 'bid-alice-1',
    })
    await drain(t)

    // The bid message is the saga `start`; success is reflected in the
    // saga + auction projections, not the response (which is void).
    const bidResponse = await t.query(api.auctions.getResponse, {
      messageId: bidMsgId,
    })
    expect(bidResponse?.response.kind).toBe('success')

    const auctionState = await t.query(api.auctions.getAuction, {
      name: 'auction-1',
    })
    expect(auctionState?.currentBid).toEqual({ bidder: 'alice', amount: 50 })

    const alice = await t.query(api.auctions.getAccount, { user: 'alice' })
    expect(alice).toMatchObject({ balance: 1000, availableBalance: 950 })
  })

  test('rejects non-positive amounts before sending', async () => {
    const t = setup()
    await expect(
      t.mutation(api.auctions.placeBid, {
        user: 'alice',
        auctionName: 'auction-1',
        amount: 0,
        idempotencyKey: 'bid-alice-reject',
      }),
    ).rejects.toThrow(/positive number/)
  })

  test('insufficient funds: hold step fails the saga, getResponse reports it', async () => {
    const t = setup()
    await t.mutation(api.auctions.deposit, { user: 'poor', amount: 5 })
    await t.mutation(api.auctions.createAuction, {
      user: 'seller-1',
      item: ITEM,
      startingPrice: 10,
      config: LONG_CONFIG,
    })
    await drain(t)

    const msgId = await t.mutation(api.auctions.placeBid, {
      user: 'poor',
      auctionName: 'auction-1',
      amount: 50,
      idempotencyKey: 'bid-poor-1',
    })
    await drain(t)

    // The `start` message itself succeeds (saga handler ran cleanly);
    // the saga's failure shows up in the saga projection. The API
    // intentionally doesn't bake a saga-status query — DEMO leaves
    // that for the debug panel — so we can't peek `bidSaga` through
    // `auctions.*`. Verify the side effect instead: the bidder's hold
    // was compensated, leaving the available balance untouched.
    const sagaResponse = await t.query(api.auctions.getResponse, {
      messageId: msgId,
    })
    expect(sagaResponse?.response.kind).toBe('success')

    const poor = await t.query(api.auctions.getAccount, { user: 'poor' })
    expect(poor).toMatchObject({ balance: 5, availableBalance: 5 })

    const auctionState = await t.query(api.auctions.getAuction, {
      name: 'auction-1',
    })
    expect(auctionState?.currentBid).toBeNull()
  })
})

// ── createAuction validation ────────────────────────────────────

describe('auctions.createAuction', () => {
  test('rejects negative startingPrice', async () => {
    const t = setup()
    await expect(
      t.mutation(api.auctions.createAuction, {
        user: 'seller-1',
        item: ITEM,
        startingPrice: -1,
      }),
    ).rejects.toThrow(/non-negative/)
  })

  test('records the seller as the passed user', async () => {
    const t = setup()
    await t.mutation(api.auctions.createAuction, {
      user: 'seller-2',
      item: ITEM,
      startingPrice: 10,
      config: LONG_CONFIG,
    })
    await drain(t)

    const lobby = await t.query(api.auctions.list, {})
    expect(lobby.listings[0]).toMatchObject({
      name: 'auction-1',
      seller: 'seller-2',
    })
  })
})

// ── getBidStatus / listUserBids ────────────────────────────────

describe('auctions.getBidStatus', () => {
  test('returns null for an unknown idempotency key', async () => {
    const t = setup()
    const status = await t.query(api.auctions.getBidStatus, {
      idempotencyKey: 'never-sent',
    })
    expect(status).toBeNull()
  })

  test('a successful bid reports phase=completed', async () => {
    const t = setup()
    await t.mutation(api.auctions.deposit, { user: 'alice', amount: 1_000 })
    await t.mutation(api.auctions.createAuction, {
      user: 'seller-1',
      item: ITEM,
      startingPrice: 10,
      config: LONG_CONFIG,
    })
    await drain(t)

    await t.mutation(api.auctions.placeBid, {
      user: 'alice',
      auctionName: 'auction-1',
      amount: 50,
      idempotencyKey: 'alice-bid-1',
    })
    await drain(t)

    const status = await t.query(api.auctions.getBidStatus, {
      idempotencyKey: 'alice-bid-1',
    })
    expect(status).toMatchObject({
      phase: 'completed',
      completedSteps: ['holdFunds', 'placeBid'],
    })
  })

  test('a compensated bid reports phase=failed with the fail reason', async () => {
    const t = setup()
    await t.mutation(api.auctions.deposit, { user: 'alice', amount: 1_000 })
    await t.mutation(api.auctions.deposit, { user: 'bob', amount: 1_000 })
    await t.mutation(api.auctions.createAuction, {
      user: 'seller-1',
      item: ITEM,
      startingPrice: 10,
      config: { ...LONG_CONFIG, minIncrement: 10 },
    })
    await drain(t)

    await t.mutation(api.auctions.placeBid, {
      user: 'alice',
      auctionName: 'auction-1',
      amount: 100,
      idempotencyKey: 'alice-bid-1',
    })
    await drain(t)

    // Bob bids too low → placeBid step fails → holdFunds compensates.
    await t.mutation(api.auctions.placeBid, {
      user: 'bob',
      auctionName: 'auction-1',
      amount: 105,
      idempotencyKey: 'bob-bid-1',
    })
    await drain(t)

    const bobStatus = await t.query(api.auctions.getBidStatus, {
      idempotencyKey: 'bob-bid-1',
    })
    expect(bobStatus).toMatchObject({
      phase: 'failed',
      failReason: 'bid_too_low',
    })
  })
})

describe('auctions.listUserBids', () => {
  test('returns an empty list for a user with no bids', async () => {
    const t = setup()
    const bids = await t.query(api.auctions.listUserBids, { user: 'ghost' })
    expect(bids).toEqual([])
  })

  test('records every bid a user initiates, in placement order', async () => {
    const t = setup()
    await t.mutation(api.auctions.deposit, { user: 'alice', amount: 10_000 })
    await t.mutation(api.auctions.createAuction, {
      user: 'seller-1',
      item: ITEM,
      startingPrice: 10,
      config: LONG_CONFIG,
    })
    await t.mutation(api.auctions.createAuction, {
      user: 'seller-2',
      item: ITEM,
      startingPrice: 10,
      config: LONG_CONFIG,
    })
    await drain(t)

    await t.mutation(api.auctions.placeBid, {
      user: 'alice',
      auctionName: 'auction-1',
      amount: 50,
      idempotencyKey: 'alice-1',
    })
    await t.mutation(api.auctions.placeBid, {
      user: 'alice',
      auctionName: 'auction-2',
      amount: 75,
      idempotencyKey: 'alice-2',
    })
    await drain(t)

    const bids = await t.query(api.auctions.listUserBids, { user: 'alice' })
    expect(bids).toHaveLength(2)
    expect(bids[0]).toMatchObject({
      idempotencyKey: 'alice-1',
      auctionName: 'auction-1',
      amount: 50,
    })
    expect(bids[1]).toMatchObject({
      idempotencyKey: 'alice-2',
      auctionName: 'auction-2',
      amount: 75,
    })
  })

  test('records a bid that later fails (index is append-on-attempt)', async () => {
    const t = setup()
    await t.mutation(api.auctions.deposit, { user: 'poor', amount: 5 })
    await t.mutation(api.auctions.createAuction, {
      user: 'seller-1',
      item: ITEM,
      startingPrice: 10,
      config: LONG_CONFIG,
    })
    await drain(t)

    await t.mutation(api.auctions.placeBid, {
      user: 'poor',
      auctionName: 'auction-1',
      amount: 50,
      idempotencyKey: 'poor-1',
    })
    await drain(t)

    // The bid failed at the hold step, but the index entry still exists
    // — listUserBids shows attempts, getBidStatus shows outcomes.
    const bids = await t.query(api.auctions.listUserBids, { user: 'poor' })
    expect(bids).toHaveLength(1)
    expect(bids[0]).toMatchObject({ idempotencyKey: 'poor-1', amount: 50 })

    const status = await t.query(api.auctions.getBidStatus, {
      idempotencyKey: 'poor-1',
    })
    expect(status).toMatchObject({
      phase: 'failed',
      failReason: 'insufficient_funds',
    })
  })

  test('separates bids by user', async () => {
    const t = setup()
    await t.mutation(api.auctions.deposit, { user: 'alice', amount: 1_000 })
    await t.mutation(api.auctions.deposit, { user: 'bob', amount: 1_000 })
    await t.mutation(api.auctions.createAuction, {
      user: 'seller-1',
      item: ITEM,
      startingPrice: 10,
      config: { ...LONG_CONFIG, minIncrement: 5 },
    })
    await drain(t)

    await t.mutation(api.auctions.placeBid, {
      user: 'alice',
      auctionName: 'auction-1',
      amount: 50,
      idempotencyKey: 'alice-1',
    })
    await t.mutation(api.auctions.placeBid, {
      user: 'bob',
      auctionName: 'auction-1',
      amount: 60,
      idempotencyKey: 'bob-1',
    })
    await drain(t)

    const aliceBids = await t.query(api.auctions.listUserBids, {
      user: 'alice',
    })
    const bobBids = await t.query(api.auctions.listUserBids, { user: 'bob' })
    expect(aliceBids.map((b) => b.idempotencyKey)).toEqual(['alice-1'])
    expect(bobBids.map((b) => b.idempotencyKey)).toEqual(['bob-1'])
  })
})
