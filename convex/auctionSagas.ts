/**
 * `bidSaga` + `settlementSaga` — Phase 2 of the auction demo.
 *
 * Both orchestrate a multi-step, multi-actor flow via `defineSaga`. The
 * saga framework drives each step as an ask/reply, records successful
 * steps in `completedSteps`, and on any failure walks the list in
 * reverse running each step's `compensate` handler.
 *
 *  bidSaga         : hold funds → place bid (compensates the hold if the
 *                    bid is rejected e.g. the auction was outbid).
 *  settlementSaga  : notify-on-fail marker → settle winner hold → payout
 *                    seller → notify auction. Compensation refunds the
 *                    winner and sends `settlementFailed` to the auction.
 *
 * Both sagas live here rather than in `auctionActors.ts` so the actor
 * file stays focused on entity state machines.
 */
import { z } from 'zod'
import { defineSaga } from './components/actors/client/defineSaga'
// Cyclic import with auctionActors (both sagas send back to auction and
// account). ESM handles the cycle — values are only read inside step
// callbacks, not at module evaluation time.
import { account, auction, userBids } from './auctionActors'

// ── bidSaga ──────────────────────────────────────────────────────

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
          idempotencyKey: ctx.self().name,
          auctionName: input.auctionName,
          amount: input.amount,
        })
        return ctx.ask(account, input.bidder, 'hold', {
          holdId: holdIdForSaga(ctx.self().name),
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
          holdId: holdIdForSaga(ctx.self().name),
        })
      },
    },
    placeBid: {
      run: (input, _context, ctx) =>
        ctx.ask(auction, input.auctionName, 'bid', {
          bidder: input.bidder,
          amount: input.amount,
          holdId: holdIdForSaga(ctx.self().name),
        }),
      onSuccess: () => ({ next: null }),
      // No compensate on the final step — nothing to undo at this level.
      // On failure the framework walks back to holdFunds.compensate.
    },
  },
})

// ── settlementSaga ───────────────────────────────────────────────

/**
 * Note on the `begin` sync marker step (not in DEMO.md's pseudocode):
 *
 * DEMO.md specifies that the auction should be notified via
 * `settlementFailed` on *any* saga failure — including when the very
 * first ask (`settleWinnerHold`) fails. The saga framework walks back
 * through `completedSteps`, so if the first ask fails there's nothing
 * to compensate and the auction would be stranded in `settling`.
 *
 * A sync marker step that runs first and always succeeds gets added to
 * `completedSteps` before any ask is attempted; its compensate is the
 * "notify the auction that settlement failed" side-effect. Compensation
 * runs in reverse so this fires *after* any refund (e.g. after
 * `settleWinnerHold.compensate` has already returned funds to the
 * winner). The alternative would be a framework-level `onFailure` hook.
 */
export const settlementSaga = defineSaga({
  type: 'settlementSaga',
  input: z.object({
    auctionName: z.string(),
    winner: z.string(),
    seller: z.string(),
    amount: z.number(),
    holdId: z.string(),
  }),
  context: z.object({}),
  initialContext: () => ({}),
  firstStep: 'begin',
  steps: {
    begin: {
      // Sync no-op; its compensate is the saga-wide failure notifier.
      run: (_input, context, _ctx) => ({
        context,
        next: 'settleWinnerHold' as const,
      }),
      compensate: (input, _context, ctx) => {
        ctx.stub(auction, input.auctionName).send('settlementFailed', {
          reason: 'settlement_saga_failed',
        })
      },
    },
    settleWinnerHold: {
      run: (input, _context, ctx) =>
        ctx.ask(account, input.winner, 'settleHold', {
          holdId: input.holdId,
        }),
      onSuccess: (_value, _input, context) => ({
        context,
        next: 'payoutSeller' as const,
      }),
      // If `payoutSeller` fails, refund the winner.
      compensate: (input, _context, ctx) => {
        ctx.stub(account, input.winner).send('deposit', {
          amount: input.amount,
        })
      },
    },
    payoutSeller: {
      run: (input, _context, ctx) =>
        ctx.ask(account, input.seller, 'deposit', {
          amount: input.amount,
        }),
      onSuccess: (_value, _input, context) => ({
        context,
        next: 'notifyAuction' as const,
      }),
      // No compensate — payout is the last ask. If it fails the chain
      // walks back to settleWinnerHold.compensate (refund) and begin.
    },
    notifyAuction: {
      // Terminal sync step — fire-and-forget the success notification.
      run: (input, _context, ctx) => {
        ctx.stub(auction, input.auctionName).send('settlementComplete', {})
        return { next: null }
      },
    },
  },
})
