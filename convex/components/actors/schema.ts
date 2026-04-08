import { defineSchema, defineTable } from 'convex/server'
import { v } from 'convex/values'
import { vMailboxDrainState, vResponse } from './shared.js'

export default defineSchema({
  actor: defineTable({
    actorType: v.string(),
    name: v.string(),
    state: v.any(),
  }).index('by_type_name', ['actorType', 'name']),

  mailboxState: defineTable({
    actorId: v.id('actor'),
    // Bumped by every kick and by recovery. Drain bails if its arg no
    // longer matches, so stale drains become no-ops.
    generation: v.number(),
    drain: vMailboxDrainState,
  }).index('by_actor', ['actorId']),

  messages: defineTable({
    actorId: v.id('actor'),
    msgType: v.string(),
    payload: v.any(),
    deliverAt: v.number(),
    sentAt: v.number(),
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
