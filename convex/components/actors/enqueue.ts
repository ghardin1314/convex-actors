import { v } from 'convex/values'
import type { Id } from './_generated/dataModel.js'
import { mutation, type MutationCtx } from './_generated/server.js'
import { getOrCreateActorRow } from './actors.js'
import { kickMailbox, type ExecuteFnHandle } from './kick.js'
import { createLogger, logLevel, type LogLevel } from './logging.js'
import { now, vReplyTo, type Effect } from './shared.js'
import { recordEnqueued } from './stats.js'

/**
 * Single effect to apply: a message targeted at one `(actorType, name)`
 * address. The `enqueueMessage` mutation accepts an array of these so
 * both the top-level `send` path and the drain's effect-list application
 * can share the same insert code path.
 */
export const vEffect = v.object({
  actorType: v.string(),
  name: v.string(),
  msgType: v.string(),
  payload: v.any(),
  deliverAt: v.number(),
  replyTo: v.optional(vReplyTo),
})

const vEnqueueArgs = {
  effects: v.array(vEffect),
  executeFn: v.string(),
  logLevel: v.optional(logLevel),
}

/**
 * Insert one `messages` row and one `pendingMessages` row per effect.
 * Lazy-creates the target actor + paired mailbox rows on first contact
 * via `getOrCreateActorRow`.
 *
 * After inserting all rows, kicks each distinct target mailbox at the
 * earliest `deliverAt` in the batch.
 *
 * `sendSeq` is assigned as the index within the `effects` array so that
 * multiple sends emitted from the same transaction processed at the
 * same `deliverAt` fall through to `by_actor_deliverable` in declaration
 * order. Cross-transaction ties fall back to implicit `_creationTime`.
 *
 * Returns the array of `Id<"messages">` in 1:1 order with the input
 * `effects` so callers can correlate response rows.
 */
export const enqueueMessage = mutation({
  args: vEnqueueArgs,
  returns: v.array(v.id('messages')),
  handler: async (ctx, { effects, executeFn, logLevel }) => {
    return await enqueueMessageHandler(
      ctx,
      effects,
      executeFn as ExecuteFnHandle,
      logLevel,
    )
  },
})

export async function enqueueMessageHandler(
  ctx: MutationCtx,
  effects: Effect[],
  executeFn: ExecuteFnHandle,
  level?: LogLevel,
): Promise<Array<Id<'messages'>>> {
  const logger = createLogger(level)
  const sentAt = now()
  const messageIds: Array<Id<'messages'>> = []

  const actorIdCache = new Map<string, Id<'actor'>>()
  const earliestByActor = new Map<Id<'actor'>, number>()

  for (let i = 0; i < effects.length; i++) {
    const effect = effects[i]
    const key = `${effect.actorType}\u0000${effect.name}`
    let actorId = actorIdCache.get(key)
    if (actorId === undefined) {
      const { actor } = await getOrCreateActorRow(ctx, {
        actorType: effect.actorType,
        name: effect.name,
        executeFn,
      })
      actorId = actor._id
      actorIdCache.set(key, actorId)
    }

    const messageId = await ctx.db.insert('messages', {
      actorId,
      msgType: effect.msgType,
      payload: effect.payload,
      deliverAt: effect.deliverAt,
      sentAt,
      replyTo: effect.replyTo,
    })
    await ctx.db.insert('pendingMessages', {
      messageId,
      actorId,
      deliverAt: effect.deliverAt,
      sendSeq: i,
      attempts: 0,
    })
    messageIds.push(messageId)
    recordEnqueued(logger, {
      actorType: effect.actorType,
      name: effect.name,
      msgType: effect.msgType,
      messageId,
      deliverAt: effect.deliverAt,
    })

    const prev = earliestByActor.get(actorId)
    if (prev === undefined || effect.deliverAt < prev) {
      earliestByActor.set(actorId, effect.deliverAt)
    }
  }

  for (const [actorId, deliverAt] of earliestByActor) {
    await kickMailbox(ctx, { actorId, deliverAt, executeFn }, logger)
  }

  return messageIds
}
