import type { FunctionHandle } from 'convex/server'
import type { Id } from './_generated/dataModel.js'
import type { MutationCtx } from './_generated/server.js'
import { getMailboxRow } from './actors.js'
import { KICK_EPSILON_MS, boundScheduledTime } from './shared.js'

/**
 * Shape of the app-level `drain` internalMutation that the component
 * schedules. The component has no static reference to it — callers
 * (`send`, `enqueueMessage`, recovery) pass in a `FunctionHandle` they
 * obtain via `createFunctionHandle` at registration time. We always
 * accept the handle at call time rather than caching it on the mailbox
 * row to avoid stale handles surviving an app-level rename or redeploy.
 */
export type DrainFnHandle = FunctionHandle<
  'mutation',
  { actorId: Id<'actor'>; generation: number }
>

/**
 * Move a mailbox toward the `scheduled` state so that the app-level
 * drain will run at or before `deliverAt`. Pure state-machine logic —
 * no pending-row reads, no handler invocation. Callers are the send
 * path (`enqueueMessage`), the drain tail (reschedule for the next
 * pending row), and recovery.
 *
 * SPEC §Per-actor drain loop. Transitions:
 *
 * - `running` → no-op. An in-flight drain will loop and pick up any
 *   freshly enqueued messages on its own; waking a second drain would
 *   just race and bail on the generation check.
 * - `scheduled` with `at <= deliverAt + KICK_EPSILON_MS` → no-op. The
 *   existing schedule already covers this deliverAt (or is close enough
 *   that the sub-epsilon latency win isn't worth the scheduler churn).
 * - `scheduled` otherwise → best-effort cancel the old scheduled
 *   function, schedule a new one at the earlier `deliverAt`, overwrite
 *   `drain` with the new `scheduledId`.
 * - `idle` → schedule, write `scheduled`.
 *
 * **Kick never writes `mailbox.generation`.** Generation is owned by
 * the drain: it asserts `args.generation === state.generation` on
 * entry, then bumps. If cancel loses the race and both the old and
 * new scheduled drains fire, they both enter carrying the same
 * `generation` value, both match state on first read, whichever
 * commits first bumps state to N+1, and the second hits OCC retry →
 * re-reads state as N+1 → fails its own fence check and exits. This
 * mirrors the workpool pattern (`.context/workpool/src/component/loop.ts`):
 * generation is bumped by the runner, once per run-start, not by the
 * scheduler of the runner. See SPEC §Drain generation and recovery.
 *
 * Mirrors a few additional robustness checks from workpool's
 * `kick.ts`:
 *
 * - `KICK_EPSILON_MS` bring-forward threshold (workpool's "scheduled
 *   to run soon enough, don't bother" guard).
 * - `boundScheduledTime` clamp for absurd past/future timestamps.
 * - A `console.warn` when we find a non-`pending` scheduled row on the
 *   reschedule path — that means our mailbox's `scheduledId` pointer
 *   was stale (drain already fired/canceled/defected). Not incorrect,
 *   but worth surfacing because it implies either a lost cancel or a
 *   race that didn't update `drain` back to `idle`/`scheduled` cleanly.
 */
export async function kickMailbox(
  ctx: MutationCtx,
  args: {
    actorId: Id<'actor'>
    deliverAt: number
    drainFn: DrainFnHandle
  },
): Promise<void> {
  const mailbox = await getMailboxRow(ctx, args.actorId)
  if (mailbox === null) {
    // `getOrCreateActorRow` is the only writer into `mailboxState` and
    // always pairs its insert with the actor row, so a missing mailbox
    // here means someone outside the component mutated the tables.
    throw new Error(
      `actor ${args.actorId} has no mailboxState row — invariant violated`,
    )
  }

  const drain = mailbox.drain

  if (drain.kind === 'running') {
    return
  }

  // Clamp the requested deliverAt. Done once up front so both the
  // no-op threshold comparison and the scheduler call see the same
  // (bounded) value.
  const deliverAt = boundScheduledTime(args.deliverAt)

  if (drain.kind === 'scheduled') {
    if (drain.at <= deliverAt + KICK_EPSILON_MS) {
      return
    }
    // The current schedule fires meaningfully later than we need. Try
    // to cancel it before we schedule a replacement. Checking
    // `system.get` first keeps us from throwing on an already-
    // fired/canceled row — the scheduled function may have run in
    // between the kick that wrote this row and this call. Cancel is
    // best-effort; correctness comes from the drain-side generation
    // fence, not from this cancel.
    const scheduled = await ctx.db.system.get(drain.scheduledId)
    if (scheduled === null) {
      console.warn(
        `[kick] actor ${args.actorId} scheduledId ${drain.scheduledId} not found — stale pointer`,
      )
    } else if (scheduled.state.kind !== 'pending') {
      console.warn(
        `[kick] actor ${args.actorId} scheduledId ${drain.scheduledId} in state '${scheduled.state.kind}' — skipping cancel`,
      )
    } else {
      await ctx.scheduler.cancel(drain.scheduledId)
    }
    // Fall through to the (re)schedule branch below.
  }

  const scheduledId = await ctx.scheduler.runAt(deliverAt, args.drainFn, {
    actorId: args.actorId,
    generation: mailbox.generation,
  })
  await ctx.db.patch(mailbox._id, {
    drain: { kind: 'scheduled', scheduledId, at: deliverAt },
  })
}
