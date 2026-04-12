/**
 * Component-level drain loop with frozen-cursor architecture.
 *
 * `drainLoop` receives a fixed `cursorTs` that caps its query range —
 * it only reads `pendingMessages` where `deliverAt <= cursorTs`. This
 * guarantees the scan range is identical across retries and disjoint
 * from concurrent enqueue inserts (which land at `deliverAt >= now()`).
 *
 * When the cursor range is exhausted, `drainLoop` delegates to
 * `updateDrainStatus` — a lightweight mutation that does the open-ended
 * query in its own transaction so OCC conflicts there don't retry the
 * processing transaction.
 */
import { v } from 'convex/values'
import { internal } from './_generated/api.js'
import type { Doc, Id } from './_generated/dataModel.js'
import { internalMutation, type MutationCtx } from './_generated/server.js'
import { getActorStateRow, getBookkeepingRow, getSignalRow } from './actors.js'
import { enqueueMessageHandler, type KickTargets } from './enqueue.js'
import type { ExecuteFnHandle } from './kick.js'
import { createLogger, logLevel, type LogLevel } from './logging.js'
import { boundScheduledTime, MAX_ATTEMPTS, now } from './shared.js'
import { recordCompleted, recordStarted } from './stats.js'

/** Merge `src` kick targets into `dst`, keeping the earliest deliverAt per actor. */
function mergeKickTargets(dst: KickTargets, src: KickTargets) {
  for (const [actorId, entry] of src) {
    const prev = dst.get(actorId)
    if (prev === undefined || entry.deliverAt < prev.deliverAt) {
      dst.set(actorId, entry)
    }
  }
}

/**
 * Schedule one `kickActor` mutation per distinct target actor at delay 0.
 * Each runs in its own transaction, isolating cross-actor contention
 * from the drain's processing transaction. Skips the current actor —
 * it's already draining, so a kick would be a no-op.
 */
async function scheduleDeferredKicks(
  ctx: MutationCtx,
  kickTargets: KickTargets,
  selfActorId: Id<'actor'>,
  executeFn: string,
  logLevel?: LogLevel,
) {
  for (const [actorId, { deliverAt }] of kickTargets) {
    if (actorId === selfActorId) continue
    await ctx.scheduler.runAfter(0, internal.kick.kickActor, {
      actorId,
      deliverAt,
      executeFn,
      logLevel,
    })
  }
}

/**
 * After writing a response, check if the original message had a
 * `replyTo` route and enqueue the reply to the asking actor.
 * Returns kick targets for the reply's target actor (caller defers kicks).
 */
async function maybeRouteReply(
  ctx: MutationCtx,
  message: Doc<'messages'>,
  actor: Doc<'actor'>,
  outcome:
    | { kind: 'success'; value: unknown }
    | { kind: 'fail'; reason: string; details?: unknown }
    | { kind: 'defect'; error: string },
  executeFn: string,
  level?: LogLevel,
): Promise<KickTargets> {
  const rt = message.replyTo
  if (!rt) return new Map()

  let result: unknown
  if (outcome.kind === 'success') {
    result = { kind: 'success', value: outcome.value }
  } else if (outcome.kind === 'fail') {
    result = { kind: 'fail', reason: outcome.reason, details: outcome.details }
  } else {
    result = { kind: 'defect', error: outcome.error }
  }

  const { kickTargets } = await enqueueMessageHandler(
    ctx,
    [
      {
        actorType: rt.actorType,
        name: rt.name,
        msgType: rt.handler,
        payload: {
          result,
          context: rt.context ?? null,
          from: { type: actor.actorType, name: actor.name },
        },
        deliverAt: now(),
      },
    ],
    executeFn as ExecuteFnHandle,
    level,
  )
  return kickTargets
}

type SignalPatch = Pick<Doc<'drainSignal'>, 'drainKind'>
type BookkeepingPatch = Pick<
  Doc<'drainBookkeeping'>,
  'drainScheduledId' | 'drainAt' | 'drainStartedAt'
>

/**
 * Validate generation and load the signal + bookkeeping rows for an
 * actor. Throws on missing rows or stale generation.
 */
async function loadDrainState(
  ctx: MutationCtx,
  actorId: Id<'actor'>,
  generation: number,
): Promise<{ signal: Doc<'drainSignal'>; bookkeeping: Doc<'drainBookkeeping'> }> {
  const signal = await getSignalRow(ctx, actorId)
  if (!signal) throw new Error(`no drainSignal for actor ${actorId}`)
  if (signal.generation !== generation) {
    throw new Error(
      `stale drain: generation ${generation} !== ${signal.generation}`,
    )
  }
  const bookkeeping = await getBookkeepingRow(ctx, actorId)
  if (!bookkeeping) throw new Error(`no drainBookkeeping for actor ${actorId}`)
  return { signal, bookkeeping }
}

