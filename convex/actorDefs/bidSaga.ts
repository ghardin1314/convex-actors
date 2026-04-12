/**
 * `bidSaga` — orchestrates a bid attempt: hold funds → place bid.
 * Compensates the hold if the bid is rejected (e.g. the auction was
 * outbid). See `defineSaga` for the step/compensate protocol.
 */
import { z } from 'zod'
import { defineSaga } from '../components/actors/client'
// Cyclic import with the actor defs — values are only read inside step
// callbacks, not at module evaluation time, so ESM handles the cycle.
import { account } from './account'
import { auction } from './auction'
import { userBids } from './userBids'

/**
 * The saga owns its own hold id — there's exactly one hold per bid
 * attempt, and the saga name (bid idempotency key) already uniquely
 * identifies that attempt, so `hold-${sagaName}` is a clean
 * deterministic derivation. Callers only need to supply the
 * idempotency key as the saga name; the holdId is a private
 * implementation detail.
 */
const holdIdForSaga = (sagaName: string) => `hold-${sagaName}`

export const bidSaga = defineSaga({
  type: 'bidSaga',
  input: z.object({
    bidder: z.string(),
    auctionName: z.string(),
    amount: z.number(),
  }),
  context: z.object({}),
  initialContext: () => ({}),
  firstStep: 'holdFunds',
  steps: {
    holdFunds: {
      run: (input, _context, ctx) => {
        // Fire-and-forget: append this bid to the bidder's index so
        // `auctions.listUserBids` can find it. `append` is idempotent
        // on `idempotencyKey`, so saga retries are safe.
        ctx.stub(userBids, input.bidder).send('append', {
          idempotencyKey: ctx.self.name,
          auctionName: input.auctionName,
          amount: input.amount,
        })
        return ctx.stub(account, input.bidder).ask('hold', {
          holdId: holdIdForSaga(ctx.self.name),
          amount: input.amount,
        })
      },
      onSuccess: (_value, _input, context) => ({
        context,
        next: 'placeBid',
      }),
      // If `placeBid` later fails, release the hold we just placed.
      // If `holdFunds` itself fails, nothing was reserved — the saga
      // fails with no compensation needed.
      compensate: (input, _context, ctx) => {
        ctx.stub(account, input.bidder).send('releaseHold', {
          holdId: holdIdForSaga(ctx.self.name),
        })
      },
    },
    placeBid: {
      run: (input, _context, ctx) =>
        ctx.stub(auction, input.auctionName).ask('bid', {
          bidder: input.bidder,
          amount: input.amount,
          holdId: holdIdForSaga(ctx.self.name),
        }),
      onSuccess: () => ({ next: null }),
      // No compensate on the final step — nothing to undo at this level.
      // On failure the framework walks back to holdFunds.compensate.
    },
  },
})
