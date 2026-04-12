/**
 * Recovery: detect stuck mailboxes (drain.kind === "running" past the
 * threshold) and reschedule their drain loops using the stored
 * `executeFn` handle.
 */
import { v } from "convex/values";
import {
  internalAction,
  internalMutation,
  internalQuery,
} from "./_generated/server.js";
import { internal } from "./_generated/api.js";
import { getMailboxRow } from "./actors.js";
import { kickMailbox, type ExecuteFnHandle } from "./kick.js";
import { createLogger } from "./logging.js";
import { now, RECOVERY_THRESHOLD_MS } from "./shared.js";
import { recordRecovered } from "./stats.js";

/**
 * Returns mailboxState rows where the drain has been `running` longer
 * than `RECOVERY_THRESHOLD_MS`. Called by the recovery cron to find
 * candidates.
 */
export const listStuckMailboxes = internalQuery({
  args: {},
  returns: v.any(),
  handler: async (ctx) => {
    const cutoff = now() - RECOVERY_THRESHOLD_MS;
    const running = await ctx.db
      .query("mailboxState")
      .withIndex("by_drainKind", (q) => q.eq("drainKind", "running"))
      .collect();
    return running.filter((m) => m.drainStartedAt! < cutoff);
  },
});

/**
 * Recover a single stuck mailbox: transition to idle, then kick to
 * reschedule the drain loop immediately using the stored `executeFn`.
 */
export const recoverMailbox = internalMutation({
  args: { actorId: v.id("actor") },
  returns: v.null(),
  handler: async (ctx, { actorId }) => {
    const logger = createLogger();
    const mailbox = await getMailboxRow(ctx, actorId);
    if (!mailbox) {
      logger.warn(`[recovery] no mailboxState for actor ${actorId}`);
      return null;
    }

    if (mailbox.drainKind !== "running") {
      // Not stuck (anymore) — another transaction already recovered or
      // the drain finished on its own.
      return null;
    }

    const cutoff = now() - RECOVERY_THRESHOLD_MS;
    if (mailbox.drainStartedAt! >= cutoff) {
      // Still within the threshold — not stuck yet.
      return null;
    }

    // Transition to idle so kickMailbox can reschedule.
    await ctx.db.patch(mailbox._id, {
      drainKind: "idle",
      drainStartedAt: undefined,
    });

    await kickMailbox(ctx, {
      actorId,
      deliverAt: now(),
      executeFn: mailbox.executeFn as ExecuteFnHandle,
    }, logger);

    recordRecovered(logger, {
      actorId,
      stuckDurationMs: now() - mailbox.drainStartedAt!,
    });

    return null;
  },
});

/**
 * Cron entrypoint: list stuck mailboxes and recover each one.
 * Uses an internalAction so each recoverMailbox call runs in its own
 * mutation transaction (isolated OCC).
 */
export const runRecoveryScan = internalAction({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const logger = createLogger();
    const stuck = await ctx.runQuery(
      internal.recovery.listStuckMailboxes,
      {},
    );
    if (stuck.length > 0) {
      logger.info(`[recovery] found ${stuck.length} stuck mailbox(es)`);
    }
    for (const mailbox of stuck) {
      await ctx.runMutation(internal.recovery.recoverMailbox, {
        actorId: mailbox.actorId,
      });
    }
    return null;
  },
});
