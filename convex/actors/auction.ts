/**
 * Single auction instance — a full state machine with timer-driven
 * transitions and snipe protection. Created by and reports state back
 * to the `auctionHouse` supervisor.
 *
 * Every phase transition / accepted bid fires a `reportState` send to
 * `auctionHouse:"main"` (fire-and-forget). The `going_twice` tick with
 * a winning bid kicks off a `settlementSaga`, which drives the auction
 * through `settling → sold` (or `settlement_failed` on rollback). The
 * auction handles the saga's callbacks via `settlementComplete` and
 * `settlementFailed`.
 *
 * Cyclic module imports (`auction ↔ auctionHouse`, `auction ↔ auctionSagas`)
 * are intentional — the bindings are only ever read inside handler
 * bodies, so ESM live-bindings resolve at invocation time rather than
 * module evaluation time.
 *
 * See DEMO.md for the full design.
 */
import { z } from 'zod'
import { defineActor } from '../components/actors/client'
import type { ActorHandlerCtx } from '../components/actors/client'
import { account } from './account'
import { auctionHouse } from './auctionHouse'
import { settlementSaga } from './settlementSaga'

// ── Schemas ─────────────────────────────────────────────────────

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

// ── Actor ───────────────────────────────────────────────────────

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
    /** Reason reported by `settlementSaga` on terminal failure. */
    settlementFailureReason: z.string().nullable(),
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
    // Called by `settlementSaga.notifyAuction` on the success path.
    settlementComplete: { payload: z.object({}) },
    // Called by `settlementSaga.begin.compensate` on any failure path.
    settlementFailed: { payload: z.object({ reason: z.string() }) },
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
    settlementFailureReason: null,
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
    // Same formula the `bid` handler uses to reject `bid_too_low`. Exposing
    // it on the projection lets the UI seed each bidder's input with the
    // smallest legal bid (starting price before any bids, then
    // currentBid + minIncrement after that).
    const minNextBid =
      state.currentBid !== null
        ? state.currentBid.amount + state.config.minIncrement
        : state.startingPrice
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
      startingPrice: state.startingPrice,
      minIncrement: state.config.minIncrement,
      minNextBid,
      phaseStartedAt: state.phaseStartedAt,
      /** When the current phase's timer will fire (next transition). */
      phaseEndsAt,
      /** Projected ultimate end if no further snipe extensions occur. */
      expectedEndAt,
      settlementFailureReason: state.settlementFailureReason,
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
      ctx.self.send('tick', { epoch: 0 }, { after: state.config.durationMs })
      reportAuctionState(ctx, state)
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
        ctx.self.send(
          'tick',
          { epoch: state.tickEpoch },
          { after: state.config.goingOnceMs },
        )
      }
      reportAuctionState(ctx, state)
    },

    tick: async (state, { epoch }, ctx) => {
      // Epoch guard: discard stale ticks from pre-snipe generations.
      if (epoch !== state.tickEpoch) return

      switch (state.phase) {
        case 'active': {
          state.phase = 'going_once'
          state.tickEpoch += 1
          state.phaseStartedAt = ctx.now()
          ctx.self.send(
            'tick',
            { epoch: state.tickEpoch },
            { after: state.config.goingOnceMs },
          )
          reportAuctionState(ctx, state)
          return
        }
        case 'going_once': {
          state.phase = 'going_twice'
          state.tickEpoch += 1
          state.phaseStartedAt = ctx.now()
          ctx.self.send(
            'tick',
            { epoch: state.tickEpoch },
            { after: state.config.goingTwiceMs },
          )
          reportAuctionState(ctx, state)
          return
        }
        case 'going_twice': {
          state.phaseStartedAt = ctx.now()
          if (state.currentBid !== null) {
            // Hand off to the settlement saga — it drives the auction
            // through settling -> sold (or -> settlement_failed on
            // rollback) via `settlementComplete` / `settlementFailed`.
            state.phase = 'settling'
            state.tickEpoch += 1
            const sagaName = `${ctx.self.name}-settlement`
            ctx.stub(settlementSaga, sagaName).send('start', {
              auctionName: ctx.self.name,
              winner: state.currentBid.bidder,
              seller: state.seller,
              amount: state.currentBid.amount,
              holdId: state.currentBid.holdId,
            })
          } else {
            state.phase = 'expired'
          }
          reportAuctionState(ctx, state)
          return
        }
        default:
          // No-op for phases where ticks aren't meaningful.
          return
      }
    },

    settlementComplete: async (state, _payload, ctx) => {
      // Stale / duplicate deliveries are dropped silently so a retry
      // after success doesn't bounce us out of `sold`.
      if (state.phase !== 'settling') return
      state.phase = 'sold'
      state.phaseStartedAt = ctx.now()
      reportAuctionState(ctx, state)
    },

    settlementFailed: async (state, { reason }, ctx) => {
      if (state.phase !== 'settling') return
      state.phase = 'settlement_failed'
      state.phaseStartedAt = ctx.now()
      state.settlementFailureReason = reason
      reportAuctionState(ctx, state)
    },
  },
})

// ── helpers ─────────────────────────────────────────────────────

/**
 * Compute the projected final end timestamp for an auction in its
 * current phase, assuming no further snipe extensions. Returns null
 * once the auction is terminal (settling / sold / expired / etc).
 */
function computeExpectedEndAt(
  state: z.infer<typeof auction.state>,
): number | null {
  const { goingOnceMs, goingTwiceMs, durationMs } = state.config
  const start = state.phaseStartedAt
  switch (state.phase) {
    case 'active':
      return start + durationMs + goingOnceMs + goingTwiceMs
    case 'going_once':
      return start + goingOnceMs + goingTwiceMs
    case 'going_twice':
      return start + goingTwiceMs
    default:
      return null
  }
}

/**
 * Push-based state aggregation: every phase transition / accepted bid
 * fire-and-forget reports the new shape to the supervisor. Kept in a
 * helper to avoid repeating the same payload in every handler.
 */
function reportAuctionState(
  ctx: ActorHandlerCtx<typeof auction>,
  state: z.infer<typeof auction.state>,
): void {
  ctx.stub(auctionHouse, 'main').send('reportState', {
    auctionName: ctx.self.name,
    phase: state.phase,
    currentBid: state.currentBid
      ? { bidder: state.currentBid.bidder, amount: state.currentBid.amount }
      : null,
    endsAt: computeExpectedEndAt(state) ?? 0,
  })
}
