/**
 * Recovery: detect stuck drains (drainKind === "running" past the
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
import { getBookkeepingRow, getSignalRow } from "./actors.js";
import { kickMailbox, type ExecuteFnHandle } from "./kick.js";
import { createLogger } from "./logging.js";
import { now, RECOVERY_THRESHOLD_MS } from "./shared.js";
import { recordRecovered } from "./stats.js";

/**
 * Returns drainSignal rows where the drain has been `running` longer
 * than `RECOVERY_THRESHOLD_MS`. Called by the recovery cron to find
 * candidates.
 */
export const listStuckMailboxes = internalQuery({
  args: {},
  returns: v.any(),
  handler: async (ctx) => {
    const cutoff = now() - RECOVERY_THRESHOLD_MS;
    const running = await ctx.db
      .query("drainSignal")
      .withIndex("by_drainKind", (q) => q.eq("drainKind", "running"))
      .collect();
    const stuck = [];
    for (const signal of running) {
      const bk = await getBookkeepingRow(ctx, signal.actorId);
      if (bk && bk.drainStartedAt! < cutoff) {
        stuck.push({ actorId: signal.actorId });
      }
    }
    return stuck;
  },
});

/**
 * Recover a single stuck drain: transition to idle, then kick to
 * reschedule the drain loop immediately using the stored `executeFn`.
 */
export const recoverMailbox = internalMutation({
  args: { actorId: v.id("actor") },
  returns: v.null(),
  handler: async (ctx, { actorId }) => {
    const logger = createLogger();
    const signal = await getSignalRow(ctx, actorId);
    if (!signal) {
      logger.warn(`[recovery] no drainSignal for actor ${actorId}`);
      return null;
    }

    if (signal.drainKind !== "running") {
      return null;
    }

    const bookkeeping = await getBookkeepingRow(ctx, actorId);
    if (!bookkeeping) {
      logger.warn(`[recovery] no drainBookkeeping for actor ${actorId}`);
      return null;
    }

    const cutoff = now() - RECOVERY_THRESHOLD_MS;
    if (bookkeeping.drainStartedAt! >= cutoff) {
      return null;
    }

    await ctx.db.patch(signal._id, {
      drainKind: "idle",
    });
    await ctx.db.patch(bookkeeping._id, {
      drainStartedAt: undefined,
    });

    await kickMailbox(ctx, {
      actorId,
      deliverAt: now(),
      executeFn: bookkeeping.executeFn as ExecuteFnHandle,
    }, logger);

    recordRecovered(logger, {
      actorId,
      stuckDurationMs: now() - bookkeeping.drainStartedAt!,
    });

    return null;
  },
});

/**
 * Cron entrypoint: list stuck drains and recover each one.
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
      logger.info(`[recovery] found ${stuck.length} stuck drain(s)`);
    }
    for (const entry of stuck) {
      await ctx.runMutation(internal.recovery.recoverMailbox, {
        actorId: entry.actorId,
      });
    }
    return null;
  },
});
