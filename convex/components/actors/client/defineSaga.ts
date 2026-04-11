import { z } from "zod";
import type {
  AnyActorDefinition,
  ActorDefinition,
  ActorHandlerCtx,
  ActorStub,
  MessageDef,
  MessageNamesOf,
  ReplyPayload,
  ReturnOf,
} from "./defineActor";
import { reply } from "./defineActor";
import { FailSentinel } from "./ctx";

// ── Ask Descriptor ──────────────────────────────────────────────

export interface AskDescriptor<_Value = unknown> {
  readonly __sagaAsk: true;
  readonly def: AnyActorDefinition;
  readonly name: string;
  readonly msgType: string;
  readonly payload: unknown;
}

function isAskDescriptor(x: unknown): x is AskDescriptor {
  return (
    typeof x === "object" &&
    x !== null &&
    (x as { __sagaAsk?: boolean }).__sagaAsk === true
  );
}

// ── Saga context types ──────────────────────────────────────────

export interface SagaStepCtx {
  self(): { type: string; name: string };
  now(): number;
  stub<D extends AnyActorDefinition>(def: D, name: string): ActorStub<D>;
  ask<D extends AnyActorDefinition, M extends MessageNamesOf<D>>(
    def: D,
    name: string,
    msgType: M,
    payload: z.infer<D["messages"][M]["payload"]>,
  ): AskDescriptor<ReturnOf<D, M>>;
  fail(reason: string, details?: unknown): never;
}

export interface SagaCompensateCtx {
  self(): { type: string; name: string };
  now(): number;
  stub<D extends AnyActorDefinition>(def: D, name: string): ActorStub<D>;
}

// ── Step types ──────────────────────────────────────────────────

export interface StepTransition<StepNames extends string, Context> {
  next: StepNames | null;
  context?: Context;
}

interface SyncSagaStep<Input, Context, StepNames extends string> {
  run: (
    input: Input,
    context: Context,
    ctx: SagaStepCtx,
  ) => StepTransition<StepNames, Context>;
  onSuccess?: never;
  compensate?: (
    input: Input,
    context: Context,
    ctx: SagaCompensateCtx,
  ) => void;
}

interface AskSagaStep<Input, Context, StepNames extends string> {
  run: (
    input: Input,
    context: Context,
    ctx: SagaStepCtx,
  ) => AskDescriptor;
  onSuccess: (
    value: unknown,
    input: Input,
    context: Context,
  ) => StepTransition<StepNames, Context>;
  compensate?: (
    input: Input,
    context: Context,
    ctx: SagaCompensateCtx,
  ) => void;
}

export type SagaStep<
  Input,
  Context,
  StepNames extends string,
> =
  | SyncSagaStep<Input, Context, StepNames>
  | AskSagaStep<Input, Context, StepNames>;

// ── Saga projection ─────────────────────────────────────────────

export type SagaPhase =
  | "idle"
  | "running"
  | "completed"
  | "failed";

/**
 * Public, client-safe projection of a saga's lifecycle. Deliberately
 * carries *only step names and phase* — no inputs, contexts, ask values,
 * or context snapshots — so sagas whose state might contain sensitive
 * payloads are safe to expose via `system.peek`.
 *
 * Generic over `StepNames` so that `defineSaga`'s return-type brand can
 * narrow `currentStep` / `completedSteps` / `failedStep` to a specific
 * saga's step-name union in client helpers.
 */
export type SagaProjection<StepNames extends string = string> = {
  phase: SagaPhase;
  currentStep: StepNames | null;
  completedSteps: StepNames[];
  /** Step whose failure triggered compensation, or null on success / before failure. */
  failedStep: StepNames | null;
  failReason: string | undefined;
};

// ── Internal saga state ─────────────────────────────────────────

export interface SagaState<Input = unknown, Context = unknown> {
  phase: SagaPhase;
  currentStep: string | null;
  completedSteps: Array<{ name: string; contextSnapshot: Context }>;
  input: Input;
  context: Context;
  failReason?: string;
  /** Set by `startCompensation` from the currentStep at failure time. */
  failedStep?: string;
}

