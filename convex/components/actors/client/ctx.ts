/**
 * Runtime process-handler context. Built by `execute.ts` per dispatch
 * and threaded into each handler call. Pure closure over an effects
 * array — no I/O here.
 *
 * Shape: `InternalProcessCtx` is the wide runtime object that both
 * actor and saga handlers see at the stored-signature layer. User code
 * never touches it directly — `defineActor` wraps it with
 * `ActorHandlerCtx` and `defineSaga`'s step code wraps it with
 * `SagaStepCtx`.
 *
 * `pushAsk` is the low-level primitive for emitting an ask effect with
 * a specific reply-handler name. `ActorStub.ask` and the saga
 * framework's step runner both call it internally.
 */
import type { z } from "zod";
import type {
  AnyProcess,
  MessageNamesOf,
  ProjectionOf,
} from "./defineProcess";
import type { Effect } from "../shared.js";

// ── Schedule opts ─────────────────────────────────────────────────

/**
 * Delivery-time option for any `send`-like call. Discriminated so the
 * compiler rejects passing both `at` and `after` at once.
 *
 * - `{ at }` — absolute wall-clock ms (clamped to `now` if in the past)
 * - `{ after }` — relative offset in ms from `now`
 *
 * Omit `opts` entirely to deliver immediately.
 */
export type ScheduleOpts =
  | { at: number; after?: never }
  | { after: number; at?: never };

/** Resolve `{ at, after }` opts to an absolute timestamp, clamped to `now`. */
export function resolveDeliverAt(
  now: number,
  opts: ScheduleOpts | undefined,
): number {
  if (opts?.at !== undefined) return Math.max(opts.at, now);
  if (opts?.after !== undefined) return now + opts.after;
  return now;
}

// Effect descriptors and ReplyTo live in `../shared.ts` so the
// component runtime (`enqueue`, `drain`) and the client-side handler
// ctx agree on a single shape. Import them from there directly.

// ── FailSentinel ──────────────────────────────────────────────────

/**
 * Thrown by `ctx.fail(reason, details?)`. The drain wrapper catches
 * this specifically to enter the fail path (discard state mutations +
 * effect list, write a `{ kind: "fail" }` response row). Any other
 * thrown value enters the defect/retry path.
 */
export class FailSentinel extends Error {
  readonly reason: string;
  readonly details: unknown;
  constructor(reason: string, details?: unknown) {
    super(`FailSentinel: ${reason}`);
    this.name = "FailSentinel";
    this.reason = reason;
    this.details = details;
  }
}

// ── Stubs ─────────────────────────────────────────────────────────

/**
 * Base stub — `send` + `peek`. No `ask`. Returned by
 * `internalCtx.stub(def, name)` and used directly by saga compensate
 * handlers (where ask-based flows are banned). Actor and saga step
 * ctxs both wrap this with their own `ask` variant.
 */
export interface BaseStub<D extends AnyProcess> {
  send<M extends MessageNamesOf<D>>(
    msgType: M,
    payload: z.infer<D["messages"][M]["payload"]>,
    opts?: ScheduleOpts,
  ): void;
  peek(): Promise<ProjectionOf<D>>;
}

/**
 * Self-stub on `InternalProcessCtx`. Carries the process's own
 * address and an untyped `send` (the wide runtime shape). Actor ctxs
 * narrow this to `SelfStub<Self>` with typed message names.
 */
export interface BaseSelfStub {
  readonly type: string;
  readonly name: string;
  send(
    msgType: string,
    payload: unknown,
    opts?: ScheduleOpts,
  ): void;
}

// ── Internal process ctx ──────────────────────────────────────────

/**
 * Runtime handler context threaded into every stored `handle[K]`.
 *
 * - `self` — address + untyped self-send
 * - `now()` — stable wall-clock for this dispatch
 * - `fail()` — throws `FailSentinel`
 * - `stub(def, name)` — returns a `BaseStub` (send + peek)
 * - `pushAsk(...)` — low-level primitive that emits an ask effect
 *   with an explicit reply handler name. Not user-facing: actor code
 *   goes through `ActorStub.ask` (typed wrapper), saga code goes
 *   through `defineSaga`'s internal step runner.
 */
export interface InternalProcessCtx {
  self: BaseSelfStub;
  now(): number;
  fail(reason: string, details?: unknown): never;
  stub<D extends AnyProcess>(def: D, name: string): BaseStub<D>;
  pushAsk(
    def: AnyProcess,
    name: string,
    msgType: string,
    payload: unknown,
    replyHandler: string,
    replyContext: unknown,
  ): void;
}

