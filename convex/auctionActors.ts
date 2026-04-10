/**
 * Auction house demo actors — Phase 1.
 *
 * Phase 1 implements the two core actors: `account` and `auction`.
 * The `auctionHouse` supervisor, `bidSaga`, and `settlementSaga` come
 * in Phase 2. Until then:
 *   - Auctions are created via direct `init` sends (no supervisor).
 *   - The going_twice tick transitions to `settling` but does not yet
 *     kick off a saga — settlement lives in Phase 2.
 *   - `reportState` fan-out to the supervisor is deferred to Phase 2.
 *
 * See DEMO.md for the full design.
 */
import { z } from 'zod'
import { defineActor } from './components/actors/client/defineActor'

// ── account ─────────────────────────────────────────────────────

export const account = defineActor({
  type: 'account',
  state: z.object({
    balance: z.number(),
    /** holdId -> amount reserved (uncommitted). */
    holds: z.record(z.string(), z.number()),
    displayName: z.string(),
  }),
  messages: {
    deposit: { payload: z.object({ amount: z.number() }) },
    hold: { payload: z.object({ holdId: z.string(), amount: z.number() }) },
    releaseHold: { payload: z.object({ holdId: z.string() }) },
    settleHold: { payload: z.object({ holdId: z.string() }) },
  },
  initialState: () => ({ balance: 0, holds: {}, displayName: '' }),
  project: (state) => {
    const heldTotal = Object.values(state.holds).reduce((s, n) => s + n, 0)
    return {
      balance: state.balance,
      availableBalance: state.balance - heldTotal,
      displayName: state.displayName,
    }
  },
  handle: {
    deposit: async (state, { amount }) => {
      state.balance += amount
    },

    hold: async (state, { holdId, amount }, ctx) => {
      if (state.holds[holdId] !== undefined) {
        ctx.fail('hold_exists', { holdId })
      }
      const heldTotal = Object.values(state.holds).reduce((s, n) => s + n, 0)
      const available = state.balance - heldTotal
      if (amount > available) {
        ctx.fail('insufficient_funds', { requested: amount, available })
      }
      state.holds[holdId] = amount
    },

    releaseHold: async (state, { holdId }) => {
      // Idempotent: releasing an unknown hold is a no-op so duplicate
      // release messages (e.g. a displaced bidder releasing twice) don't
      // blow up the account.
      delete state.holds[holdId]
    },

    settleHold: async (state, { holdId }, ctx) => {
      const amount = state.holds[holdId]
      if (amount === undefined) {
        ctx.fail('hold_not_found', { holdId })
      }
      state.balance -= amount
      delete state.holds[holdId]
    },
  },
})

// ── auction ─────────────────────────────────────────────────────

const auctionConfigSchema = z.object({
  durationMs: z.number(),
  goingOnceMs: z.number(),
  goingTwiceMs: z.number(),
  minIncrement: z.number(),
})

type AuctionConfig = z.infer<typeof auctionConfigSchema>

const DEFAULT_AUCTION_CONFIG: AuctionConfig = {
  durationMs: 30_000,
  goingOnceMs: 10_000,
  goingTwiceMs: 10_000,
  minIncrement: 1,
}

const auctionItemSchema = z.object({
  title: z.string(),
  description: z.string(),
  imageUrl: z.string(),
})

const currentBidSchema = z.object({
  bidder: z.string(),
  amount: z.number(),
  holdId: z.string(),
  ts: z.number(),
})

const previousBidSchema = z.object({
  bidder: z.string(),
  amount: z.number(),
  ts: z.number(),
})

const auctionPhaseSchema = z.enum([
  'initializing',
  'active',
  'going_once',
  'going_twice',
  'settling',
  'sold',
  'expired',
  'settlement_failed',
])

type AuctionPhase = z.infer<typeof auctionPhaseSchema>

const BIDDABLE_PHASES: ReadonlySet<AuctionPhase> = new Set([
  'active',
  'going_once',
  'going_twice',
])

