import { z } from "zod";

// ── Message definition shape ────────────────────────────────────

/** Each message is defined as `{ payload: ZodSchema, response?: ZodSchema }`. */
export interface MessageDef {
  payload: z.ZodTypeAny;
  response?: z.ZodTypeAny;
}

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
 * Definition of an actor. Plain data object — `defineActor` is a pure
 * identity function whose only job is to pin the literal `type` field
 * and infer the state / payload / projection / return types from the
 * attached Zod schemas and `project` return type.
 */
export interface ActorDefinition<
  Type extends string = string,
  StateV extends z.ZodTypeAny = z.ZodTypeAny,
  Msgs extends Record<string, MessageDef> = Record<string, MessageDef>,
  Projection = unknown,
> {
  type: Type;
  state: StateV;
  messages: Msgs;
  initialState: () => z.infer<StateV>;
  project?: (state: z.infer<StateV>) => Projection;
  handle: {
    [K in keyof Msgs]: (
      state: z.infer<StateV>,
      payload: z.infer<Msgs[K]["payload"]>,
      ctx: ActorHandlerCtx<
        ActorDefinition<Type, StateV, Msgs, Projection>
      >,
    ) => Promise<
      Msgs[K]["response"] extends z.ZodTypeAny
        ? z.infer<Msgs[K]["response"]>
        : unknown
    >;
  };
}

// ── Handler context types ────────────────────────────────────────

/**
 * Typed handler context. Generic over `Self` (the actor's own definition)
 * so that `sendSelf` knows the actor's message names and payloads, and
 * `stub` accepts any actor definition and returns a typed stub.
 *
 * Defined here (not in ctx.ts) to avoid a circular import: ctx.ts imports
 * `AnyActorDefinition` from this file.
 */
export interface ActorHandlerCtx<
  Self extends AnyActorDefinition = AnyActorDefinition,
> {
  self(): { type: string; name: string };
  now(): number;
  stub<D extends AnyActorDefinition>(def: D, name: string): ActorStub<D>;
  sendSelf<M extends MessageNamesOf<Self>>(
    msgType: M,
    payload: z.infer<Self["messages"][M]["payload"]>,
    opts?: { at?: number; after?: number },
  ): void;
  /** Send a message and route the response back as a new message to this actor.
   *  The handler must be a reply-typed message whose `result.value` matches the
   *  target handler's return type. */
  ask<
    D extends AnyActorDefinition,
    M extends MessageNamesOf<D>,
    H extends ValidReplyHandlers<Self, D, M>,
  >(
    def: D,
    name: string,
    msgType: M,
    payload: z.infer<D["messages"][M]["payload"]>,
    opts: AskOpts<Self, H>,
  ): void;
  fail(reason: string, details?: unknown): never;
}

/**
 * Filters message names on Self to only those whose payload is a
 * `ReplyPayload` with a `result.value` matching the target's return type.
 * Prevents pointing `ask()` at a handler that wasn't built with `reply()`.
 */
export type ValidReplyHandlers<
  Self extends AnyActorDefinition,
  D extends AnyActorDefinition,
  M extends MessageNamesOf<D>,
> = {
  [H in MessageNamesOf<Self>]: z.infer<Self["messages"][H]["payload"]> extends ReplyPayload<
    ReturnOf<D, M>,
    unknown
  >
    ? H
    : never;
}[MessageNamesOf<Self>];

/**
 * Ask options. `context` is required when the reply handler declares one
 * (via `reply(..., { context: schema })`), omittable otherwise.
 */
export type AskOpts<
  Self extends AnyActorDefinition,
  H extends MessageNamesOf<Self>,
> = { handler: H } & ContextParam<ReplyContextOf<Self, H>>;

type ContextParam<C> = [C] extends [null] ? { context?: null } : { context: C };

/**
 * Typed stub handle returned by `ctx.stub(def, name)`. Defined here so
 * `ActorHandlerCtx` can reference it without importing from ctx.ts.
 */
export interface ActorStub<D extends AnyActorDefinition> {
  send<M extends MessageNamesOf<D>>(
    msgType: M,
    payload: z.infer<D["messages"][M]["payload"]>,
    opts?: { at?: number; after?: number },
  ): void;
  peek(): Promise<ProjectionOf<D>>;
}

// ── Utility types ────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyActorDefinition = ActorDefinition<string, any, any, any>;

export type StateOf<D extends AnyActorDefinition> = z.infer<D["state"]>;

export type PayloadOf<
  D extends AnyActorDefinition,
  M extends keyof D["messages"],
> = z.infer<D["messages"][M]["payload"]>;

export type ProjectionOf<D extends AnyActorDefinition> =
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  D extends ActorDefinition<any, any, any, infer P> ? P : never;

export type MessageNamesOf<D extends AnyActorDefinition> =
  keyof D["messages"] & string;

/** Infer the return type of a handler from the message's `response` schema. */
export type ReturnOf<
  D extends AnyActorDefinition,
  M extends MessageNamesOf<D>,
> = D["messages"][M]["response"] extends z.ZodTypeAny
  ? z.infer<D["messages"][M]["response"]>
  : unknown;

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
 * Pure identity function: `defineActor(spec)` returns `spec`. The work
 * happens in the type parameters, which capture the literal `type` and
 * the Zod schema shapes so downstream APIs (`ActorSystem`, stubs,
 * `send`) can enforce `(type, name) -> payload` at the call site.
 *
 * No runtime side effects — registration happens later in
 * `new ActorSystem(...)`.
 */
export function defineActor<
  Type extends string,
  StateV extends z.ZodTypeAny,
  Msgs extends Record<string, MessageDef>,
  Projection = undefined,
>(
  def: ActorDefinition<Type, StateV, Msgs, Projection>,
): ActorDefinition<Type, StateV, Msgs, Projection> {
  return def;
}
