import type { FunctionHandle } from 'convex/server'
import type { Id } from './_generated/dataModel.js'
import { internal } from './_generated/api.js'
import type { MutationCtx } from './_generated/server.js'
import { getMailboxRow } from './actors.js'
import { createLogger, type LogLevel, type Logger } from './logging.js'
import {
  KICK_EPSILON_MS,
  boundScheduledTime,
  type ExecuteOutcome,
} from './shared.js'

export type ExecuteFnHandle = FunctionHandle<
  'mutation',
  {
    actorType: string
    actorName: string
    msgType: string
    payload: unknown
    logLevel: LogLevel
  },
  ExecuteOutcome
>

export async function kickMailbox(
  ctx: MutationCtx,
  args: {
    actorId: Id<'actor'>
    deliverAt: number
    executeFn: ExecuteFnHandle
    logLevel?: LogLevel
  },
  logger?: Logger,
): Promise<void> {
  const log = logger ?? createLogger()
  const mailbox = await getMailboxRow(ctx, args.actorId)
  if (mailbox === null) {
    throw new Error(
      `actor ${args.actorId} has no mailboxState row — invariant violated`,
    )
  }

  if (mailbox.drainKind === 'running') {
    return
  }

  const deliverAt = boundScheduledTime(args.deliverAt)

  if (mailbox.drainKind === 'scheduled') {
    if (mailbox.drainAt! <= deliverAt + KICK_EPSILON_MS) {
      return
    }
    const scheduled = await ctx.db.system.get(mailbox.drainScheduledId!)
    if (scheduled === null) {
      log.warn(
        `[kick] actor ${args.actorId} scheduledId ${mailbox.drainScheduledId} not found — stale pointer`,
      )
    } else if (scheduled.state.kind !== 'pending') {
      log.warn(
        `[kick] actor ${args.actorId} scheduledId ${mailbox.drainScheduledId} in state '${scheduled.state.kind}' — skipping cancel`,
      )
    } else {
      await ctx.scheduler.cancel(mailbox.drainScheduledId!)
    }
  }

  const scheduledId = await ctx.scheduler.runAt(
    deliverAt,
    internal.drain.drainLoop,
    {
      actorId: args.actorId,
      generation: mailbox.generation,
      executeFn: args.executeFn,
      logLevel: args.logLevel,
    },
  )
  await ctx.db.patch(mailbox._id, {
    drainKind: 'scheduled',
    drainScheduledId: scheduledId,
    drainAt: deliverAt,
    drainStartedAt: undefined,
    executeFn: args.executeFn,
  })
}