export const drainLoop = internalMutation({
  args: {
    actorId: v.id('actor'),
    generation: v.number(),
    executeFn: v.string(),
    cursorTs: v.number(),
    logLevel: v.optional(logLevel),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const { signal, bookkeeping } = await loadDrainState(ctx, args.actorId, args.generation)
    const generation = args.generation + 1
    const logger = createLogger(args.logLevel)

    const actor = await ctx.db.get(args.actorId)
    if (!actor) throw new Error(`actor row ${args.actorId} missing`)

    // ── Read next deliverable pending message (frozen cursor) ──
    const pending = await ctx.db
      .query('pendingMessages')
      .withIndex('by_actor_deliverable', (q) =>
        q.eq('actorId', args.actorId).lte('deliverAt', args.cursorTs),
      )
      .first()

    if (!pending) {
      // Cursor range exhausted → delegate to updateDrainStatus
      await ctx.scheduler.runAfter(0, internal.drain.updateDrainStatus, {
        actorId: args.actorId,
        generation,
        executeFn: args.executeFn,
        logLevel: args.logLevel,
      })
      await ctx.db.patch(signal._id, { generation, drainKind: 'running' })
      await ctx.db.patch(bookkeeping._id, {
        drainStartedAt: now(),
        drainScheduledId: undefined,
        drainAt: undefined,
      })
      return null
    }

    const message = await ctx.db.get(pending.messageId)
    if (!message) {
      throw new Error(
        `pendingMessages ${pending._id} references missing messages row ${pending.messageId}`,
      )
    }

    const eventBase = {
      actorType: actor.actorType,
      name: actor.name,
      msgType: message.msgType,
      messageId: message._id,
    }

    // Accumulate cross-actor kick targets; deferred until after commit
    const allKickTargets: KickTargets = new Map()

    // ── Attempts guard ──────────────────────────────────────
    if (pending.attempts >= MAX_ATTEMPTS) {
      const defectError = `handler exhausted ${pending.attempts} attempts`
      recordCompleted(logger, { ...eventBase, outcome: 'defect', attempts: pending.attempts })
      await ctx.db.insert('responses', {
        messageId: message._id,
        actorId: args.actorId,
        response: {
          kind: 'defect',
          error: defectError,
          attempts: pending.attempts,
        },
      })
      const replyKicks = await maybeRouteReply(
        ctx,
        message,
        actor,
        { kind: 'defect', error: defectError },
        args.executeFn,
        args.logLevel,
      )
      mergeKickTargets(allKickTargets, replyKicks)
      await ctx.db.delete(pending._id)
      await scheduleDeferredKicks(ctx, allKickTargets, args.actorId, args.executeFn, args.logLevel)
      await scheduleNextOrDelegate(ctx, args, signal._id, bookkeeping._id, generation)
      return null
    }

    // ── Execute handler ─────────────────────────────────────
    recordStarted(logger, {
      ...eventBase,
      attempts: pending.attempts,
      lagMs: now() - pending.deliverAt,
    })
    const result = await ctx.runMutation(args.executeFn as ExecuteFnHandle, {
      actorType: actor.actorType,
      actorName: actor.name,
      msgType: message.msgType,
      payload: message.payload,
      logLevel: args.logLevel ?? 'REPORT',
    })

    // ── Commit outcome ──────────────────────────────────────
    if (result.outcome === 'success') {
      recordCompleted(logger, { ...eventBase, outcome: 'success', attempts: pending.attempts })
      const existingState = await getActorStateRow(ctx, args.actorId)
      if (existingState) {
        await ctx.db.patch(existingState._id, { state: result.newState })
      } else {
        await ctx.db.insert('actorState', { actorId: args.actorId, state: result.newState })
      }

      if (result.effects.length > 0) {
        const { kickTargets } = await enqueueMessageHandler(
          ctx,
          result.effects,
          args.executeFn as ExecuteFnHandle,
          args.logLevel,
        )
        mergeKickTargets(allKickTargets, kickTargets)
      }

      await ctx.db.insert('responses', {
        messageId: message._id,
        actorId: args.actorId,
        response: { kind: 'success', value: result.response },
      })
      const replyKicks = await maybeRouteReply(
        ctx,
        message,
        actor,
        { kind: 'success', value: result.response },
        args.executeFn,
        args.logLevel,
      )
      mergeKickTargets(allKickTargets, replyKicks)
      await ctx.db.delete(pending._id)
    } else if (result.outcome === 'fail') {
      recordCompleted(logger, { ...eventBase, outcome: 'fail', attempts: pending.attempts })
      await ctx.db.insert('responses', {
        messageId: message._id,
        actorId: args.actorId,
        response: {
          kind: 'fail',
          reason: result.reason,
          details: result.details,
        },
      })
      const replyKicks = await maybeRouteReply(
        ctx,
        message,
        actor,
        { kind: 'fail', reason: result.reason, details: result.details },
        args.executeFn,
        args.logLevel,
      )
      mergeKickTargets(allKickTargets, replyKicks)
      await ctx.db.delete(pending._id)
    } else {
      // Defect outcome
      const newAttempts = pending.attempts + 1
      if (newAttempts >= MAX_ATTEMPTS) {
        recordCompleted(logger, { ...eventBase, outcome: 'defect', attempts: newAttempts })
        await ctx.db.insert('responses', {
          messageId: message._id,
          actorId: args.actorId,
          response: {
            kind: 'defect',
            error: result.error,
            attempts: newAttempts,
          },
        })
        const replyKicks = await maybeRouteReply(
          ctx,
          message,
          actor,
          { kind: 'defect', error: result.error },
          args.executeFn,
          args.logLevel,
        )
        mergeKickTargets(allKickTargets, replyKicks)
        await ctx.db.delete(pending._id)
      } else {
        await ctx.db.patch(pending._id, { attempts: newAttempts })
      }
    }

    // ── Deferred cross-actor kicks ──────────────────────────
    await scheduleDeferredKicks(ctx, allKickTargets, args.actorId, args.executeFn, args.logLevel)

    // ── Schedule next or delegate ───────────────────────────
    await scheduleNextOrDelegate(ctx, args, signal._id, bookkeeping._id, generation)
    return null
  },
})

