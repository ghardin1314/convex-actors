/**
 * Unit-test helpers for process definitions.
 *
 * `invokeHandler` runs a single handler through a freshly built
 * `InternalProcessCtx` + immer draft, catches `FailSentinel`, and
 * returns a typed outcome. No convex-test, no drain loop, no DB — the
 * caller supplies the starting state (defaults to `def.initialState()`)
 * and inspects the returned state + effects directly.
 *
 * The `buildSuccessReply` / `buildFailReply` / `buildDefectReply`
 * helpers construct `ReplyPayload` values for driving saga
 * `${step}_reply` handlers without having to remember the discriminated
 * shape.
 */
import { createDraft, finishDraft } from "immer";
import { createProcessCtx, FailSentinel } from "./ctx.js";
import type { ReplyPayload } from "./defineActor.js";
import type {
  AnySagaDefinition,
  SagaInternalState,
  SagaState,
} from "./defineSaga.js";
import type {
  AnyProcess,
  MessageNamesOf,
  PayloadOf,
  ReturnOf,
  StateOf,
} from "./defineProcess.js";
import type { Effect } from "../shared.js";

// ── invokeHandler ───────────────────────────────────────────────

export interface InvokeOptions<
  D extends AnyProcess,
  M extends MessageNamesOf<D>,
> {
  msgType: M;
  payload: PayloadOf<D, M>;
  /** Starting state. Defaults to `def.initialState()`. */
  state?: StateOf<D>;
  /** Self name used when the handler emits `self.send` or reads `self.name`. */
  selfName?: string;
  /** Stable `ctx.now()` for the dispatch. Defaults to `Date.now()`. */
  now?: number;
  /**
   * Resolver for `ctx.stub(def, name).peek()`. Return the projection
   * (or `null`) that the handler would see if it peeked. Defaults to
   * returning `null` for every lookup.
   */
  peek?: (actorType: string, name: string) => unknown | Promise<unknown>;
}

export type InvokeResult<
  D extends AnyProcess,
  M extends MessageNamesOf<D>,
> =
  | {
      outcome: "success";
      /** State after the handler finished (immer-committed). */
      state: StateOf<D>;
      /** Return value of the handler, or `null` if it returned `undefined`. */
      response: ReturnOf<D, M> | null;
      /** Effects emitted via `self.send` / `stub.send` / `stub.ask`. */
      effects: Effect[];
    }
  | {
      outcome: "fail";
      /**
       * Starting state, unchanged. Matches the real runtime, which
       * discards draft mutations on `ctx.fail`.
       */
      state: StateOf<D>;
      reason: string;
      details: unknown;
    }
  | {
      outcome: "defect";
      /** Starting state, unchanged — draft is discarded on throw. */
      state: StateOf<D>;
      error: string;
    };

/**
 * Run a single handler in isolation and return its outcome. Wraps the
 * same pattern the runtime's `makeExecute` uses — immer draft,
 * `createProcessCtx`, `FailSentinel` catch — without touching Convex.
 */
export async function invokeHandler<
  D extends AnyProcess,
  M extends MessageNamesOf<D>,
