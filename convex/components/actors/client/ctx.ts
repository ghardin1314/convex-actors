import type { AnyActorDefinition, MessageNamesOf } from "./defineActor";

// ── Effect descriptors ────────────────────────────────────────────

/**
 * One pending side-effect: a message to be sent to an actor. Collected
 * during handler execution and applied atomically on success by the
 * drain wrapper. `sendSeq` is assigned at apply time (index in the
 * array), not at push time, so the handler doesn't need to track it.
 */
export interface EffectDescriptor {
  actorType: string;
  name: string;
  msgType: string;
  payload: unknown;
  deliverAt: number;
}

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

// ── Stub ──────────────────────────────────────────────────────────

/**
 * A handle to another actor, obtained via `ctx.stub(def, name)`. The
 * only operation currently is `send`, which pushes an effect descriptor
 * onto the handler's effect list. `peek` is provided via an injected
 * async callback so the drain wrapper can bind it to
 * `ctx.runQuery(component.actors.getActorState, ...)` + `def.project`
 * without exposing the raw mutation context to the handler.
 */
export interface Stub<D extends AnyActorDefinition> {
  send<M extends MessageNamesOf<D>>(
    msgType: M,
    payload: Parameters<D["handle"][M]>[1],
    opts?: { at?: number; after?: number },
  ): void;
  peek(): Promise<unknown>;
}

// ── ActorCtx ──────────────────────────────────────────────────────

/**
 * The context object passed to every handler invocation. Handlers see
 * this as their third parameter (`state, payload, ctx`). It mediates
 * all side effects: cross-actor sends, self-sends, failure signaling.
 * Handlers never touch `ctx.db` or `ctx.scheduler` directly.
 */
export interface ActorCtx {
  self(): { type: string; name: string };
  now(): number;
  stub<D extends AnyActorDefinition>(def: D, name: string): Stub<D>;
  sendSelf<D extends AnyActorDefinition>(
    msgType: MessageNamesOf<D>,
    payload: unknown,
    opts?: { at?: number; after?: number },
  ): void;
  fail(reason: string, details?: unknown): never;
}

/**
 * Internal state exposed to the drain wrapper so it can read back the
 * handler's accumulated effects and return value after the handler
 * resolves. Not part of the public `ActorCtx` interface.
 */
export interface ActorCtxInternals {
  readonly effects: EffectDescriptor[];
  returnValue: unknown;
}

// ── Factory ───────────────────────────────────────────────────────

export interface CreateActorCtxArgs {
  selfType: string;
  selfName: string;
  /** Stable timestamp for this drain invocation. */
  now: number;
  /**
   * Called by `stub.peek()`. Bound by the drain wrapper to
   * `ctx.runQuery(component.actors.getActorState, ...) →
   * def.project(state)`.
   */
  peekFn: (
    actorType: string,
    name: string,
  ) => Promise<unknown>;
  /**
   * Resolves an actorType to its definition for stub construction.
   * Bound to `system.getDefinition` by the drain wrapper.
   */
  getDefinition: (actorType: string) => AnyActorDefinition;
}

/**
 * Build an `ActorCtx` + its drain-visible internals. The drain wrapper
 * calls this once per handler invocation, injects the actor address and
 * a stable `now`, and receives back the ctx (to pass to the handler)
 * plus `internals` (to read effects + return value after the handler
 * returns).
 */
export function createActorCtx(
  args: CreateActorCtxArgs,
): { ctx: ActorCtx; internals: ActorCtxInternals } {
  const effects: EffectDescriptor[] = [];
  const internals: ActorCtxInternals = { effects, returnValue: undefined };

  function resolveDeliverAt(
    opts: { at?: number; after?: number } | undefined,
  ): number {
    if (opts?.at !== undefined) return Math.max(opts.at, args.now);
    if (opts?.after !== undefined) return args.now + opts.after;
    return args.now;
  }

  function makeStub<D extends AnyActorDefinition>(
    def: D,
    name: string,
  ): Stub<D> {
    return {
      send(msgType, payload, opts) {
        if (!(msgType in def.messages)) {
          throw new Error(
            `stub.send: unknown msgType "${String(msgType)}" for actor type "${def.type}"`,
          );
        }
        effects.push({
          actorType: def.type,
          name,
          msgType: String(msgType),
          payload,
          deliverAt: resolveDeliverAt(opts),
        });
      },
      async peek() {
        return args.peekFn(def.type, name);
      },
    };
  }

  const ctx: ActorCtx = {
    self: () => ({ type: args.selfType, name: args.selfName }),
    now: () => args.now,

    stub<D extends AnyActorDefinition>(def: D, name: string): Stub<D> {
      return makeStub(def, name);
    },

    sendSelf(msgType, payload, opts) {
      const selfDef = args.getDefinition(args.selfType);
      if (!(msgType in selfDef.messages)) {
        throw new Error(
          `sendSelf: unknown msgType "${String(msgType)}" for actor type "${args.selfType}"`,
        );
      }
      effects.push({
        actorType: args.selfType,
        name: args.selfName,
        msgType: String(msgType),
        payload,
        deliverAt: resolveDeliverAt(opts),
      });
    },

    fail(reason: string, details?: unknown): never {
      throw new FailSentinel(reason, details);
    },
  };

  return { ctx, internals };
}