// ── Internal helpers ────────────────────────────────────────────

/**
 * Emit an ask effect bypassing ValidReplyHandlers. The saga framework
 * generates reply handlers dynamically and manages type safety at a
 * higher level — the TypeScript-level constraint doesn't apply here.
 *
 * This is the main pain point of compiling sagas into ActorDefinitions
 * rather than sharing a lower-level BaseProcessCtx. If a third process
 * type needs a similar bypass, extract a base ctx with an unguarded
 * pushEffect / ask instead of duplicating this pattern.
 */
function emitAsk(
  ctx: ActorHandlerCtx,
  descriptor: AskDescriptor,
  replyHandler: string,
): void {
  type RawAsk = (
    def: AnyActorDefinition,
    name: string,
    msgType: string,
    payload: unknown,
    opts: { handler: string; context: unknown },
  ) => void;
  (ctx.ask as RawAsk)(
    descriptor.def,
    descriptor.name,
    descriptor.msgType,
    descriptor.payload,
    { handler: replyHandler, context: null },
  );
}

function snapshotValue<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

// ── Saga step ctx factories ─────────────────────────────────────

function makeSagaStepCtx(actorCtx: ActorHandlerCtx): SagaStepCtx {
  return {
    self: () => actorCtx.self(),
    now: () => actorCtx.now(),
    stub: (def, name) => actorCtx.stub(def, name),
    // TODO: Move ask method to actor stub instead of here
    ask(def, name, msgType, payload) {
      const schema = def.messages[String(msgType)]?.payload;
      if (!schema) {
        throw new Error(
          `saga ask: unknown msgType "${String(msgType)}" on actor "${def.type}"`,
        );
      }
      const parsed = schema.safeParse(payload);
      if (!parsed.success) {
        throw new Error(
          `saga ask: invalid payload for "${def.type}.${String(msgType)}": ${parsed.error.message}`,
        );
      }
      return {
        __sagaAsk: true as const,
        def,
        name,
        msgType: String(msgType),
        payload: parsed.data,
      };
    },
    fail: (reason, details) => actorCtx.fail(reason, details),
  };
}

function makeSagaCompensateCtx(
  actorCtx: ActorHandlerCtx,
): SagaCompensateCtx {
  return {
    self: () => actorCtx.self(),
    now: () => actorCtx.now(),
    stub: (def, name) => actorCtx.stub(def, name),
  };
}

// ── Core step execution logic ───────────────────────────────────

/**
 * Execute the step chain starting from `state.currentStep`. Chains
 * through sync steps in a loop; breaks on an ask step (emits the ask
 * effect and returns, waiting for the reply message).
 */
function runStepChain<Input, Context, StepNames extends string>(
  state: SagaState<Input, Context>,
  steps: Record<string, SagaStep<Input, Context, StepNames>>,
  actorCtx: ActorHandlerCtx,
): void {
  while (state.currentStep !== null) {
    const stepName = state.currentStep;
    const step = steps[stepName];
    if (!step) {
      throw new Error(`saga: unknown step "${stepName}"`);
    }

    const sagaCtx = makeSagaStepCtx(actorCtx);
    const result = step.run(state.input, state.context, sagaCtx);

    if (isAskDescriptor(result)) {
      // Compile-time: AskSagaStep requires onSuccess. Runtime safety net:
      if (!step.onSuccess) {
        throw new Error(
          `saga: step "${stepName}" returned an ask descriptor but has no onSuccess handler`,
        );
      }
      // Don't push to completedSteps yet — the ask hasn't succeeded.
      // The reply handler pushes on success so compensation only runs
      // for steps whose external action actually completed.
      emitAsk(actorCtx, result, `${stepName}_reply`);
      return;
    }

    // Sync step — apply transition inline and continue
    const transition = result;
    state.completedSteps.push({
      name: stepName,
      contextSnapshot: snapshotValue(state.context),
    });
    if (transition.context !== undefined) {
      state.context = transition.context;
    }
    if (transition.next === null) {
      state.phase = "completed";
      state.currentStep = null;
      return;
    }
    if (!(transition.next in steps)) {
      throw new Error(
        `saga: step "${stepName}" transitioned to unknown step "${transition.next}"`,
      );
    }
    state.currentStep = transition.next;
  }
}

