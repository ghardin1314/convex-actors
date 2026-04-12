/**
 * App-owned API for the auction house demo. Phase 3 of DEMO.md.
 *
 * The UI never talks to the actor framework directly — it goes through
 * the typed queries and mutations defined here.
 *
 * This is a demo — there is no auth. The caller passes `user` on every
 * endpoint that needs a caller identity.
 */
import { v } from 'convex/values'
import { mutation, query } from './_generated/server'
import { internal } from './_generated/api'
import { system } from './actors'
import { account, auction, userBids } from './auctionActors'
import { auctionHouse } from './auctionHouse'
import { bidSaga } from './auctionSagas'

// ── Validators ──────────────────────────────────────────────────

const itemValidator = v.object({
  title: v.string(),
  description: v.string(),
  imageUrl: v.string(),
})

const configValidator = v.object({
  durationMs: v.number(),
  goingOnceMs: v.number(),
  goingTwiceMs: v.number(),
  minIncrement: v.number(),
})

// ── Lobby / browse (no auth required) ───────────────────────────

/**
 * List every auction the supervisor knows about, plus any
 * stuck-settlement alerts for the lobby banner. Returns an empty
 * shape before the auction house has been touched.
 */
export const list = query({
  args: {},
  handler: async (ctx) => {
    const house = await system.peek(ctx, auctionHouse, 'main')
    return (
      house ?? {
        listings: [] as NonNullable<typeof house>['listings'],
        count: 0,
        stuckAlerts: [] as NonNullable<typeof house>['stuckAlerts'],
      }
    )
  },
})

/**
 * Detail view for a single auction. Returns `null` if the auction
 * doesn't exist (or has not yet been initialised).
 */
export const getAuction = query({
  args: { name: v.string() },
  handler: async (ctx, { name }) => {
    return await system.peek(ctx, auction, name)
  },
})

// ── Account (auth required) ─────────────────────────────────────

export const getAccount = query({
  args: { user: v.string() },
  handler: async (ctx, { user }) => {
    return await system.peek(ctx, account, user)
  },
})

export const deposit = mutation({
  args: {
    user: v.string(),
    amount: v.number(),
  },
  handler: async (ctx, { user, amount }): Promise<string> => {
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new Error('auctions.deposit: amount must be a positive number')
    }
    return await system.send(
      ctx,
      internal.actors.execute,
      account,
      user,
      'deposit',
      { amount },
    )
  },
})

// ── Auctions (auth required) ────────────────────────────────────

export const createAuction = mutation({
  args: {
    user: v.string(),
    item: itemValidator,
    startingPrice: v.number(),
    config: v.optional(configValidator),
  },
  handler: async (
    ctx,
    { user, item, startingPrice, config },
  ): Promise<string> => {
    if (!Number.isFinite(startingPrice) || startingPrice < 0) {
      throw new Error(
        'auctions.createAuction: startingPrice must be a non-negative number',
      )
    }
    // The supervisor allocates the auction name and returns it as the
    // reply. The client reads it via `useQuery(getResponse, { messageId })`,
    // which pushes the value reactively when the drain commits.

    // TODO: Add a nicer way to get message response w/auth, etc.
    return await system.send(
      ctx,
      internal.actors.execute,
      auctionHouse,
      'main',
      'createAuction',
      { item, seller: user, startingPrice, config },
    )
  },
})

export const placeBid = mutation({
  args: {
    user: v.string(),
    auctionName: v.string(),
    amount: v.number(),
    /**
     * Client-supplied idempotency key. Doubles as the bidSaga name, so
     * resending the same key hits the same saga instance — `bidSaga.start`
     * rejects a second invocation with `saga_already_started`, making
     * retries safe. Pick a fresh key per user bid attempt.
     */
    idempotencyKey: v.string(),
  },
  handler: async (
    ctx,
    { user, auctionName, amount, idempotencyKey },
  ): Promise<string> => {
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new Error('auctions.placeBid: amount must be a positive number')
    }
    // The idempotency key is the saga name. The hold id is a private
    // detail of `bidSaga` — it derives one from its own name so this
    // layer doesn't need to know about it.
    return await system.send(
      ctx,
      internal.actors.execute,
      bidSaga,
      idempotencyKey,
      'start',
      { bidder: user, auctionName, amount },
    )
  },
})

// ── Bid inspection ──────────────────────────────────────────────

/**
 * Peek a bidSaga by its idempotency key. Returns the saga projection
 * (`phase`, `currentStep`, `completedSteps`, `failReason`) or `null`
 * if the saga hasn't been started. Use this to distinguish a
 * successfully-landed bid (`phase: "completed"`) from a compensated
 * one (`phase: "failed"` + `failReason`). Whether the bid is *still*
 * winning on the auction is a separate question — compare against
 * `getAuction(...).currentBid` for that.
 */
export const getBidStatus = query({
  args: { idempotencyKey: v.string() },
  handler: async (ctx, { idempotencyKey }) => {
    return await system.peek(ctx, bidSaga, idempotencyKey)
  },
})

/**
 * All bids a user has initiated, in placement order. Each entry
 * carries the idempotency key, the auction it targeted, the amount,
 * and the timestamp the saga first tried to hold funds. Per-bid
 * status lives in each bidSaga — pair with `getBidStatus` for that.
 */
export const listUserBids = query({
  args: { user: v.string() },
  handler: async (ctx, { user }) => {
    const projection = await system.peek(ctx, userBids, user)
    return projection?.bids ?? []
  },
})

// ── Response subscription ───────────────────────────────────────

/**
 * Reactive read of a message's outcome. The UI `useQuery`s this with
 * the `messageId` returned from `createAuction` / `placeBid` / etc.
 * and gets pushed `null` until the drain commits the response row,
 * then the success / fail / defect envelope as soon as it lands.
 */
export const getResponse = query({
  args: { messageId: v.string() },
  handler: async (ctx, { messageId }) => {
    return await system.getResponse(ctx, { messageId })
  },
})
