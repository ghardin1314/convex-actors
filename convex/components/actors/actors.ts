import type { Doc, Id } from "./_generated/dataModel.js";
import type { MutationCtx, QueryCtx } from "./_generated/server.js";

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
 * `initialState` is only evaluated when the actor row is missing, so
 * callers pay the cost of a fresh initial state exactly once per actor.
 * It is callable (not a value) so definitions can stash freshly-allocated
 * objects without sharing references across actors.
 */
export async function getOrCreateActorRow(
  ctx: MutationCtx,
  args: {
    actorType: string;
    name: string;
    initialState: () => unknown;
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
    state: args.initialState(),
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
