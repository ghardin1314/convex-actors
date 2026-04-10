/**
 * Component-level drain loop. All control flow lives directly in the
 * drainLoop handler. `handleTransition` is factored out as a
 * self-contained scheduling state machine — it does work (queries +
 * scheduling) and returns the new drain state.
 *
 * Mailbox state is read once at the top, mutated in-memory, and
 * written once at the end (same pattern as the workpool's `state`).
 */
import { v } from "convex/values";
import { internalMutation, type MutationCtx } from "./_generated/server.js";
import { internal } from "./_generated/api.js";
import type { Id } from "./_generated/dataModel.js";
import { getMailboxRow } from "./actors.js";
import { enqueueMessageHandler } from "./enqueue.js";
import type { ExecuteFnHandle } from "./kick.js";
import {
  MAX_ATTEMPTS,
  now,
  boundScheduledTime,
  type MailboxDrainState,
} from "./shared.js";

/**
 * After processing (or finding nothing to process), decide what's next
 * and schedule accordingly. Returns the new drain state — the caller
 * writes it as part of the single mailbox patch.
 *
 * - More deliverable rows → schedule immediately, stay running
 * - Only future rows → schedule at deliverAt, transition to scheduled
 * - No rows → transition to idle
 */
async function handleTransition(
  ctx: MutationCtx,
  actorId: Id<"actor">,
  generation: number,
  executeFn: string,
): Promise<MailboxDrainState> {
  const t = now();

  const nextDeliverable = await ctx.db
    .query("pendingMessages")
    .withIndex("by_actor_deliverable", (q) =>
      q.eq("actorId", actorId).lte("deliverAt", t),
    )
    .first();

  if (nextDeliverable) {
    await ctx.scheduler.runAfter(0, internal.drain.drainLoop, {
      actorId,
      generation,
      executeFn,
    });
    return { kind: "running", startedAt: t };
  }

  const nextFuture = await ctx.db
    .query("pendingMessages")
    .withIndex("by_actor_deliverable", (q) => q.eq("actorId", actorId))
    .first();

  if (nextFuture) {
    const deliverAt = boundScheduledTime(nextFuture.deliverAt);
    const scheduledId = await ctx.scheduler.runAt(
      deliverAt,
      internal.drain.drainLoop,
      { actorId, generation, executeFn },
    );
    return { kind: "scheduled", scheduledId, at: deliverAt };
  }

  return { kind: "idle" };
}

export const drainLoop = internalMutation({
  args: {
    actorId: v.id("actor"),
    generation: v.number(),
    executeFn: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    // TODO: mailboxState serves both as internal loop bookkeeping
    // (generation, drain) and external observable status (getMailboxInfo).
    // Workpool separates these into internalState vs runStatus to avoid
    // OCC conflicts between the loop and status readers. Consider
    // splitting if status polls cause contention.

    // ── Read mailbox once ───────────────────────────────────
    const mailbox = await getMailboxRow(ctx, args.actorId);
    if (!mailbox) throw new Error(`no mailboxState for actor ${args.actorId}`);
    if (mailbox.generation !== args.generation) {
      throw new Error(
        `stale drain: generation ${args.generation} !== ${mailbox.generation}`,
      );
    }

    const generation = args.generation + 1;
    let drain: MailboxDrainState = { kind: "running", startedAt: now() };

    const actor = await ctx.db.get(args.actorId);
    if (!actor) throw new Error(`actor row ${args.actorId} missing`);

    // ── Read next deliverable pending message ───────────────
    const t = now();
    const pending = await ctx.db
      .query("pendingMessages")
      .withIndex("by_actor_deliverable", (q) =>
        q.eq("actorId", args.actorId).lte("deliverAt", t),
      )
      .first();

    if (!pending) {
      drain = await handleTransition(ctx, args.actorId, generation, args.executeFn);
      await ctx.db.patch(mailbox._id, { generation, drain });
      return null;
    }

    const message = await ctx.db.get(pending.messageId);
    if (!message) {
      throw new Error(
        `pendingMessages ${pending._id} references missing messages row ${pending.messageId}`,
      );
    }

    // ── Attempts guard ──────────────────────────────────────
    if (pending.attempts >= MAX_ATTEMPTS) {
      await ctx.db.insert("responses", {
        messageId: message._id,
        actorId: args.actorId,
        response: {
          kind: "defect",
          error: `handler exhausted ${pending.attempts} attempts`,
          attempts: pending.attempts,
        },
      });
      await ctx.db.delete(pending._id);
      drain = await handleTransition(ctx, args.actorId, generation, args.executeFn);
      await ctx.db.patch(mailbox._id, { generation, drain });
      return null;
    }

    // ── Execute handler ─────────────────────────────────────
    const result = await ctx.runMutation(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      args.executeFn as any,
      {
        actorType: actor.actorType,
        actorName: actor.name,
        msgType: message.msgType,
        payload: message.payload,
      },
    );

    // ── Commit outcome ──────────────────────────────────────
    if (result.outcome === "success") {
      await ctx.db.patch(args.actorId, { state: result.newState });

      if (result.effects.length > 0) {
        await enqueueMessageHandler(
          ctx,
          result.effects,
          args.executeFn as ExecuteFnHandle,
        );
      }

      await ctx.db.insert("responses", {
        messageId: message._id,
        actorId: args.actorId,
        response: { kind: "success", value: result.response },
      });
      await ctx.db.delete(pending._id);
    } else if (result.outcome === "fail") {
      await ctx.db.insert("responses", {
        messageId: message._id,
        actorId: args.actorId,
        response: {
          kind: "fail",
          reason: result.reason,
          details: result.details,
        },
      });
      await ctx.db.delete(pending._id);
    } else {
      const newAttempts = pending.attempts + 1;
      if (newAttempts >= MAX_ATTEMPTS) {
        await ctx.db.insert("responses", {
          messageId: message._id,
          actorId: args.actorId,
          response: {
            kind: "defect",
            error: result.error,
            attempts: newAttempts,
          },
        });
        await ctx.db.delete(pending._id);
      } else {
        await ctx.db.patch(pending._id, { attempts: newAttempts });
      }
    }

    // ── Transition + single mailbox write ───────────────────
    drain = await handleTransition(ctx, args.actorId, generation, args.executeFn);
    await ctx.db.patch(mailbox._id, { generation, drain });
    return null;
  },
});
