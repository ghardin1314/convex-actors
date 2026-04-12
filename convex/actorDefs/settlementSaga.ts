/**
 * `settlementSaga` — drives a winning auction through settlement:
 * notify-on-fail marker → settle winner hold → payout seller → notify
 * auction. Compensation refunds the winner and sends `settlementFailed`
 * to the auction.
 *
 * Note on the `begin` sync marker step:
 *
 * The auction should be notified via
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
import { z } from 'zod'
import { defineSaga } from '../components/actors/client'
// Cyclic import with auction (the saga sends settlementComplete /
// settlementFailed back to the auction). ESM handles the cycle because
// the binding is only read inside step callbacks.
import { account } from './account'
import { auction } from './auction'

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
        ctx.stub(account, input.winner).ask('settleHold', {
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
        ctx.stub(account, input.seller).ask('deposit', {
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
