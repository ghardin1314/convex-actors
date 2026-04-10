import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel.js";
import { query, type MutationCtx, type QueryCtx } from "./_generated/server.js";

/**
 * Row-level primitives for the `actor` table and its sibling
 * `mailboxState` row. These are plain async functions (not mutations) so
 * higher-level handlers like `enqueueMessage` can compose them inside a
 * single transaction.
 *
 * Invariant enforced here: every `actor` row has exactly one paired
 * `mailboxState` row, created in the same transaction as the actor.
 * Nothing else in the component is allowed to insert into `actor` or
 * `mailboxState` directly.
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
 * this inserts the actor row and its paired `mailboxState` row
 * (`generation: 0`, `drain: { kind: "idle" }`). On subsequent calls it
 * returns the existing rows untouched.
 *
 * The actor row is inserted with no `state` field. Populating initial
 * state is the drain loop's responsibility on first handler invocation,
 * since only the app-level execution path has access to the actor
 * definition (and therefore to `definition.initialState()` and the
 * `state` validator).
 */
export async function getOrCreateActorRow(
  ctx: MutationCtx,
  args: {
    actorType: string;
    name: string;
  },
): Promise<{ actor: Doc<"actor">; mailbox: Doc<"mailboxState"> }> {
  const existing = await getActorRow(ctx, args.actorType, args.name);
  if (existing !== null) {
    const mailbox = await getMailboxRow(ctx, existing._id);
    // Paired insert below is the only writer into these tables, so a
    // missing mailbox here means the invariant has been violated
    // externally. Fail loudly rather than silently repairing.
    if (mailbox === null) {
      throw new Error(
        `actor ${existing._id} has no mailboxState row — invariant violated`,
      );
    }
    return { actor: existing, mailbox };
  }

  const actorId = await ctx.db.insert("actor", {
    actorType: args.actorType,
    name: args.name,
  });
  const mailboxId = await ctx.db.insert("mailboxState", {
    actorId,
    generation: 0,
    drain: { kind: "idle" },
  });
  // Re-read so callers see the same `Doc<>` shape (with `_creationTime`)
  // the index lookup path returns.
  const actor = (await ctx.db.get(actorId))!;
  const mailbox = (await ctx.db.get(mailboxId))!;
  return { actor, mailbox };
}

/**
 * Index lookup on `mailboxState.by_actor`. Split out because the drain
 * path reads it without touching the actor row.
 */
export async function getMailboxRow(
  ctx: QueryCtx,
  actorId: Id<"actor">,
): Promise<Doc<"mailboxState"> | null> {
  return await ctx.db
    .query("mailboxState")
    .withIndex("by_actor", (q) => q.eq("actorId", actorId))
    .unique();
}

/**
 * Registered query so the app-level `peek` factory can read actor state
 * via `ctx.runQuery(component.actors.getActorState, ...)`. Returns the
 * raw `state` field (which is `v.optional(v.any())` on the schema) or
 * `null` if the actor has never been addressed.
 *
 * The app-level `peek` runs `definition.project(state)` in-process on
 * the returned value — the component has no knowledge of projection
 * functions.
 */
/**
 * Returns the actorId, current mailbox generation, and drain kind for
 * a given `(actorType, name)`. Used by the app-level drain test helper
 * `drainUntilIdle` which needs to know whether to keep draining and
 * what generation to pass. Returns `null` if the actor doesn't exist.
 */
export const getMailboxInfo = query({
  args: { actorType: v.string(), name: v.string() },
  returns: v.any(),
  handler: async (ctx, { actorType, name }) => {
    const actor = await getActorRow(ctx, actorType, name);
    if (!actor) return null;
    const mailbox = await getMailboxRow(ctx, actor._id);
    if (!mailbox) return null;
    return {
      actorId: actor._id,
      generation: mailbox.generation,
      drainKind: mailbox.drain.kind,
    };
  },
});

export const getActorState = query({
  args: { actorType: v.string(), name: v.string() },
  returns: v.any(),
  handler: async (ctx, { actorType, name }) => {
    const actor = await getActorRow(ctx, actorType, name);
    if (actor === null) return null;
    // `state` is `v.optional(v.any())` — absent until the drain loop
    // processes the first message. Return `null` to signal "no state
    // yet" uniformly with "actor doesn't exist".
    return actor.state ?? null;
  },
});
