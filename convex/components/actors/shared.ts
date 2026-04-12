import type { Infer } from 'convex/values'
import { v } from 'convex/values'

// -------- Time --------

export const SECOND = 1000
export const MINUTE = 60 * SECOND
export const HOUR = 60 * MINUTE
export const DAY = 24 * HOUR

/** Wall-clock reader. Centralized so tests can stub it if needed. */
export function now(): number {
  return Date.now()
}

// -------- Tunables --------
// TODO: Make externally configurable

/** A `running` drain older than this is considered crashed. */
export const RECOVERY_THRESHOLD_MS = 5 * MINUTE
/** How often the recovery cron fires. */
export const RECOVERY_PERIOD_MS = 5 * MINUTE
/** Total handler attempts before a throw becomes a `defect`. */
export const MAX_ATTEMPTS = 3

/**
 * If an existing schedule fires within this window of the requested
 * `deliverAt`, kick skips the cancel + reschedule for a sub-second win.
 */
export const KICK_EPSILON_MS = 1 * SECOND

/**
 * Clamps scheduled timestamps: anything >1yr in the past → now,
 * anything >4yr in the future → 1yr out.
 */
export const YEAR = 365 * DAY
export function boundScheduledTime(ms: number): number {
  const t = now()
  if (ms < t - YEAR) return t
  if (ms > t + 4 * YEAR) return t + YEAR
  return ms
}

// -------- Reply routing --------

/**
 * Stored on a message row when the sender used `ctx.ask()`. After the
 * handler writes a response, the drain loop checks this field and
 * enqueues a reply message to the asking actor.
 */
export const vReplyTo = v.object({
  actorType: v.string(),
  name: v.string(),
  handler: v.string(),
  context: v.any(),
})

// -------- Effects --------

/**
 * Reply-routing metadata. TS counterpart to `vReplyTo`, hand-written
 * so `context` stays `unknown` instead of the `any` that `v.any()`
 * would infer to.
 */
export type ReplyTo = {
  actorType: string
  name: string
  handler: string
  context: unknown
}

/**
 * One message effect produced by a handler. Shared shape for both the
 * `enqueueMessageHandler` input and the `execute` mutation's
 * `outcome.effects` field so producer and consumer agree on a single
 * type. The validator counterpart lives in `enqueue.ts` as `vEffect`;
 * defined in TS here (rather than via `Infer<typeof vEffect>`) so
 * `payload` can stay `unknown`.
 */
export type Effect = {
  actorType: string
  name: string
  msgType: string
  payload: unknown
  deliverAt: number
  replyTo?: ReplyTo
}

/**
 * Return shape of the app-level `execute` mutation. The producer
 * (`makeExecute` in `client/execute.ts`) should annotate its handler
 * return type with this, and the consumer (the drain loop in
 * `drain.ts`) picks it up via `ExecuteFnHandle`'s third generic — so
 * both sides of the function-handle boundary agree on a single type.
 * The drain loop discriminates on `outcome` and commits state,
 * effects, and the response row accordingly.
 */
export type ExecuteOutcome =
  | {
      outcome: 'success'
      newState: unknown
      effects: Effect[]
      response: unknown
    }
  | { outcome: 'fail'; reason: string; details?: unknown }
  | { outcome: 'defect'; error: string }

// -------- Validators --------

/**
 * `(actorType, name)` address. Used by enqueue args and by effect
 * descriptors that the drain applies.
 */
export const vAddress = v.object({
  actorType: v.string(),
  name: v.string(),
})
export type Address = Infer<typeof vAddress>

/** Possible drain-loop states. */
export const vDrainKind = v.union(
  v.literal('idle'),
  v.literal('scheduled'),
  v.literal('running'),
)
export type DrainKind = Infer<typeof vDrainKind>

/**
 * The three possible outcomes of processing a message: success, fail
 * (domain-level rejection), or defect (handler threw after all retries).
 * `defect.attempts` is the attempt count at which the handler gave up.
 */
export const vResponse = v.union(
  v.object({ kind: v.literal('success'), value: v.any() }),
  v.object({
    kind: v.literal('fail'),
    reason: v.string(),
    details: v.optional(v.any()),
  }),
  v.object({
    kind: v.literal('defect'),
    error: v.string(),
    attempts: v.number(),
  }),
)
export type Response = Infer<typeof vResponse>
