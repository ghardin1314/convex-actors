import { v } from 'convex/values'
import type { Id } from './_generated/dataModel.js'
import { mutation, type MutationCtx } from './_generated/server.js'
import { getOrCreateActorRow } from './actors.js'
import { kickMailbox, type ExecuteFnHandle } from './kick.js'
import { now } from './shared.js'

/**
 * Single effect to apply: a message targeted at one `(actorType, name)`
 * address. The `enqueueMessage` mutation accepts an array of these so
 * both the top-level `send` path and the drain's effect-list application
 * can share the same insert code path (SPEC §Per-actor drain loop).
 */
export const vEffect = v.object({
  actorType: v.string(),
  name: v.string(),
  msgType: v.string(),
  payload: v.any(),
  deliverAt: v.number(),
})

const vEnqueueArgs = {
  effects: v.array(vEffect),
  // `FunctionHandle` serializes as a branded string; we accept it as
  // `v.string()` at the validator boundary and narrow to `string`
  // at the type level inside the handler. The component has no static
  // reference to the app-level `drain` — callers produce the handle via
  // `createFunctionHandle(...)` and pass it on every send so a redeploy
  // that renames the drain function can't leave stale handles around.
  executeFn: v.string(),
}

/**
 * Insert one `messages` row and one `pendingMessages` row per effect.
 * Lazy-creates the target actor + paired mailbox rows on first contact
 * via `getOrCreateActorRow`.
 *
 * Does **not** kick any mailbox — scheduling the drain is the caller's
 * responsibility. Splitting enqueue from kick keeps the two halves of
 * the send path independently testable and lets the drain's
 * effect-application path apply effects atomically before it issues its
 * own follow-up kicks.
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
  handler: async (ctx, { effects, executeFn }) => {
    return await enqueueMessageHandler(
      ctx,
      effects,
      executeFn as ExecuteFnHandle,
    )
  },
})

export async function enqueueMessageHandler(
  ctx: MutationCtx,
  effects: Array<{
    actorType: string
    name: string
    msgType: string
    payload: unknown
    deliverAt: number
  }>,
  executeFn: ExecuteFnHandle,
): Promise<Array<Id<'messages'>>> {
  const sentAt = now()
  const messageIds: Array<Id<'messages'>> = []

  // Cache `(actorType, name) -> actorId` within this call so a batch
  // re-targeting the same address only pays one index lookup and only
  // runs the lazy-create branch once.
  const actorIdCache = new Map<string, Id<'actor'>>()

  // Per-actor earliest `deliverAt` so we can issue exactly one kick
  // per distinct target with the tightest deadline this batch
  // contributes. Batches targeting two actors → two kicks; a batch
  // re-targeting the same actor at multiple deliverAts → one kick at
  // the min. Avoids the redundant second kick a naive per-effect loop
  // would produce.
  const earliestByActor = new Map<Id<'actor'>, number>()

  // `sendSeq = i` is the input index and acts as
  // the deterministic tiebreaker in `by_actor_deliverable` for effects
  // with equal `(actorId, deliverAt)`.
  // Potential to parallelize this loop in the future, pending benchmarks.
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
    })
    await ctx.db.insert('pendingMessages', {
      messageId,
      actorId,
      deliverAt: effect.deliverAt,
      sendSeq: i,
      attempts: 0,
    })
    messageIds.push(messageId)

    const prev = earliestByActor.get(actorId)
    if (prev === undefined || effect.deliverAt < prev) {
      earliestByActor.set(actorId, effect.deliverAt)
    }
  }

  // Kicks are issued after all inserts so that the kick's state-machine
  // read of `mailboxState` sees a fully-populated mailbox. Sequential
  // is intentional — parallelizing wouldn't help (single-threaded
  // writes) and would only obscure the order of `_scheduled_functions`
  // rows that tests inspect.
  for (const [actorId, deliverAt] of earliestByActor) {
    await kickMailbox(ctx, { actorId, deliverAt, executeFn })
  }

  return messageIds
}
