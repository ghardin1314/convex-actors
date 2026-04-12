/**
 * Generic Convex entry points around `system.*Raw`. Used by tests that
 * want to drive actors by string `actorType` + `msgType` without going
 * through the typed `api.auctions.*` layer.
 */
import { v } from 'convex/values'
import { internal } from './_generated/api'
import { mutation, query } from './_generated/server'
import { system } from './actors'

export const send = mutation({
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
      internal.actors.execute,
      args.actorType,
      args.name,
      args.msgType,
      args.payload,
      args.opts,
    )
  },
})

export const peek = query({
  args: { actorType: v.string(), name: v.string() },
  handler: async (ctx, args) => {
    return await system.peekRaw(ctx, args.actorType, args.name)
  },
})

export const getResponse = query({
  args: { messageId: v.string() },
  handler: async (ctx, args) => {
    return await system.getResponse(ctx, args)
  },
})
