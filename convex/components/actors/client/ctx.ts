import type {
  AnyActorDefinition,
  ActorHandlerCtx,
  ActorStub,
} from "./defineActor";

// ── Effect descriptors ────────────────────────────────────────────

/**
 * Reply routing metadata. Stored on the message row so the drain loop
 * can route the response back to the asking actor.
 */
export interface ReplyTo {
  actorType: string;
  name: string;
  handler: string;
  context: unknown;
}

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
  /** Present only for `ask()` — routes the response back to the caller. */
  replyTo?: ReplyTo;
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

/**
 * Internal state exposed to the drain wrapper so it can read back the
 * handler's accumulated effects and return value after the handler
 * resolves. Not part of the public handler ctx interface.
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
 * Build a handler ctx + its drain-visible internals. The drain wrapper
 * calls this once per handler invocation, injects the actor address and
 * a stable `now`, and receives back the ctx (to pass to the handler)
 * plus `internals` (to read effects + return value after the handler
 * returns).
 */
export function createActorCtx(
  args: CreateActorCtxArgs,
): { ctx: ActorHandlerCtx; internals: ActorCtxInternals } {
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
  ): ActorStub<D> {
    return {
      send(msgType, payload, opts) {
        if (!(msgType in def.messages)) {
          throw new Error(
            `stub.send: unknown msgType "${String(msgType)}" for actor type "${def.type}"`,
          );
        }
        const schema = def.messages[String(msgType)];
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
          deliverAt: resolveDeliverAt(opts),
        });
      },
      async peek() {
        return args.peekFn(def.type, name) as ReturnType<typeof this.peek>;
      },
    };
  }

  const ctx: ActorHandlerCtx = {
    self: () => ({ type: args.selfType, name: args.selfName }),
    now: () => args.now,

    stub<D extends AnyActorDefinition>(def: D, name: string): ActorStub<D> {
      return makeStub(def, name);
    },

    sendSelf(msgType, payload, opts) {
      const selfDef = args.getDefinition(args.selfType);
      if (!(msgType in selfDef.messages)) {
        throw new Error(
          `sendSelf: unknown msgType "${String(msgType)}" for actor type "${args.selfType}"`,
        );
      }
      const schema = selfDef.messages[String(msgType)];
      const parsed = schema.safeParse(payload);
      if (!parsed.success) {
        throw new Error(
          `sendSelf: invalid payload for "${args.selfType}.${String(msgType)}": ${parsed.error.message}`,
        );
      }
      effects.push({
        actorType: args.selfType,
        name: args.selfName,
        msgType: String(msgType),
        payload: parsed.data,
        deliverAt: resolveDeliverAt(opts),
      });
    },

    ask(def, name, msgType, payload, opts) {
      if (!(msgType in def.messages)) {
        throw new Error(
          `ask: unknown msgType "${String(msgType)}" for actor type "${def.type}"`,
        );
      }
      const schema = def.messages[String(msgType)];
      const parsed = schema.safeParse(payload);
      if (!parsed.success) {
        throw new Error(
          `ask: invalid payload for "${def.type}.${String(msgType)}": ${parsed.error.message}`,
        );
      }

      const selfDef = args.getDefinition(args.selfType);
      const handler = String(opts.handler);
      if (!(handler in selfDef.messages)) {
        throw new Error(
          `ask: unknown reply handler "${handler}" on actor type "${args.selfType}"`,
        );
      }

      effects.push({
        actorType: def.type,
        name,
        msgType: String(msgType),
        payload: parsed.data,
        deliverAt: args.now,
        replyTo: {
          actorType: args.selfType,
          name: args.selfName,
          handler,
          context: opts.context ?? null,
        },
      });
    },

    fail(reason: string, details?: unknown): never {
      throw new FailSentinel(reason, details);
    },
  };

  return { ctx, internals };
}
