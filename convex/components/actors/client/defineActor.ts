/**
 * Actor-facing process definition.
 *
 * An `ActorDefinition` is a `ProcessDefinition` with the `__actor`
 * brand. `defineActor` accepts a user spec whose handlers see the
 * narrow `ActorHandlerCtx` (typed self.send, typed stubs with `ask`
 * constrained by `ValidReplyHandlers`) and wraps each handler to
 * match the stored `InternalProcessCtx` signature. User code never
 * touches the wide runtime ctx.
 */
import { z } from "zod";
import type {
  AnyProcess,
  MessageDef,
  MessageNamesOf,
  ProcessDefinition,
  ProjectionOf,
  ReturnOf,
} from "./defineProcess";
import type { InternalProcessCtx, ScheduleOpts } from "./ctx";

// ── Reply schema helpers ─────────────────────────────────────────

const zActorAddr = z.object({ type: z.string(), name: z.string() });

/**
 * Build a Zod schema for a reply-handler's message payload.
 *
 * Two signatures:
 *   // From an actor definition — extracts response schema automatically
 *   reply(account, "hold", { context: z.object({ holdId: z.string() }) })
 *
 *   // From a raw value schema — for self-referencing actors or external types
 *   reply(z.object({ newBalance: z.number() }), { context: z.object({ to: z.string() }) })
 */
export function reply<
  D extends AnyActorDefinition,
  M extends MessageNamesOf<D>,
  Ctx extends z.ZodTypeAny = z.ZodNull,
>(
  def: D,
  msgType: M,
  opts?: { context: Ctx },
): z.ZodType<ReplyPayload<ReturnOf<D, M>, z.infer<Ctx>>>;
export function reply<
  V extends z.ZodTypeAny,
  Ctx extends z.ZodTypeAny = z.ZodNull,
>(
  valueSchema: V,
  opts?: { context: Ctx },
): z.ZodType<ReplyPayload<z.infer<V>, z.infer<Ctx>>>;
export function reply(
  defOrSchema: AnyActorDefinition | z.ZodTypeAny,
  msgTypeOrOpts?: string | { context?: z.ZodTypeAny },
  opts?: { context?: z.ZodTypeAny },
): z.ZodType<ReplyPayload<unknown, unknown>> {
  let valueSchema: z.ZodTypeAny;
  let ctxSchema: z.ZodTypeAny;

  if (typeof msgTypeOrOpts === "string") {
    // Overload 1: reply(def, msgType, opts?)
    const def = defOrSchema as AnyActorDefinition;
    valueSchema = def.messages[msgTypeOrOpts]?.response ?? z.unknown();
    ctxSchema = opts?.context ?? z.null();
  } else {
    // Overload 2: reply(valueSchema, opts?)
    valueSchema = defOrSchema as z.ZodTypeAny;
    ctxSchema = msgTypeOrOpts?.context ?? z.null();
  }

  return z.object({
    result: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("success"), value: valueSchema }),
      z.object({
        kind: z.literal("fail"),
        reason: z.string(),
        details: z.unknown().optional(),
      }),
      z.object({ kind: z.literal("defect"), error: z.string() }),
    ]),
    context: ctxSchema,
    from: zActorAddr,
  }) as z.ZodType<ReplyPayload<unknown, unknown>>;
}

/**
 * The shape of a reply-handler's payload. Exported so userland can
 * reference the type without constructing a schema.
 */
export type ReplyPayload<Value = unknown, Context = null> = {
  result:
    | { kind: "success"; value: Value }
    | { kind: "fail"; reason: string; details?: unknown }
    | { kind: "defect"; error: string };
  context: Context;
  from: { type: string; name: string };
};

// ── Actor definition ─────────────────────────────────────────────

/**
 * A `ProcessDefinition` branded as an actor. The brand is an empty
 * phantom object at runtime; its job is type-level discrimination so
 * actor-only helpers can reject sagas (and vice versa) at compile
 * time.
 */
