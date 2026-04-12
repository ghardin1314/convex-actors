import { defineSchema, defineTable } from 'convex/server'
import { v } from 'convex/values'
import { logLevel } from './logging.js'
import { vDrainKind, vReplyTo, vResponse } from './shared.js'

export default defineSchema({
  actor: defineTable({
    actorType: v.string(),
    name: v.string(),
    // Populated by the drain loop on first handler invocation. Absent
    // until then — the component has no access to the definition
    // registry, so initial state is the execution loop's responsibility.
    state: v.optional(v.any()),
  }).index('by_type_name', ['actorType', 'name']),

  mailboxState: defineTable({
    actorId: v.id('actor'),
    // Bumped by every kick and by recovery. Drain bails if its arg no
    // longer matches, so stale drains become no-ops.
    generation: v.number(),
    // Drain-loop state machine (flat for indexability).
    //   idle:      drainKind only; other drain fields absent.
    //   scheduled: drainScheduledId + drainAt populated.
    //   running:   drainStartedAt populated.
    drainKind: vDrainKind,
    drainScheduledId: v.optional(v.id('_scheduled_functions')),
    drainAt: v.optional(v.number()),
    drainStartedAt: v.optional(v.number()),
    // App-level execute function handle, stored so recovery can
    // reschedule the drain loop without an app-side caller.
    // Optional: absent until the first kickMailbox call.
    executeFn: v.string(),
  })
    .index('by_actor', ['actorId'])
    .index('by_drainKind', ['drainKind']),

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
