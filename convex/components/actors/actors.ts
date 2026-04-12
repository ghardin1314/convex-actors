import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel.js";
import { query, type MutationCtx, type QueryCtx } from "./_generated/server.js";
import type { ExecuteFnHandle } from "./kick.js";

/**
 * Row-level primitives for the `actor` table and its sibling
 * `drainSignal` + `drainBookkeeping` rows. These are plain async
 * functions (not mutations) so higher-level handlers like
 * `enqueueMessage` can compose them inside a single transaction.
 *
 * Invariant enforced here: every `actor` row has exactly one paired
 * `drainSignal` and one `drainBookkeeping` row, created in the same
 * transaction as the actor.
 */

/**
 * Index lookup on `(actorType, name)`. Returns `null` if the actor has
 * never been addressed.
 */
export async function getActorRow(
  ctx: QueryCtx,
  actorType: string,
  name: string,
): Promise<Doc<"actor"> | null> {
  return await ctx.db
    .query("actor")
    .withIndex("by_type_name", (q) =>
      q.eq("actorType", actorType).eq("name", name),
    )
    .unique();
}

/**
 * Idempotent lazy creation. On first call for a given `(actorType, name)`
 * this inserts the actor row and its paired `drainSignal` +
 * `drainBookkeeping` rows. On subsequent calls it returns the existing
 * actor + signal only — `drainBookkeeping` is deliberately excluded to
 * keep enqueue's read set disjoint from drain's writes.
 */
export async function getOrCreateActorRow(
  ctx: MutationCtx,
  args: {
    actorType: string;
    name: string;
    executeFn: ExecuteFnHandle;
  },
): Promise<{ actor: Doc<"actor">; signal: Doc<"drainSignal"> }> {
  const existing = await getActorRow(ctx, args.actorType, args.name);
  if (existing !== null) {
    const signal = await getSignalRow(ctx, existing._id);
    if (signal === null) {
      throw new Error(
        `actor ${existing._id} missing drainSignal row — invariant violated`,
      );
    }
    return { actor: existing, signal };
  }

  const actorId = await ctx.db.insert("actor", {
    actorType: args.actorType,
    name: args.name,
  });
  const signalId = await ctx.db.insert("drainSignal", {
    actorId,
    generation: 0,
    drainKind: "idle",
  });
  await ctx.db.insert("drainBookkeeping", {
    actorId,
    executeFn: args.executeFn,
  });
  const actor = (await ctx.db.get(actorId))!;
  const signal = (await ctx.db.get(signalId))!;
  return { actor, signal };
}

export async function getSignalRow(
  ctx: QueryCtx,
  actorId: Id<"actor">,
): Promise<Doc<"drainSignal"> | null> {
  return await ctx.db
    .query("drainSignal")
    .withIndex("by_actor", (q) => q.eq("actorId", actorId))
    .unique();
}

export async function getBookkeepingRow(
  ctx: QueryCtx,
  actorId: Id<"actor">,
): Promise<Doc<"drainBookkeeping"> | null> {
  return await ctx.db
    .query("drainBookkeeping")
    .withIndex("by_actor", (q) => q.eq("actorId", actorId))
    .unique();
}

/**
 * Read the `actorState` row for a given actor. Returns `null` if no
 * state has been written yet (i.e. no message has been processed).
 */
export async function getActorStateRow(
  ctx: QueryCtx,
  actorId: Id<"actor">,
): Promise<Doc<"actorState"> | null> {
  return await ctx.db
    .query("actorState")
    .withIndex("by_actor", (q) => q.eq("actorId", actorId))
    .unique();
}

export const getMailboxInfo = query({
  args: { actorType: v.string(), name: v.string() },
  returns: v.any(),
  handler: async (ctx, { actorType, name }) => {
    const actor = await getActorRow(ctx, actorType, name);
    if (!actor) return null;
    const signal = await getSignalRow(ctx, actor._id);
    if (!signal) return null;
    const pending = await ctx.db
      .query('pendingMessages')
      .withIndex('by_actor_deliverable', (q) => q.eq('actorId', actor._id))
      .first()
    return {
      actorId: actor._id,
      generation: signal.generation,
      drainKind: signal.drainKind,
      hasPendingMessages: pending !== null,
    };
  },
});

export const getActorState = query({
  args: { actorType: v.string(), name: v.string() },
  returns: v.any(),
  handler: async (ctx, { actorType, name }) => {
    const actor = await getActorRow(ctx, actorType, name);
    if (actor === null) return null;
    const stateRow = await getActorStateRow(ctx, actor._id);
    return stateRow?.state ?? null;
  },
});