>(def: D, opts: InvokeOptions<D, M>): Promise<InvokeResult<D, M>> {
  const handler = def.handle[opts.msgType];
  if (!handler) {
    throw new Error(
      `invokeHandler: no handler for msgType "${String(opts.msgType)}" on "${def.type}"`,
    );
  }

  const startingState: StateOf<D> = opts.state ?? (def.initialState() as StateOf<D>);
  const now = opts.now ?? Date.now();
  const peekFn = opts.peek ?? (async () => null);

  const { ctx, internals } = createProcessCtx({
    selfDefinition: def,
    selfName: opts.selfName ?? "test",
    now,
    peekFn: async (actorType, name) => peekFn(actorType, name),
  });

  try {
    const draft = createDraft(startingState);
    internals.returnValue = await handler(draft, opts.payload, ctx);
    const nextState = finishDraft(draft) as StateOf<D>;
    const response =
      internals.returnValue === undefined
        ? null
        : (internals.returnValue as ReturnOf<D, M>);
    return {
      outcome: "success",
      state: nextState,
      response,
      effects: internals.effects,
    };
  } catch (e) {
    if (e instanceof FailSentinel) {
      return {
        outcome: "fail",
        state: startingState,
        reason: e.reason,
        details: e.details,
      };
    }
    return {
      outcome: "defect",
      state: startingState,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

// ── Reply payload builders ──────────────────────────────────────

export interface ReplyOpts<Context = unknown> {
  /** Reply-`context` the original ask carried. Defaults to `null`. */
  context?: Context;
  /** `from` address stamped on the reply. Defaults to a generic test address. */
  from?: { type: string; name: string };
}

const DEFAULT_FROM = { type: "test", name: "test" } as const;

/** Build a `ReplyPayload` with a `success` result. */
export function buildSuccessReply<Value = unknown, Context = unknown>(
  value: Value,
  opts?: ReplyOpts<Context>,
): ReplyPayload<Value, Context> {
  return {
    result: { kind: "success", value },
    context: (opts?.context ?? null) as Context,
    from: opts?.from ?? DEFAULT_FROM,
  };
}

/** Build a `ReplyPayload` with a `fail` result. */
export function buildFailReply<Context = unknown>(
  reason: string,
  opts?: ReplyOpts<Context> & { details?: unknown },
): ReplyPayload<never, Context> {
  return {
    result: { kind: "fail", reason, details: opts?.details },
    context: (opts?.context ?? null) as Context,
    from: opts?.from ?? DEFAULT_FROM,
  };
}

/** Build a `ReplyPayload` with a `defect` result. */
export function buildDefectReply<Context = unknown>(
  error: string,
  opts?: ReplyOpts<Context>,
): ReplyPayload<never, Context> {
  return {
    result: { kind: "defect", error },
    context: (opts?.context ?? null) as Context,
    from: opts?.from ?? DEFAULT_FROM,
  };
}

// ── resolveAsk ──────────────────────────────────────────────────

export type ResolveAskOptions<D extends AnyProcess> = ReplyResolution & {
  /** Asking actor's state after the ask effect was emitted. */
  state: StateOf<D>;
  /**
   * The ask effect to reply to. Must carry a `replyTo` — i.e., it must
   * have come from `stub.ask`, not `stub.send`. Pull it out of the
   * `effects` array returned by a prior `invokeHandler` call.
   */
  effect: Effect;
  /** Defaults to `effect.replyTo.name` — the original asking actor. */
  selfName?: string;
  now?: number;
  peek?: (actorType: string, name: string) => unknown | Promise<unknown>;
  /**
   * Reply-context stamped on the payload. Defaults to the context the
   * original ask carried (`effect.replyTo.context`).
   */
  replyContext?: unknown;
  /**
   * `from` stamped on the reply payload. Defaults to the target of the
   * ask effect — i.e., the actor that "would have" produced the reply.
   */
  from?: { type: string; name: string };
};

/**
 * Simulate a reply to an ask emitted by a prior handler invocation.
 * Lets tests drive actor-to-actor ask/reply flows without the drain
 * loop: run the asking handler, pick the ask effect out of the
 * returned `effects` array, then call `resolveAsk` to invoke the
 * corresponding reply handler with a synthesized `ReplyPayload`.
 *
 * Sagas use the separate `resolveSagaStep` helper, which reads the
 * current step from the saga's internal state instead of requiring
 * an effect handle.
 */
export async function resolveAsk<D extends AnyProcess>(
  def: D,
  opts: ResolveAskOptions<D>,
): Promise<InvokeResult<D, MessageNamesOf<D>>> {
  const replyTo = opts.effect.replyTo;
  if (!replyTo) {
    throw new Error(
      `resolveAsk: effect targeting "${opts.effect.actorType}:${opts.effect.name}" has no replyTo — it was a send, not an ask`,
    );
  }
  if (replyTo.actorType !== def.type) {
    throw new Error(
      `resolveAsk: effect's replyTo.actorType "${replyTo.actorType}" does not match def "${def.type}"`,
    );
  }
  if (!(replyTo.handler in def.handle)) {
    throw new Error(
      `resolveAsk: "${def.type}" has no handler "${replyTo.handler}" to route the reply to`,
    );
  }

  const replyOpts = {
    context: opts.replyContext ?? replyTo.context,
    from: opts.from ?? { type: opts.effect.actorType, name: opts.effect.name },
  };
  let payload: ReplyPayload<unknown, unknown>;
  if (opts.kind === "success") {
    payload = buildSuccessReply(opts.value, replyOpts);
  } else if (opts.kind === "fail") {
    payload = buildFailReply(opts.reason, { ...replyOpts, details: opts.details });
  } else {
    payload = buildDefectReply(opts.error, replyOpts);
  }

  return invokeHandler(def, {
    msgType: replyTo.handler as MessageNamesOf<D>,
    payload: payload as PayloadOf<D, MessageNamesOf<D>>,
    state: opts.state,
    selfName: opts.selfName ?? replyTo.name,
    now: opts.now,
    peek: opts.peek,
  });
}

// ── resolveSagaStep ─────────────────────────────────────────────

/**
 * Neutral reply-result shape: what a handler returned to its caller.
 * Used by saga-step resolution today; reusable for any future helper
 * that needs to synthesize a reply payload from structured fields.
 * Mirrors the discriminated `result` on `ReplyPayload`.
 */
export type ReplyResolution<Value = unknown> =
  | { kind: "success"; value: Value }
  | { kind: "fail"; reason: string; details?: unknown }
  | { kind: "defect"; error: string };

export type ResolveSagaStepOptions<D extends AnySagaDefinition> =
  ReplyResolution & {
    /** Saga state produced by the prior `invokeHandler` call. */
    state: StateOf<D>;
    selfName?: string;
    now?: number;
    peek?: (actorType: string, name: string) => unknown | Promise<unknown>;
    /** Reply-context the original ask carried, if any. */
    replyContext?: unknown;
    /** `from` address stamped on the reply payload. */
    from?: { type: string; name: string };
  };

/**
 * Resolve the ask-reply a saga is currently awaiting. Reads
 * `state._saga.currentStep`, builds the `${step}_reply` payload from
 * the `kind`/`value`/`reason`/`error` fields, and invokes the
 * synthesized reply handler via `invokeHandler`.
 *
 * Lets saga unit tests drive step reply handlers without having to
 * know that the framework synthesizes `${step}_reply` handler names.
 */
export async function resolveSagaStep<D extends AnySagaDefinition>(
  def: D,
  opts: ResolveSagaStepOptions<D>,
): Promise<InvokeResult<D, MessageNamesOf<D>>> {
  const saga = (opts.state as SagaState)._saga as
    | SagaInternalState
    | undefined;
  if (!saga) {
    throw new Error(
      `resolveSagaStep: "${def.type}" state is missing the framework-owned "_saga" slice — is this actually a saga state?`,
    );
  }
  if (saga.phase !== "running" || saga.currentStep === null) {
    throw new Error(
      `resolveSagaStep: saga "${def.type}" is not awaiting an ask reply (phase: ${saga.phase}, currentStep: ${saga.currentStep ?? "null"})`,
    );
  }

  const msgType = `${saga.currentStep}_reply`;
  if (!(msgType in def.handle)) {
    throw new Error(
      `resolveSagaStep: saga "${def.type}" step "${saga.currentStep}" is not an ask step (no "${msgType}" reply handler)`,
    );
  }

  const replyOpts = { context: opts.replyContext, from: opts.from };
  let payload: ReplyPayload<unknown, unknown>;
  if (opts.kind === "success") {
    payload = buildSuccessReply(opts.value, replyOpts);
  } else if (opts.kind === "fail") {
    payload = buildFailReply(opts.reason, { ...replyOpts, details: opts.details });
  } else {
    payload = buildDefectReply(opts.error, replyOpts);
  }

  return invokeHandler(def, {
    msgType: msgType as MessageNamesOf<D>,
    payload: payload as PayloadOf<D, MessageNamesOf<D>>,
    state: opts.state,
    selfName: opts.selfName,
    now: opts.now,
    peek: opts.peek,
  });
}
