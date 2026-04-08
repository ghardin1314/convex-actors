import type { Infer } from "convex/values";
import { v } from "convex/values";

// -------- Time --------

export const SECOND = 1000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

/**
 * Wall-clock reader. Centralized so tests can stub it if ever needed,
 * though `vi.useFakeTimers()` + `vi.setSystemTime()` covers the current
 * test strategy without a seam.
 */
export function now(): number {
  return Date.now();
}

// -------- Tunables (SPEC §Drain generation and recovery, §Three outcomes) --------

/** A `running` mailbox older than this is considered crashed. */
export const RECOVERY_THRESHOLD_MS = 5 * MINUTE;
/** How often the recovery cron fires. */
export const RECOVERY_PERIOD_MS = 5 * MINUTE;
/** Total handler attempts before a throw becomes a `defect`. */
export const MAX_ATTEMPTS = 3;

/** Default retention windows per response kind. `undefined` = keep forever. */
export const RESPONSE_TTL_MS: {
  success: number;
  fail: number;
  defect: number | undefined;
} = {
  success: 1 * HOUR,
  fail: 1 * HOUR,
  defect: undefined,
};

// -------- Validators --------

/**
 * `(actorType, name)` address. Used by enqueue args and by effect
 * descriptors that the drain applies.
 */
export const vAddress = v.object({
  actorType: v.string(),
  name: v.string(),
});
export type Address = Infer<typeof vAddress>;

/**
 * Per-actor drain-loop state. Mirrors SPEC §Data model `mailboxState.drain`.
 */
export const vMailboxDrainState = v.union(
  v.object({ kind: v.literal("idle") }),
  v.object({
    kind: v.literal("scheduled"),
    scheduledId: v.id("_scheduled_functions"),
    at: v.number(),
  }),
  v.object({ kind: v.literal("running"), startedAt: v.number() }),
);
export type MailboxDrainState = Infer<typeof vMailboxDrainState>;

/**
 * The three possible outcomes of processing a message. See SPEC §Three
 * outcomes. `defect.attempts` is the attempt count at which the handler
 * gave up (always `MAX_ATTEMPTS` today, but stored for observability).
 */
export const vResponse = v.union(
  v.object({ kind: v.literal("success"), value: v.any() }),
  v.object({
    kind: v.literal("fail"),
    reason: v.string(),
    details: v.optional(v.any()),
  }),
  v.object({
    kind: v.literal("defect"),
    error: v.string(),
    attempts: v.number(),
  }),
);
export type Response = Infer<typeof vResponse>;
