import type { FunctionHandle } from 'convex/server'
import type { Id } from './_generated/dataModel.js'
import { internal } from './_generated/api.js'
import type { MutationCtx } from './_generated/server.js'
import { getMailboxRow } from './actors.js'
import { KICK_EPSILON_MS, boundScheduledTime } from './shared.js'

/**
 * Shape of the app-level `execute` internalMutation that the drain
 * loop calls to invoke actor handlers. The component receives this
 * handle from the app via `send` and propagates it through the
 * drain loop and effect kicks.
 */
export type ExecuteFnHandle = FunctionHandle<
  'mutation',
  {
    actorType: string
    actorName: string
    msgType: string
    payload: unknown
  }
>

/**
 * Move a mailbox toward the `scheduled` state so that the component's
 * drain loop will run at or before `deliverAt`. Pure state-machine
 * logic — no pending-row reads, no handler invocation.
 *
 * `executeFn` is the app-level execute function handle. It's passed
 * through to the scheduled drain loop so the loop can invoke the
 * handler. The component schedules its own `internal.drain.drainLoop`;
 * the execute handle self-propagates through the loop and effect kicks.
 *
 * Transitions:
 * - `running` → no-op.
 * - `scheduled` with `at <= deliverAt + KICK_EPSILON_MS` → no-op.
 * - `scheduled` otherwise → cancel old, schedule new.
 * - `idle` → schedule, write `scheduled`.
 */
export async function kickMailbox(
  ctx: MutationCtx,
  args: {
    actorId: Id<'actor'>
    deliverAt: number
    executeFn: ExecuteFnHandle
  },
): Promise<void> {
  const mailbox = await getMailboxRow(ctx, args.actorId)
  if (mailbox === null) {
    throw new Error(
      `actor ${args.actorId} has no mailboxState row — invariant violated`,
    )
  }

  const drain = mailbox.drain

  if (drain.kind === 'running') {
    return
  }

  const deliverAt = boundScheduledTime(args.deliverAt)

  if (drain.kind === 'scheduled') {
    if (drain.at <= deliverAt + KICK_EPSILON_MS) {
      return
    }
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
  }

  const scheduledId = await ctx.scheduler.runAt(
    deliverAt,
    internal.drain.drainLoop,
    {
      actorId: args.actorId,
      generation: mailbox.generation,
      executeFn: args.executeFn,
    },
  )
  await ctx.db.patch(mailbox._id, {
    drain: { kind: 'scheduled', scheduledId, at: deliverAt },
  })
}