// ── Factory internals ─────────────────────────────────────────────

/**
 * Internal state exposed to the drain wrapper so it can read back the
 * handler's accumulated effects and return value after the handler
 * resolves. Not part of the public handler ctx interface.
 */
export interface ProcessCtxInternals {
  readonly effects: Effect[];
  returnValue: unknown;
}

export interface CreateProcessCtxArgs {
  /** The definition of the process being dispatched. Used for typed
   *  `self.send` validation and `pushAsk` reply-handler validation. */
  selfDefinition: AnyProcess;
  selfName: string;
  /** Stable timestamp for this drain invocation. */
  now: number;
  /**
   * Called by `stub.peek()`. Bound by the drain wrapper to
   * `ctx.runQuery(component.actors.getActorState, ...) →
   * def.project(state)`.
   */
  peekFn: (actorType: string, name: string) => Promise<unknown>;
}

// ── Factory ───────────────────────────────────────────────────────

/**
 * Build a handler ctx + its drain-visible internals. The drain wrapper
 * calls this once per handler invocation, injects the process address
 * and a stable `now`, and receives back the ctx (to pass to the
 * handler) plus `internals` (to read effects + return value after the
 * handler returns).
 */
export function createProcessCtx(
  args: CreateProcessCtxArgs,
): { ctx: InternalProcessCtx; internals: ProcessCtxInternals } {
  const effects: Effect[] = [];
  const internals: ProcessCtxInternals = { effects, returnValue: undefined };

  function makeBaseStub<D extends AnyProcess>(
    def: D,
    name: string,
  ): BaseStub<D> {
    return {
      send(msgType, payload, opts) {
        if (!(String(msgType) in def.messages)) {
          throw new Error(
            `stub.send: unknown msgType "${String(msgType)}" for actor type "${def.type}"`,
          );
        }
        const schema = def.messages[String(msgType)].payload;
        const parsed = schema.safeParse(payload);
        if (!parsed.success) {
          throw new Error(
            `stub.send: invalid payload for "${def.type}.${String(msgType)}": ${parsed.error.message}`,
          );
        }
        effects.push({
          actorType: def.type,
          name,
          msgType: String(msgType),
          payload: parsed.data,
          deliverAt: resolveDeliverAt(args.now, opts),
        });
      },
      async peek() {
        return args.peekFn(def.type, name) as Promise<ProjectionOf<D>>;
      },
    };
  }

  const self: BaseSelfStub = {
    type: args.selfDefinition.type,
    name: args.selfName,
    send(msgType, payload, opts) {
      const selfDef = args.selfDefinition;
      if (!(msgType in selfDef.messages)) {
        throw new Error(
          `self.send: unknown msgType "${msgType}" for actor type "${selfDef.type}"`,
        );
      }
      const schema = selfDef.messages[msgType].payload;
      const parsed = schema.safeParse(payload);
      if (!parsed.success) {
        throw new Error(
          `self.send: invalid payload for "${selfDef.type}.${msgType}": ${parsed.error.message}`,
        );
      }
      effects.push({
        actorType: selfDef.type,
        name: args.selfName,
        msgType,
        payload: parsed.data,
        deliverAt: resolveDeliverAt(args.now, opts),
      });
    },
  };

  const ctx: InternalProcessCtx = {
    self,
    now: () => args.now,
    fail(reason: string, details?: unknown): never {
      throw new FailSentinel(reason, details);
    },
    stub<D extends AnyProcess>(def: D, name: string): BaseStub<D> {
      return makeBaseStub(def, name);
    },
    pushAsk(def, name, msgType, payload, replyHandler, replyContext) {
      if (!(msgType in def.messages)) {
        throw new Error(
          `pushAsk: unknown msgType "${msgType}" for actor type "${def.type}"`,
        );
      }
      const schema = def.messages[msgType].payload;
      const parsed = schema.safeParse(payload);
      if (!parsed.success) {
        throw new Error(
          `pushAsk: invalid payload for "${def.type}.${msgType}": ${parsed.error.message}`,
        );
      }
      const selfDef = args.selfDefinition;
      if (!(replyHandler in selfDef.messages)) {
        throw new Error(
          `pushAsk: unknown reply handler "${replyHandler}" on actor type "${selfDef.type}"`,
        );
      }
      effects.push({
        actorType: def.type,
        name,
        msgType,
        payload: parsed.data,
        deliverAt: args.now,
        replyTo: {
          actorType: selfDef.type,
          name: args.selfName,
          handler: replyHandler,
          context: replyContext,
        },
      });
    },
  };

  return { ctx, internals };
}