/**
 * After processing a message, check if more work exists within the
 * frozen cursor range. If so, self-schedule drainLoop with the same
 * cursorTs. Otherwise, delegate to updateDrainStatus for an open-ended
 * check in a separate transaction.
 */
async function scheduleNextOrDelegate(
  ctx: MutationCtx,
  args: { actorId: Id<'actor'>; cursorTs: number; executeFn: string; logLevel?: LogLevel },
  signalId: Id<'drainSignal'>,
  bookkeepingId: Id<'drainBookkeeping'>,
  generation: number,
) {
  const moreInRange = await ctx.db
    .query('pendingMessages')
    .withIndex('by_actor_deliverable', (q) =>
      q.eq('actorId', args.actorId).lte('deliverAt', args.cursorTs),
    )
    .first()

  if (moreInRange) {
    // More work in cursor range → self-schedule with same cursorTs
    await ctx.scheduler.runAfter(0, internal.drain.drainLoop, {
      actorId: args.actorId,
      generation,
      executeFn: args.executeFn,
      cursorTs: args.cursorTs,
      logLevel: args.logLevel,
    })
    await ctx.db.patch(signalId, { generation, drainKind: 'running' })
    await ctx.db.patch(bookkeepingId, {
      drainStartedAt: now(),
      drainScheduledId: undefined,
      drainAt: undefined,
    })
  } else {
    // Cursor range exhausted → delegate to updateDrainStatus
    await ctx.scheduler.runAfter(0, internal.drain.updateDrainStatus, {
      actorId: args.actorId,
      generation,
      executeFn: args.executeFn,
      logLevel: args.logLevel,
    })
    await ctx.db.patch(signalId, { generation, drainKind: 'running' })
    await ctx.db.patch(bookkeepingId, {
      drainStartedAt: now(),
      drainScheduledId: undefined,
      drainAt: undefined,
    })
  }
}

/**
 * Lightweight follow-up mutation. Only runs when drainLoop exhausts its
 * cursor range. Does an open-ended pendingMessages query in its own
 * transaction so OCC conflicts here don't retry the processing
 * transaction.
 */
export const updateDrainStatus = internalMutation({
  args: {
    actorId: v.id('actor'),
    generation: v.number(),
    executeFn: v.string(),
    logLevel: v.optional(logLevel),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const { signal, bookkeeping } = await loadDrainState(ctx, args.actorId, args.generation)

    const t = now()

    // Open-ended query: any pendingMessages for this actor?
    const next = await ctx.db
      .query('pendingMessages')
      .withIndex('by_actor_deliverable', (q) => q.eq('actorId', args.actorId))
      .first()

    let signalPatch: SignalPatch
    let bookkeepingPatch: BookkeepingPatch

    if (next && next.deliverAt <= t) {
      // Deliverable now → schedule drainLoop immediately with cursorTs = now()
      await ctx.scheduler.runAfter(0, internal.drain.drainLoop, {
        actorId: args.actorId,
        generation: args.generation,
        executeFn: args.executeFn,
        cursorTs: t,
        logLevel: args.logLevel,
      })
      signalPatch = { drainKind: 'running' }
      bookkeepingPatch = {
        drainStartedAt: t,
        drainScheduledId: undefined,
        drainAt: undefined,
      }
    } else if (next) {
      // Future message → schedule drainLoop at deliverAt
      const deliverAt = boundScheduledTime(next.deliverAt)
      const scheduledId = await ctx.scheduler.runAt(
        deliverAt,
        internal.drain.drainLoop,
        {
          actorId: args.actorId,
          generation: args.generation,
          executeFn: args.executeFn,
          cursorTs: deliverAt,
          logLevel: args.logLevel,
        },
      )
      signalPatch = { drainKind: 'scheduled' }
      bookkeepingPatch = {
        drainScheduledId: scheduledId,
        drainAt: deliverAt,
        drainStartedAt: undefined,
      }
    } else {
      // No messages → idle
      signalPatch = { drainKind: 'idle' }
      bookkeepingPatch = {
        drainScheduledId: undefined,
        drainAt: undefined,
        drainStartedAt: undefined,
      }
    }

    await ctx.db.patch(signal._id, signalPatch)
    await ctx.db.patch(bookkeeping._id, bookkeepingPatch)
    return null
  },
})
