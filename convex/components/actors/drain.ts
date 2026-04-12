/**
 * Component-level drain loop. All control flow lives directly in the
 * drainLoop handler. `handleTransition` is factored out as a
 * self-contained scheduling state machine — it does work (queries +
 * scheduling) and returns the new drain state.
 *
 * Mailbox state is read once at the top, mutated in-memory, and
 * written once at the end.
 */
import { v } from "convex/values";
import { internalMutation, type MutationCtx } from "./_generated/server.js";
import { internal } from "./_generated/api.js";
import type { Doc, Id } from "./_generated/dataModel.js";
import { getMailboxRow } from "./actors.js";
import { enqueueMessageHandler } from "./enqueue.js";
import type { ExecuteFnHandle } from "./kick.js";
import { MAX_ATTEMPTS, now, boundScheduledTime } from "./shared.js";

/**
 * After writing a response, check if the original message had a
 * `replyTo` route and enqueue the reply to the asking actor.
 */
async function maybeRouteReply(
  ctx: MutationCtx,
  message: Doc<"messages">,
  actor: Doc<"actor">,
  outcome:
    | { kind: "success"; value: unknown }
    | { kind: "fail"; reason: string; details?: unknown }
    | { kind: "defect"; error: string },
  executeFn: string,
) {
  const rt = message.replyTo;
  if (!rt) return;

  let result: unknown;
  if (outcome.kind === "success") {
    result = { kind: "success", value: outcome.value };
  } else if (outcome.kind === "fail") {
    result = { kind: "fail", reason: outcome.reason, details: outcome.details };
  } else {
    result = { kind: "defect", error: outcome.error };
  }

  await enqueueMessageHandler(
    ctx,
    [
      {
        actorType: rt.actorType,
        name: rt.name,
        msgType: rt.handler,
        payload: {
          result,
          context: rt.context ?? null,
          from: { type: actor.actorType, name: actor.name },
        },
        deliverAt: now(),
      },
    ],
    executeFn as ExecuteFnHandle,
  );
}

/** Flat drain fields that get patched onto `mailboxState`. */
type DrainPatch = Pick<
  Doc<"mailboxState">,
  "drainKind" | "drainScheduledId" | "drainAt" | "drainStartedAt"
>;

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
): Promise<DrainPatch> {
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
    return {
      drainKind: "running",
      drainStartedAt: t,
      drainScheduledId: undefined,
      drainAt: undefined,
    };
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
    return {
      drainKind: "scheduled",
      drainScheduledId: scheduledId,
      drainAt: deliverAt,
      drainStartedAt: undefined,
    };
  }

  return {
    drainKind: "idle",
    drainScheduledId: undefined,
    drainAt: undefined,
    drainStartedAt: undefined,
  };
}

export const drainLoop = internalMutation({
  args: {
    actorId: v.id("actor"),
    generation: v.number(),
    executeFn: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    // TODO: consider splitting mailboxState into internal bookkeeping
    // vs observable status to avoid OCC conflicts with status readers.

    // ── Read mailbox once ───────────────────────────────────
    const mailbox = await getMailboxRow(ctx, args.actorId);
    if (!mailbox) throw new Error(`no mailboxState for actor ${args.actorId}`);
    if (mailbox.generation !== args.generation) {
      throw new Error(
        `stale drain: generation ${args.generation} !== ${mailbox.generation}`,
      );
    }

    const generation = args.generation + 1;
    let drain: DrainPatch = {
      drainKind: "running",
      drainStartedAt: now(),
      drainScheduledId: undefined,
      drainAt: undefined,
    };

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
      await ctx.db.patch(mailbox._id, { generation, ...drain });
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
      const defectError = `handler exhausted ${pending.attempts} attempts`;
      await ctx.db.insert("responses", {
        messageId: message._id,
        actorId: args.actorId,
        response: {
          kind: "defect",
          error: defectError,
          attempts: pending.attempts,
        },
      });
      await maybeRouteReply(ctx, message, actor, { kind: "defect", error: defectError }, args.executeFn);
      await ctx.db.delete(pending._id);
      drain = await handleTransition(ctx, args.actorId, generation, args.executeFn);
      await ctx.db.patch(mailbox._id, { generation, ...drain });
      return null;
    }

    // ── Execute handler ─────────────────────────────────────
    const result = await ctx.runMutation(
      args.executeFn as ExecuteFnHandle,
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
      await maybeRouteReply(ctx, message, actor, { kind: "success", value: result.response }, args.executeFn);
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
      await maybeRouteReply(ctx, message, actor, { kind: "fail", reason: result.reason, details: result.details }, args.executeFn);
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
        await maybeRouteReply(ctx, message, actor, { kind: "defect", error: result.error }, args.executeFn);
        await ctx.db.delete(pending._id);
      } else {
        await ctx.db.patch(pending._id, { attempts: newAttempts });
      }
    }

    // ── Transition + single mailbox write ───────────────────
    drain = await handleTransition(ctx, args.actorId, generation, args.executeFn);
    await ctx.db.patch(mailbox._id, { generation, ...drain });
    return null;
  },
});
