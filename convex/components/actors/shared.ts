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

/**
 * Kick bring-forward epsilon. If an existing schedule fires within
 * this window of the new requested `deliverAt`, kick treats it as a
 * no-op rather than paying the cancel + reschedule cost for a
 * sub-second latency win. Mirrors workpool's `SECOND` threshold in
 * `kick.ts`, generalized from "close to now" to "close to the
 * requested deliverAt" so it also applies to kicks targeting far-future
 * messages.
 */
export const KICK_EPSILON_MS = 1 * SECOND;

/**
 * Hard guard rails for scheduled timestamps. Mirrors workpool's
 * `boundScheduledTime`: anything wildly in the past is clamped to
 * `now` (treat as "run ASAP") and anything absurdly far in the future
 * is clamped to one year out. Kicks in the past normally come from
 * clock skew or a test that forgot to clamp `deliverAt`; kicks in the
 * distant future are almost always a bug.
 */
export const YEAR = 365 * DAY;
export function boundScheduledTime(ms: number): number {
  const t = now();
  if (ms < t - YEAR) return t;
  if (ms > t + 4 * YEAR) return t + YEAR;
  return ms;
}

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

/** Possible drain-loop states for a mailbox. */
export const vDrainKind = v.union(
  v.literal("idle"),
  v.literal("scheduled"),
  v.literal("running"),
);
export type DrainKind = Infer<typeof vDrainKind>;

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