export const auction = defineActor({
  type: 'auction',
  state: z.object({
    phase: auctionPhaseSchema,
    item: auctionItemSchema,
    seller: z.string(),
    startingPrice: z.number(),
    currentBid: currentBidSchema.nullable(),
    previousBids: z.array(previousBidSchema),
    /** Wall-clock timestamp the current phase was entered. */
    phaseStartedAt: z.number(),
    /** Bumped on every reschedule — stale ticks are dropped. */
    tickEpoch: z.number(),
    config: auctionConfigSchema,
  }),
  messages: {
    init: {
      payload: z.object({
        item: auctionItemSchema,
        seller: z.string(),
        startingPrice: z.number(),
        config: auctionConfigSchema.optional(),
      }),
    },
    bid: {
      payload: z.object({
        bidder: z.string(),
        amount: z.number(),
        holdId: z.string(),
      }),
    },
    tick: { payload: z.object({ epoch: z.number() }) },
  },
  initialState: () => ({
    phase: 'initializing' as const,
    item: { title: '', description: '', imageUrl: '' },
    seller: '',
    startingPrice: 0,
    currentBid: null,
    previousBids: [],
    phaseStartedAt: 0,
    tickEpoch: 0,
    config: DEFAULT_AUCTION_CONFIG,
  }),
  project: (state) => {
    // Live-countdown derived from `phaseStartedAt` + the remaining
    // tick budget for the current phase. `phaseEndsAt` is the next
    // transition tick; `expectedEndAt` adds the budgets of any phases
    // after this one, assuming no further snipe extensions.
    const { goingOnceMs, goingTwiceMs, durationMs } = state.config
    const start = state.phaseStartedAt
    let phaseEndsAt: number | null = null
    let expectedEndAt: number | null = null
    switch (state.phase) {
      case 'active':
        phaseEndsAt = start + durationMs
        expectedEndAt = start + durationMs + goingOnceMs + goingTwiceMs
        break
      case 'going_once':
        phaseEndsAt = start + goingOnceMs
        expectedEndAt = start + goingOnceMs + goingTwiceMs
        break
      case 'going_twice':
        phaseEndsAt = start + goingTwiceMs
        expectedEndAt = start + goingTwiceMs
        break
      // initializing / settling / sold / expired / settlement_failed:
      // no live countdown — leave both null.
    }
    return {
      phase: state.phase,
      item: state.item,
      currentBid: state.currentBid
        ? {
            bidder: state.currentBid.bidder,
            amount: state.currentBid.amount,
          }
        : null,
      previousBids: state.previousBids,
      phaseStartedAt: state.phaseStartedAt,
      /** When the current phase's timer will fire (next transition). */
      phaseEndsAt,
      /** Projected ultimate end if no further snipe extensions occur. */
      expectedEndAt,
    }
  },
  handle: {
    init: async (state, { item, seller, startingPrice, config }, ctx) => {
      if (state.phase !== 'initializing') {
        ctx.fail('already_initialized', { currentPhase: state.phase })
      }
      state.item = item
      state.seller = seller
      state.startingPrice = startingPrice
      state.config = config ?? DEFAULT_AUCTION_CONFIG
      state.phase = 'active'
      state.tickEpoch = 0
      state.phaseStartedAt = ctx.now()
      ctx.sendSelf('tick', { epoch: 0 }, { after: state.config.durationMs })
      // TODO(Phase 2): ctx.stub(auctionHouse, "main").send("reportState", ...)
    },

    bid: async (state, { bidder, amount, holdId }, ctx) => {
      if (!BIDDABLE_PHASES.has(state.phase)) {
        ctx.fail('phase_closed', { phase: state.phase })
      }
      const minAmount =
        state.currentBid !== null
          ? state.currentBid.amount + state.config.minIncrement
          : state.startingPrice
      if (amount < minAmount) {
        ctx.fail('bid_too_low', { amount, minAmount })
      }

      // Displace the previous bidder: release their hold fire-and-forget
      // and archive the bid. `ts` carries the original placement time
      // from `currentBid` so the history reflects when the bid was
      // *placed*, not when it lost.
      if (state.currentBid !== null) {
        const prev = state.currentBid
        state.previousBids = [
          ...state.previousBids,
          { bidder: prev.bidder, amount: prev.amount, ts: prev.ts },
        ]
        ctx.stub(account, prev.bidder).send('releaseHold', {
          holdId: prev.holdId,
        })
      }

      state.currentBid = { bidder, amount, holdId, ts: ctx.now() }

      // Snipe protection: any late bid during going_once/going_twice
      // resets the auction to going_once with a fresh timer. Bumping the
      // epoch invalidates whatever tick was already queued.
      if (state.phase === 'going_once' || state.phase === 'going_twice') {
        state.phase = 'going_once'
        state.tickEpoch += 1
        state.phaseStartedAt = ctx.now()
        ctx.sendSelf(
          'tick',
          { epoch: state.tickEpoch },
          { after: state.config.goingOnceMs },
        )
      }
      // TODO(Phase 2): reportState to auctionHouse
    },

    tick: async (state, { epoch }, ctx) => {
      // Epoch guard: discard stale ticks from pre-snipe generations.
      if (epoch !== state.tickEpoch) return

      switch (state.phase) {
        case 'active': {
          state.phase = 'going_once'
          state.tickEpoch += 1
          state.phaseStartedAt = ctx.now()
          ctx.sendSelf(
            'tick',
            { epoch: state.tickEpoch },
            { after: state.config.goingOnceMs },
          )
          return
        }
        case 'going_once': {
          state.phase = 'going_twice'
          state.tickEpoch += 1
          state.phaseStartedAt = ctx.now()
          ctx.sendSelf(
            'tick',
            { epoch: state.tickEpoch },
            { after: state.config.goingTwiceMs },
          )
          return
        }
        case 'going_twice': {
          state.phaseStartedAt = ctx.now()
          if (state.currentBid !== null) {
            // Phase 2 will kick off settlementSaga here and the saga
            // will drive settling -> sold via settlementComplete.
            state.phase = 'settling'
          } else {
            state.phase = 'expired'
          }
          return
        }
        default:
          // No-op for phases where ticks aren't meaningful.
          return
      }
    },
  },
})
