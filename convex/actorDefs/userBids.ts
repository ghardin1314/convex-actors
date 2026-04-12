import { z } from 'zod'
import { defineActor } from '../components/actors/client'

/**
 * Per-user bid index. Keyed by bidder name, records every bid attempt
 * the user has initiated via `bidSaga`. The saga fire-and-forgets an
 * `append` here at the start of its `holdFunds` step so the index
 * exists before any downstream steps run; `append` is idempotent on
 * `idempotencyKey` so saga retries don't create duplicates.
 *
 * Status of each bid (pending / active / compensated / etc.) lives in
 * the bidSaga itself — the UI reads it by peeking each saga via
 * `auctions.getBidStatus`. This actor is just the index.
 */
export const userBids = defineActor({
  type: 'userBids',
  state: z.object({
    bids: z.array(
      z.object({
        idempotencyKey: z.string(),
        auctionName: z.string(),
        amount: z.number(),
        placedAt: z.number(),
      }),
    ),
  }),
  messages: {
    append: {
      payload: z.object({
        idempotencyKey: z.string(),
        auctionName: z.string(),
        amount: z.number(),
      }),
    },
  },
  initialState: () => ({ bids: [] }),
  project: (state) => ({ bids: state.bids }),
  handle: {
    append: async (state, { idempotencyKey, auctionName, amount }, ctx) => {
      // Idempotent: saga retries hit this path with the same key.
      if (state.bids.some((b) => b.idempotencyKey === idempotencyKey)) return
      state.bids = [
        ...state.bids,
        { idempotencyKey, auctionName, amount, placedAt: ctx.now() },
      ]
    },
  },
})
