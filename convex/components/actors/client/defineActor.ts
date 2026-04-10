import type { z } from "zod";

/**
 * Definition of an actor. Plain data object — `defineActor` is a pure
 * identity function whose only job is to pin the literal `type` field
 * and infer the state / payload / projection types from the attached
 * Zod schemas and `project` return type.
 *
 * Handler ctx is typed as `ActorHandlerCtx<Self>` where Self is the
 * actor's own definition, giving handlers full type safety for
 * `sendSelf`, `stub`, and `fail`.
 */
export interface ActorDefinition<
  Type extends string = string,
  StateV extends z.ZodTypeAny = z.ZodTypeAny,
  Msgs extends Record<string, z.ZodTypeAny> = Record<string, z.ZodTypeAny>,
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
      payload: z.infer<Msgs[K]>,
      ctx: ActorHandlerCtx<ActorDefinition<Type, StateV, Msgs, Projection>>,
    ) => Promise<unknown>;
  };
}

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
  stub<D extends AnyActorDefinition>(
    def: D,
    name: string,
  ): ActorStub<D>;
  sendSelf<M extends MessageNamesOf<Self>>(
    msgType: M,
    payload: z.infer<Self["messages"][M]>,
    opts?: { at?: number; after?: number },
  ): void;
  fail(reason: string, details?: unknown): never;
}

/**
 * Typed stub handle returned by `ctx.stub(def, name)`. Defined here so
 * `ActorHandlerCtx` can reference it without importing from ctx.ts.
 */
export interface ActorStub<D extends AnyActorDefinition> {
  send<M extends MessageNamesOf<D>>(
    msgType: M,
    payload: z.infer<D["messages"][M]>,
    opts?: { at?: number; after?: number },
  ): void;
  peek(): Promise<ProjectionOf<D>>;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyActorDefinition = ActorDefinition<string, any, any, any>;

export type StateOf<D extends AnyActorDefinition> = z.infer<D["state"]>;

export type PayloadOf<
  D extends AnyActorDefinition,
  M extends keyof D["messages"],
> = z.infer<D["messages"][M]>;

export type ProjectionOf<D extends AnyActorDefinition> =
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  D extends ActorDefinition<any, any, any, infer P> ? P : never;

export type MessageNamesOf<D extends AnyActorDefinition> =
  keyof D["messages"] & string;

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
  Msgs extends Record<string, z.ZodTypeAny>,
  Projection = undefined,
>(
  def: ActorDefinition<Type, StateV, Msgs, Projection>,
): ActorDefinition<Type, StateV, Msgs, Projection> {
  return def;
}
