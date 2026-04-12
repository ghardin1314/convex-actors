/**
 * Test-only generic actor driver. Exposes `send` / `peek` / `getResponse`
 * as `internalMutation` / `internalQuery` so test suites can drive any
 * actor by string `actorType` + `msgType` without a typed public
 * endpoint for every internal message (`tick`, `reportState`, `hold`,
 * `settleHold`, saga `start`, etc.).
 *
 * Production code must not depend on this file — the UI goes through
 * the typed `api.auctions.*` layer, which wraps `system.*` with
 * validation, auth, and whatever else belongs there.
 */
import { v } from 'convex/values'
import { internal } from './_generated/api'
import { internalMutation, internalQuery } from './_generated/server'
import { system } from './system'

export const send = internalMutation({
  args: {
    actorType: v.string(),
    name: v.string(),
    msgType: v.string(),
    payload: v.any(),
    opts: v.optional(
      v.union(v.object({ at: v.number() }), v.object({ after: v.number() })),
    ),
  },
  returns: v.string(),
  handler: async (ctx, args): Promise<string> => {
    return await system.sendRaw(
      ctx,
      internal.system.execute,
      args.actorType,
      args.name,
      args.msgType,
      args.payload,
      args.opts,
    )
  },
})

export const peek = internalQuery({
  args: { actorType: v.string(), name: v.string() },
  handler: async (ctx, args) => {
    return await system.peekRaw(ctx, args.actorType, args.name)
  },
})

export const getResponse = internalQuery({
  args: { messageId: v.string() },
  handler: async (ctx, args) => {
    return await system.getResponse(ctx, args)
  },
})
