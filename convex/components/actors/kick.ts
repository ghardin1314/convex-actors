import type { FunctionHandle } from 'convex/server'
import type { Doc, Id } from './_generated/dataModel.js'
import { internal } from './_generated/api.js'
import type { MutationCtx } from './_generated/server.js'
import { getBookkeepingRow, getSignalRow } from './actors.js'
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

function requireBookkeeping(
  actorId: Id<'actor'>,
  row: Doc<'drainBookkeeping'> | null,
): Doc<'drainBookkeeping'> {
  if (!row) {
    throw new Error(
      `actor ${actorId} has no drainBookkeeping row — invariant violated`,
    )
  }
  return row
}

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
  const signal = await getSignalRow(ctx, args.actorId)
  if (signal === null) {
    throw new Error(
      `actor ${args.actorId} has no drainSignal row — invariant violated`,
    )
  }

  if (signal.drainKind === 'running') {
    return
  }

  const deliverAt = boundScheduledTime(args.deliverAt)
  const bookkeeping = requireBookkeeping(
    args.actorId,
    await getBookkeepingRow(ctx, args.actorId),
  )

  if (signal.drainKind === 'scheduled') {
    if (bookkeeping.drainAt! <= deliverAt + KICK_EPSILON_MS) {
      return
    }
    const scheduled = await ctx.db.system.get(bookkeeping.drainScheduledId!)
    if (scheduled === null) {
      log.warn(
        `[kick] actor ${args.actorId} scheduledId ${bookkeeping.drainScheduledId} not found — stale pointer`,
      )
    } else if (scheduled.state.kind !== 'pending') {
      log.warn(
        `[kick] actor ${args.actorId} scheduledId ${bookkeeping.drainScheduledId} in state '${scheduled.state.kind}' — skipping cancel`,
      )
    } else {
      await ctx.scheduler.cancel(bookkeeping.drainScheduledId!)
    }
  }

  const scheduledId = await ctx.scheduler.runAt(
    deliverAt,
    internal.drain.drainLoop,
    {
      actorId: args.actorId,
      generation: signal.generation,
      executeFn: args.executeFn,
      cursorTs: deliverAt,
      logLevel: args.logLevel,
    },
  )
  await ctx.db.patch(signal._id, {
    drainKind: 'scheduled',
  })
  await ctx.db.patch(bookkeeping._id, {
    drainScheduledId: scheduledId,
    drainAt: deliverAt,
    drainStartedAt: undefined,
    executeFn: args.executeFn,
  })
}
