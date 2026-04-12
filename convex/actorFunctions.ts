/**
 * Public Convex functions for interacting with actors from the frontend.
 * Separated from actors.ts to avoid a type cycle: this file imports
 * `internal.actors.execute` (a self-reference through _generated/api)
 * while actors.ts does not import _generated/api's `internal`.
 */
import { v } from "convex/values";
import { internal } from "./_generated/api";
import { mutation, query } from "./_generated/server";
import { system } from "./actors";

export const send = mutation({
  args: {
    actorType: v.string(),
    name: v.string(),
    msgType: v.string(),
    payload: v.any(),
    opts: v.optional(
      v.union(
        v.object({ at: v.number() }),
        v.object({ after: v.number() }),
      ),
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
    );
  },
});

export const peek = query({
  args: {
    actorType: v.string(),
    name: v.string(),
  },
  handler: async (ctx, args) => {
    return await system.peekRaw(ctx, args.actorType, args.name);
  },
});

export const getResponse = query({
  args: {
    messageId: v.string(),
  },
  handler: async (ctx, args) => {
    return await system.getResponse(ctx, args);
  },
});