export interface ActorDefinition<
  Type extends string = string,
  StateV extends z.ZodTypeAny = z.ZodTypeAny,
  Msgs extends Record<string, MessageDef> = Record<string, MessageDef>,
  Projection = unknown,
> extends ProcessDefinition<Type, StateV, Msgs, Projection> {
  readonly __actor: Record<string, never>;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyActorDefinition = ActorDefinition<string, any, any, any>;

// ── Handler ctx types ────────────────────────────────────────────

/**
 * Typed self-stub on an `ActorHandlerCtx`. `send` is narrowed to the
 * actor's own message names, and `type` is narrowed to the literal
 * `type` field on the actor definition.
 */
export interface SelfStub<Self extends AnyActorDefinition> {
  readonly type: Self["type"];
  readonly name: string;
  send<M extends MessageNamesOf<Self>>(
    msgType: M,
    payload: z.infer<Self["messages"][M]["payload"]>,
    opts?: ScheduleOpts,
  ): void;
}

/**
 * Typed stub returned by `ctx.stub(def, name)` inside an actor
 * handler. Adds `ask` with the `ValidReplyHandlers<Self, D, M>`
 * constraint so only reply-typed handlers whose schema matches the
 * target's return can be passed.
 */
export interface ActorStub<
  D extends AnyProcess,
  Self extends AnyActorDefinition,
> {
  send<M extends MessageNamesOf<D>>(
    msgType: M,
    payload: z.infer<D["messages"][M]["payload"]>,
    opts?: ScheduleOpts,
  ): void;
  peek(): Promise<ProjectionOf<D>>;
  ask<
    M extends MessageNamesOf<D>,
    H extends ValidReplyHandlers<Self, D, M>,
  >(
    msgType: M,
    payload: z.infer<D["messages"][M]["payload"]>,
    opts: AskOpts<Self, H>,
  ): void;
}

/**
 * Typed actor handler context. Generic over `Self` so `self.send`,
 * `ctx.stub(...).ask` and `ValidReplyHandlers` all narrow to the
 * actor's own message names.
 */
export interface ActorHandlerCtx<
  Self extends AnyActorDefinition = AnyActorDefinition,
> {
  self: SelfStub<Self>;
  now(): number;
  fail(reason: string, details?: unknown): never;
  stub<D extends AnyProcess>(def: D, name: string): ActorStub<D, Self>;
}

/**
 * Filters message names on `Self` to only those whose payload is a
 * `ReplyPayload` with a `result.value` matching the target's return
 * type. Prevents pointing `ask()` at a handler that wasn't built with
 * `reply()`.
 */
export type ValidReplyHandlers<
  Self extends AnyActorDefinition,
  D extends AnyProcess,
  M extends MessageNamesOf<D>,
> = {
  [H in MessageNamesOf<Self>]: z.infer<
    Self["messages"][H]["payload"]
  > extends ReplyPayload<ReturnOf<D, M>, unknown>
    ? H
    : never;
}[MessageNamesOf<Self>];

/**
 * Ask options. `context` is required when the reply handler declares
 * one (via `reply(..., { context: schema })`), omittable otherwise.
 */
export type AskOpts<
  Self extends AnyActorDefinition,
  H extends MessageNamesOf<Self>,
> = { handler: H } & ContextParam<ReplyContextOf<Self, H>>;

type ContextParam<C> = [C] extends [null] ? { context?: null } : { context: C };

/**
 * Extract the `context` type from a reply-handler's message schema.
 * Returns `null` when the handler wasn't built with `reply()`.
 */
export type ReplyContextOf<
  D extends AnyActorDefinition,
  H extends MessageNamesOf<D>,
> = z.infer<D["messages"][H]["payload"]> extends { context: infer C } ? C : null;

// ── defineActor ──────────────────────────────────────────────────

/**
 * Spec passed to `defineActor`. Handlers see the narrow
 * `ActorHandlerCtx<Self>`; `defineActor` wraps each one to satisfy
 * the wider `ProcessDefinition.handle[K]` signature.
 */
export type ActorSpec<
  Type extends string,
  StateV extends z.ZodTypeAny,
  Msgs extends Record<string, MessageDef>,
  Projection,
> = {
  type: Type;
  state: StateV;
  messages: Msgs;
  initialState: () => z.infer<StateV>;
  project?: (state: z.infer<StateV>) => Projection;
  handle: {
    [K in keyof Msgs]: (
      state: z.infer<StateV>,
      payload: z.infer<Msgs[K]["payload"]>,
      ctx: ActorHandlerCtx<ActorDefinition<Type, StateV, Msgs, Projection>>,
    ) => Promise<
      Msgs[K]["response"] extends z.ZodTypeAny
        ? z.infer<Msgs[K]["response"]>
        : unknown
    >;
  };
};

/**
 * Build an actor definition. Wraps each user handler so it receives a
 * typed `ActorHandlerCtx<Self>` rather than the wide
 * `InternalProcessCtx` that the process registry expects.
 */
export function defineActor<
  Type extends string,
  StateV extends z.ZodTypeAny,
  Msgs extends Record<string, MessageDef>,
  Projection = undefined,
>(
  spec: ActorSpec<Type, StateV, Msgs, Projection>,
): ActorDefinition<Type, StateV, Msgs, Projection> {
  type Self = ActorDefinition<Type, StateV, Msgs, Projection>;

  const wrappedHandle: Record<
    string,
    (
      state: z.infer<StateV>,
      payload: unknown,
      ctx: InternalProcessCtx,
    ) => Promise<unknown>
  > = {};

  for (const msgType of Object.keys(spec.handle)) {
    const userHandler = (
      spec.handle as Record<
        string,
        (
          state: z.infer<StateV>,
          payload: unknown,
          ctx: ActorHandlerCtx<Self>,
        ) => Promise<unknown>
      >
    )[msgType];
    wrappedHandle[msgType] = async (state, payload, internalCtx) => {
      const actorCtx = makeActorCtx<Self>(internalCtx);
      return userHandler(state, payload, actorCtx);
    };
  }

  return {
    type: spec.type,
    state: spec.state,
    messages: spec.messages,
    initialState: spec.initialState,
    project: spec.project,
    handle: wrappedHandle as ActorDefinition<
      Type,
      StateV,
      Msgs,
      Projection
    >["handle"],
    __actor: {},
  };
}

/**
 * Wrap an `InternalProcessCtx` into a typed `ActorHandlerCtx<Self>`.
 * The stub `ask` method delegates to the internal `pushAsk` primitive;
 * all type-level enforcement of `ValidReplyHandlers` lives in the
 * `ActorStub.ask` signature, not at the runtime layer.
 */
function makeActorCtx<Self extends AnyActorDefinition>(
  internalCtx: InternalProcessCtx,
): ActorHandlerCtx<Self> {
  const selfStub: SelfStub<Self> = {
    type: internalCtx.self.type as Self["type"],
    name: internalCtx.self.name,
    send(msgType, payload, opts) {
      internalCtx.self.send(msgType, payload, opts);
    },
  };

  return {
    self: selfStub,
    now: () => internalCtx.now(),
    fail: (reason, details) => internalCtx.fail(reason, details),
    stub<D extends AnyProcess>(def: D, name: string): ActorStub<D, Self> {
      const base = internalCtx.stub(def, name);
      return {
        send: base.send.bind(base),
        peek: base.peek.bind(base),
        ask(msgType, payload, opts) {
          internalCtx.pushAsk(
            def,
            name,
            msgType,
            payload,
            opts.handler,
            opts.context ?? null,
          );
        },
      };
    },
  };
}
