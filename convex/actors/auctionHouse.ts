/**
 * `auctionHouse` — singleton supervisor/registry actor. Phase 2 of the
 * auction demo.
 *
 * Centralises auction creation (allocates stable names, stubs out the
 * new auction actor, tracks it in its own registry) and maintains a
 * push-updated view of every auction's current phase / bid for the
 * lobby UI. Each auction actor sends a `reportState` back on every
 * phase transition and accepted bid.
 *
 * A self-scheduled `checkHealth` loop flags auctions stuck in
 * `settling` longer than a threshold. The loop starts lazily on the
 * first `createAuction` so that tests which never create an auction
 * don't pay for an idle rescheduler.
 */
import { z } from 'zod'
import { defineActor } from '../components/actors/client'
// Import is cyclic (auction → auctionHouse for reportState). ESM handles
// the cycle fine because the binding is only read inside handlers, not
// at module evaluation time.
import { auction } from './auction'

// ── Config ───────────────────────────────────────────────────────

/**
 * Default health-check cadence. Chosen to be longer than the 100 s
 * virtual-time budget of `finishAllScheduledFunctions` so the loop
 * doesn't fire spuriously in integration tests. Tests that want to
 * observe stuck-settlement detection send `checkHealth` directly.
 */
const DEFAULT_HEALTH_CHECK_INTERVAL_MS = 300_000
const DEFAULT_STUCK_SETTLING_THRESHOLD_MS = 60_000

/**
 * Non-settling auctions don't need monitoring; the health loop only
 * reschedules itself while at least one auction is in this phase.
 */
const SETTLING_PHASE = 'settling' as const

// ── Schemas ──────────────────────────────────────────────────────

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

const registryItemSchema = z.object({
  title: z.string(),
  imageUrl: z.string(),
})

const registryCurrentBidSchema = z
  .object({ bidder: z.string(), amount: z.number() })
  .nullable()

const registryEntrySchema = z.object({
  item: registryItemSchema,
  seller: z.string(),
  phase: auctionPhaseSchema,
  currentBid: registryCurrentBidSchema,
  endsAt: z.number(),
  lastUpdate: z.number(),
})

const stuckAlertSchema = z.object({
  auctionName: z.string(),
  reason: z.string(),
  ts: z.number(),
})

const auctionItemSchema = z.object({
  title: z.string(),
  description: z.string(),
  imageUrl: z.string(),
})

const auctionConfigSchema = z.object({
  durationMs: z.number(),
  goingOnceMs: z.number(),
  goingTwiceMs: z.number(),
  minIncrement: z.number(),
})

// ── Actor ────────────────────────────────────────────────────────

export const auctionHouse = defineActor({
  type: 'auctionHouse',
  state: z.object({
    nextAuctionId: z.number(),
    auctions: z.record(z.string(), registryEntrySchema),
    stuckAlerts: z.array(stuckAlertSchema),
    /**
     * True while a `checkHealth` message is in flight. Flipped on when
     * an auction first enters `settling`; flipped off when a check
     * finishes and finds no remaining settling auctions.
     */
    healthCheckScheduled: z.boolean(),
    /** Interval between self-scheduled health checks. */
    healthCheckIntervalMs: z.number(),
    /** `lastUpdate` older than this for a `settling` auction → stuck. */
    stuckSettlingThresholdMs: z.number(),
  }),
  messages: {
    createAuction: {
      payload: z.object({
        item: auctionItemSchema,
        seller: z.string(),
        startingPrice: z.number(),
        config: auctionConfigSchema.optional(),
      }),
      response: z.object({ auctionName: z.string() }),
    },
    reportState: {
      payload: z.object({
        auctionName: z.string(),
        phase: auctionPhaseSchema,
        currentBid: registryCurrentBidSchema,
        endsAt: z.number(),
      }),
    },
    checkHealth: { payload: z.object({}) },
  },
  initialState: () => ({
    nextAuctionId: 1,
    auctions: {},
    stuckAlerts: [],
    healthCheckScheduled: false,
    healthCheckIntervalMs: DEFAULT_HEALTH_CHECK_INTERVAL_MS,
    stuckSettlingThresholdMs: DEFAULT_STUCK_SETTLING_THRESHOLD_MS,
  }),
  project: (state) => {
    const listings = Object.entries(state.auctions).map(([name, entry]) => ({
      name,
      item: entry.item,
      seller: entry.seller,
      phase: entry.phase,
      currentBid: entry.currentBid,
      endsAt: entry.endsAt,
    }))
    return {
      listings,
      count: listings.length,
      stuckAlerts: state.stuckAlerts,
    }
  },
  handle: {
    createAuction: async (
      state,
      { item, seller, startingPrice, config },
      ctx,
    ) => {
      const auctionName = `auction-${state.nextAuctionId}`
      state.nextAuctionId += 1

      // Placeholder registry entry. The auction will `reportState` back
      // shortly with `phase: "active"` and a real `endsAt`.
      state.auctions[auctionName] = {
        item: { title: item.title, imageUrl: item.imageUrl },
        seller,
        phase: 'initializing',
        currentBid: null,
        endsAt: 0,
        lastUpdate: ctx.now(),
      }

      // Fire-and-forget init to the newly named auction actor. The
      // health-check loop is *not* started here — there's nothing to
      // monitor until an auction enters `settling`. The loop boots
      // lazily from `reportState` when the first settling phase
      // arrives, so a quiet auction house pays nothing for idle
      // rescheduling.
      ctx.stub(auction, auctionName).send('init', {
        item,
        seller,
        startingPrice,
        config,
      })

      return { auctionName }
    },

    reportState: async (
      state,
      { auctionName, phase, currentBid, endsAt },
      ctx,
    ) => {
      const entry = state.auctions[auctionName]
      if (entry === undefined) {
        // Auction wasn't registered through `createAuction` (e.g.
        // test-only direct `init`). Ignore — no entry to update.
        return
      }
      entry.phase = phase
      entry.currentBid = currentBid
      entry.endsAt = endsAt
      entry.lastUpdate = ctx.now()

      // Boot the health-check loop the first time something we care
      // about (an auction in `settling`) shows up. The loop self-
      // terminates once no settling auctions remain (see checkHealth
      // below), so we can safely re-arm it next time.
      if (phase === SETTLING_PHASE && !state.healthCheckScheduled) {
        state.healthCheckScheduled = true
        ctx.self.send(
          'checkHealth',
          {},
          { after: state.healthCheckIntervalMs },
        )
      }
    },

    checkHealth: async (state, _payload, ctx) => {
      const now = ctx.now()
      let settlingCount = 0
      for (const [auctionName, entry] of Object.entries(state.auctions)) {
        if (entry.phase !== SETTLING_PHASE) continue
        settlingCount += 1
        if (now - entry.lastUpdate > state.stuckSettlingThresholdMs) {
          // De-dupe: only alert once per stuck entry per lastUpdate.
          const already = state.stuckAlerts.some(
            (a) => a.auctionName === auctionName && a.ts >= entry.lastUpdate,
          )
          if (!already) {
            state.stuckAlerts = [
              ...state.stuckAlerts,
              { auctionName, reason: 'stuck_settling', ts: now },
            ]
          }
        }
      }

      // No settling auctions left → stop the loop. `reportState` will
      // re-arm it next time something enters `settling`. This avoids
      // paying for forever-rescheduled checks against an idle house.
      if (settlingCount === 0) {
        state.healthCheckScheduled = false
        return
      }

      ctx.self.send('checkHealth', {}, { after: state.healthCheckIntervalMs })
    },
  },
})
