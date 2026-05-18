import { defineSchema, defineTable } from 'convex/server'
import { v } from 'convex/values'
import { vDrainKind, vReplyTo, vResponse } from './shared.js'

export default defineSchema({
  actor: defineTable({
    actorType: v.string(),
    name: v.string(),
  }).index('by_type_name', ['actorType', 'name']),

  actorState: defineTable({
    actorId: v.id('actor'),
    state: v.any(),
  }).index('by_actor', ['actorId']),

  drainSignal: defineTable({
    actorId: v.id('actor'),
    generation: v.number(),
    drainKind: vDrainKind,
  })
    .index('by_actor', ['actorId'])
    .index('by_drainKind', ['drainKind']),

  drainBookkeeping: defineTable({
    actorId: v.id('actor'),
    drainScheduledId: v.optional(v.id('_scheduled_functions')),
    drainAt: v.optional(v.number()),
    drainStartedAt: v.optional(v.number()),
    executeFn: v.string(),
  }).index('by_actor', ['actorId']),

  messages: defineTable({
    actorId: v.id('actor'),
    msgType: v.string(),
    payload: v.any(),
    deliverAt: v.number(),
    sentAt: v.number(),
    /** Present when the sender used `ctx.ask()` — routes the response
     *  back to the asking actor as a new message. */
    replyTo: v.optional(vReplyTo),
  }).index('by_actor', ['actorId']),

  pendingMessages: defineTable({
    messageId: v.id('messages'),
    actorId: v.id('actor'),
    deliverAt: v.number(),
    // Index in the sender handler's effect list. Tiebreaker for multiple
    // sends emitted from one transaction with equal `deliverAt`;
    // cross-transaction ties fall through to implicit `_creationTime`.
    sendSeq: v.number(),
    attempts: v.number(),
  }).index('by_actor_deliverable', ['actorId', 'deliverAt', 'sendSeq']),

  responses: defineTable({
    messageId: v.id('messages'),
    actorId: v.id('actor'),
    response: vResponse,
  })
    .index('by_message', ['messageId'])
    .index('by_actor', ['actorId']),

})
