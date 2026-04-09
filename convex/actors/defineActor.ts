import type { Infer, Validator } from "convex/values";

/**
 * Definition of an actor. Plain data object — `defineActor` is a pure
 * identity function whose only job is to pin the literal `type` field
 * and infer the state / payload / projection types from the attached
 * validators and `project` return type.
 *
 * See SPEC §Defining actors for semantics (initialState, project as the
 * public surface, handler wrapping in Immer, payload validation timing).
 *
 * The `ActorCtx` parameter on each handler is currently typed as an
 * opaque placeholder that will be fleshed out in Step 4.1 (`ctx.ts`).
 * Handlers receive the full narrow surface described in SPEC §Handler
 * ctx at runtime — this type just keeps them from reaching into
 * anything that isn't on that surface.
 */
export interface ActorDefinition<
  Type extends string = string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  StateV extends Validator<any, "required", any> = Validator<
    unknown,
    "required",
    string
  >,
  Msgs extends Record<
    string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    Validator<any, "required", any>
  > = Record<string, Validator<unknown, "required", string>>,
  Projection = unknown,
> {
  type: Type;
  state: StateV;
  messages: Msgs;
  initialState: () => Infer<StateV>;
  project?: (state: Infer<StateV>) => Projection;
  handle: {
    [K in keyof Msgs]: (
      state: Infer<StateV>,
      payload: Infer<Msgs[K]>,
      ctx: ActorHandlerCtx,
    ) => Promise<unknown>;
  };
}

/**
 * Structural placeholder for the full `ActorCtx` built in Step 4.1.
 * Declared here so `ActorDefinition` can reference it without a circular
 * import. Step 4.1 will export a richer `ActorCtx<SelfDef>` from
 * `ctx.ts`; consumers that want the full surface should import from
 * there once it exists.
 */
export interface ActorHandlerCtx {
  self(): { type: string; name: string };
  now(): number;
  // stub / sendSelf / fail land in Step 4.1
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyActorDefinition = ActorDefinition<string, any, any, any>;

export type StateOf<D extends AnyActorDefinition> = Infer<D["state"]>;

export type PayloadOf<
  D extends AnyActorDefinition,
  M extends keyof D["messages"],
> = Infer<D["messages"][M]>;

export type ProjectionOf<D extends AnyActorDefinition> =
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  D extends ActorDefinition<any, any, any, infer P> ? P : never;

export type MessageNamesOf<D extends AnyActorDefinition> =
  keyof D["messages"] & string;

/**
 * Pure identity function: `defineActor(spec)` returns `spec`. The work
 * happens in the type parameters, which capture the literal `type` and
 * the validator shapes so downstream APIs (`ActorSystem`, stubs,
 * `send`) can enforce `(type, name) -> payload` at the call site.
 *
 * No runtime side effects — registration happens later in
 * `new ActorSystem(...)`.
 */
export function defineActor<
  Type extends string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  StateV extends Validator<any, "required", any>,
  Msgs extends Record<
    string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    Validator<any, "required", any>
  >,
  Projection = undefined,
>(
  def: ActorDefinition<Type, StateV, Msgs, Projection>,
): ActorDefinition<Type, StateV, Msgs, Projection> {
  return def;
}