/**
 * Run compensation handlers in reverse completion order. Each
 * compensate receives the context snapshot from when its step ran.
 * Compensation handlers can only fire-and-forget via stubs.
 */
function startCompensation<Input, Context, StepNames extends string>(
  state: SagaState<Input, Context>,
  steps: Record<string, SagaStep<Input, Context, StepNames>>,
  actorCtx: ActorHandlerCtx,
): void {
  // Record which step triggered compensation before we clear currentStep.
  // Whether the step ran fully (and is in completedSteps) or failed
  // mid-ask, `state.currentStep` is the name that was active at failure.
  if (state.currentStep !== null) {
    state.failedStep = state.currentStep;
  }
  const reversed = [...state.completedSteps].reverse();
  for (const { name, contextSnapshot } of reversed) {
    const step = steps[name];
    if (step?.compensate) {
      try {
        const compensateCtx = makeSagaCompensateCtx(actorCtx);
        step.compensate(state.input, contextSnapshot, compensateCtx);
      } catch {
        // Best-effort: continue compensating remaining steps even if one throws
      }
    }
  }
  state.phase = "failed";
  state.currentStep = null;
}

// ── defineSaga ──────────────────────────────────────────────────

export function defineSaga<
  Type extends string,
  InputV extends z.ZodTypeAny,
  ContextV extends z.ZodTypeAny,
  Steps extends Record<
    string,
    SagaStep<z.infer<InputV>, z.infer<ContextV>, string & keyof Steps>
  >,
>(spec: {
  type: Type;
  input: InputV;
  context: ContextV;
  initialContext: () => z.infer<ContextV>;
  firstStep: string & keyof Steps;
  steps: Steps;
}): SagaDefinition<Type, InputV, ContextV, Steps> {
  // ── Validate spec ──
  if (!(spec.firstStep in spec.steps)) {
    throw new Error(
      `defineSaga "${spec.type}": firstStep "${String(spec.firstStep)}" is not a defined step`,
    );
  }

  type Input = z.infer<InputV>;
  type Context = z.infer<ContextV>;
  type State = SagaState<Input, Context>;
  type StepNames = string & keyof Steps;

  // ── Build state schema ──
  const sagaStateSchema = z.object({
    phase: z.enum(["idle", "running", "completed", "failed"]),
    currentStep: z.string().nullable(),
    completedSteps: z.array(
      z.object({ name: z.string(), contextSnapshot: spec.context }),
    ),
    input: spec.input,
    context: spec.context,
    failReason: z.string().optional(),
    failedStep: z.string().optional(),
  });

  const { steps } = spec;

  // ── Build messages ──
  const messages: { start: { payload: InputV } } & Record<string, MessageDef> = {
    start: { payload: spec.input },
  };
  for (const stepName of Object.keys(steps)) {
    if (steps[stepName].onSuccess) {
      messages[`${stepName}_reply`] = { payload: reply(z.unknown()) };
    }
  }

  const handle: Record<
    string,
    (
      state: State,
      payload: unknown,
      ctx: ActorHandlerCtx,
    ) => Promise<unknown>
  > = {};

  handle.start = async (state, payload, actorCtx) => {
    if (state.phase !== "idle") {
      actorCtx.fail("saga_already_started", { currentPhase: state.phase });
    }
    state.phase = "running";
    state.input = payload as Input;
    state.context = spec.initialContext();
    state.completedSteps = [];
    state.currentStep = spec.firstStep;

    try {
      runStepChain<Input, Context, StepNames>(state, steps, actorCtx);
    } catch (e) {
      if (e instanceof FailSentinel) {
        state.failReason = e.reason;
        startCompensation<Input, Context, StepNames>(state, steps, actorCtx);
        return;
      }
      throw e;
    }
  };

  for (const stepName of Object.keys(steps)) {
    const step = steps[stepName];
    if (!step.onSuccess) continue;

    handle[`${stepName}_reply`] = async (state, payload, actorCtx) => {
      if (state.phase !== "running") return; // stale reply on finished saga
      const { result } = payload as ReplyPayload;

      if (result.kind !== "success") {
        state.failReason =
          result.kind === "fail" ? result.reason : result.error;
        startCompensation<Input, Context, StepNames>(state, steps, actorCtx);
        return;
      }

      try {
        // Ask succeeded — now mark the step as completed
        state.completedSteps.push({
          name: stepName,
          contextSnapshot: snapshotValue(state.context),
        });

        const transition = step.onSuccess!(
          result.value,
          state.input,
          state.context,
        );
        if (transition.context !== undefined) {
          state.context = transition.context;
        }
        if (transition.next === null) {
          state.phase = "completed";
          state.currentStep = null;
          return;
        }
        if (!(transition.next in steps)) {
          throw new Error(
            `saga "${spec.type}": onSuccess for "${stepName}" transitioned to unknown step "${transition.next}"`,
          );
        }
        state.currentStep = transition.next;
        runStepChain<Input, Context, StepNames>(state, steps, actorCtx);
      } catch (e) {
        if (e instanceof FailSentinel) {
          state.failReason = e.reason;
          startCompensation<Input, Context, StepNames>(state, steps, actorCtx);
          return;
        }
        throw e;
      }
    };
  }

  // ── Assemble definition ──
  // The object is a valid ActorDefinition at runtime. The return type
  // narrows messages to expose only `start` to external callers while
  // internal reply handlers remain accessible at runtime.
  return {
    type: spec.type,
    state: sagaStateSchema,
    messages,
    initialState: (): State => ({
      phase: "idle",
      currentStep: null,
      completedSteps: [],
      input: null as Input,
      context: spec.initialContext(),
      failReason: undefined,
      failedStep: undefined,
    }),
    project: (state: State): SagaProjection<StepNames> => ({
      phase: state.phase,
      currentStep: state.currentStep as StepNames | null,
      completedSteps: state.completedSteps.map((s) => s.name) as StepNames[],
      failedStep: (state.failedStep ?? null) as StepNames | null,
      failReason: state.failReason,
    }),
    handle,
  } as unknown as SagaDefinition<Type, InputV, ContextV, Steps>;
}

