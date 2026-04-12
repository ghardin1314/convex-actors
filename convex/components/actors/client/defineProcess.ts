/**
 * Core process abstraction shared by actors and sagas.
 *
 * A `ProcessDefinition` is what `execute.ts` dispatches against and
 * what `ActorSystem` registers: state schema + message schemas +
 * handlers. Actor and saga definitions (`ActorDefinition` in
 * `defineActor.ts`, `SagaDefinition` in `defineSaga.ts`) are
 * brand-narrowed views of this type.
 *
 * Stored handlers take the wide `InternalProcessCtx`. Per-kind
 * narrowing (typed `ask`, typed `self.send`) happens inside
 * `defineActor` / `defineSaga` by wrapping user handlers.
 */
import type { z } from "zod";
import type { InternalProcessCtx } from "./ctx";

// ── Message definition shape ────────────────────────────────────

/** Each message is defined as `{ payload: ZodSchema, response?: ZodSchema }`. */
export interface MessageDef {
  payload: z.ZodTypeAny;
  response?: z.ZodTypeAny;
}

// ── Process definition ──────────────────────────────────────────

/**
 * The stored shape of a process. Handler ctx is the wide
 * `InternalProcessCtx`; `defineActor` and `defineSaga` wrap user
 * handlers so user code sees a narrower ctx.
 */
export interface ProcessDefinition<
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
      ctx: InternalProcessCtx,
    ) => Promise<
      Msgs[K]["response"] extends z.ZodTypeAny
        ? z.infer<Msgs[K]["response"]>
        : unknown
    >;
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyProcess = ProcessDefinition<string, any, any, any>;

// ── Utility types ────────────────────────────────────────────────

export type StateOf<D extends AnyProcess> = z.infer<D["state"]>;

export type PayloadOf<
  D extends AnyProcess,
  M extends keyof D["messages"],
> = z.infer<D["messages"][M]["payload"]>;

export type ProjectionOf<D extends AnyProcess> =
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  D extends ProcessDefinition<any, any, any, infer P> ? P : never;

export type MessageNamesOf<D extends AnyProcess> =
  keyof D["messages"] & string;

/** Infer the return type of a handler from the message's `response` schema. */
export type ReturnOf<
  D extends AnyProcess,
  M extends MessageNamesOf<D>,
> = D["messages"][M]["response"] extends z.ZodTypeAny
  ? z.infer<D["messages"][M]["response"]>
  : unknown;

/** Response envelope, generic over the success value. */
export type ActorResponse<T = unknown> =
  | { kind: "success"; value: T }
  | { kind: "fail"; reason: string; details?: unknown }
  | { kind: "defect"; error: string; attempts: number };

export type ResponseEnvelope<T = unknown> = {
  messageId: string;
  response: ActorResponse<T>;
};