// ── Saga definition brand ───────────────────────────────────────

/**
 * Return type of `defineSaga`. At runtime this is a plain
 * `ActorDefinition` (the actor system sees it that way). The `__saga`
 * phantom field is compile-time only — it carries the Steps/Input/Context
 * generics so client helpers like `createSagaAwaiter` can narrow
 * projection step names to the saga's own step union.
 */
export type SagaDefinition<
  Type extends string,
  InputV extends z.ZodTypeAny,
  ContextV extends z.ZodTypeAny,
  Steps,
> = ActorDefinition<
  Type,
  z.ZodTypeAny,
  { start: { payload: InputV } } & Record<string, MessageDef>,
  SagaProjection<string & keyof Steps>
> & {
  readonly __saga: {
    steps: Steps;
    input: z.infer<InputV>;
    context: z.infer<ContextV>;
  };
};

/**
 * Top of the saga-definition hierarchy. Use as a generic constraint
 * (`<D extends AnySagaDefinition>`) when a helper needs the __saga brand
 * without caring about the specific shape. Every `defineSaga(...)` result
 * is assignable to this.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnySagaDefinition = AnyActorDefinition & {
  readonly __saga: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    steps: any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    input: any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    context: any;
  };
};

/** Step-name union extracted from a saga definition's phantom brand. */
export type StepNamesOf<D extends AnySagaDefinition> =
  string & keyof D["__saga"]["steps"];

/** Saga's declared input type — the payload of `start`. */
export type SagaInputOf<D extends AnySagaDefinition> = D["__saga"]["input"];

/** Saga's declared context type. */
export type SagaContextOf<D extends AnySagaDefinition> = D["__saga"]["context"];

/** Fully-narrowed projection shape for a specific saga definition. */
export type SagaProjectionOf<D extends AnySagaDefinition> =
  SagaProjection<StepNamesOf<D>>;
