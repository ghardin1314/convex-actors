/**
 * Saga-facing process definition.
 *
 * A `SagaDefinition` is a `ProcessDefinition` with the `__saga`
 * brand. `defineSaga` compiles a user spec (steps + transitions +
 * compensation) into a process whose synthesized handlers drive a
 * step machine: `start` kicks off the first step; each ask step's
 * `${stepName}_reply` handler fires on response and walks to the
 * next step; compensation runs on any failure.
 *
 * Saga state is split into framework-owned `_saga` bookkeeping
 * (phase, currentStep, completedSteps, failReason, failedStep) and
 * user-owned `input` / `context`. Synthesized handlers close over
 * the wide `InternalProcessCtx` and call `pushAsk` directly — no
 * bypass, no type cast.
 *
 * User step code sees a narrow `SagaStepCtx` whose `stub(...).ask`
 * returns an `AskDescriptor` that the runner emits as an ask effect.
 * User compensate code sees a narrower `SagaCompensateCtx` whose
 * stubs are send-only — compensation has to be reliable, and
 * ask-based flows would reintroduce failure modes into the recovery
 * path.
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
import type { BaseStub, InternalProcessCtx, ScheduleOpts } from "./ctx";
import { FailSentinel } from "./ctx";
import type { ReplyPayload } from "./defineActor";
import { reply } from "./defineActor";

// ── Ask descriptor ──────────────────────────────────────────────

/**
 * Data returned from `sagaStub.ask()` inside a saga step. The step
 * returns it; the runner recognises it and emits the corresponding
 * ask effect via `internalCtx.pushAsk`.
 */
export interface AskDescriptor<_Value = unknown> {
  readonly __sagaAsk: true;
  readonly def: AnyProcess;
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

// ── Saga ctx types ──────────────────────────────────────────────

/**
 * Stub returned by `ctx.stub(def, name)` inside a saga step. `ask`
 * returns an `AskDescriptor` instead of emitting an effect — the
 * runner consumes the descriptor and wires it to the generated
 * `${stepName}_reply` handler.
 */
export interface SagaStub<D extends AnyProcess> {
  send<M extends MessageNamesOf<D>>(
    msgType: M,
    payload: z.infer<D["messages"][M]["payload"]>,
    opts?: ScheduleOpts,
  ): void;
  peek(): Promise<ProjectionOf<D>>;
  ask<M extends MessageNamesOf<D>>(
    msgType: M,
    payload: z.infer<D["messages"][M]["payload"]>,
  ): AskDescriptor<ReturnOf<D, M>>;
}

/**
 * Compensate-only stub — send + peek, no ask. Compensation runs
 * once, best-effort, with no error-recovery path beyond
 * `try/catch` in the runner; asking here would reintroduce the
 * same failures that triggered compensation in the first place.
 */
export type SagaCompensateStub<D extends AnyProcess> = BaseStub<D>;

export interface SagaStepCtx {
  readonly self: { readonly type: string; readonly name: string };
  now(): number;
  fail(reason: string, details?: unknown): never;
  stub<D extends AnyProcess>(def: D, name: string): SagaStub<D>;
}

export interface SagaCompensateCtx {
  readonly self: { readonly type: string; readonly name: string };
  now(): number;
  stub<D extends AnyProcess>(def: D, name: string): SagaCompensateStub<D>;
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

export type SagaPhase = "idle" | "running" | "completed" | "failed";

/**
 * Public, client-safe projection of a saga's lifecycle. Deliberately
 * carries *only step names and phase* — no inputs, contexts, ask
 * values, or context snapshots — so sagas whose state might contain
 * sensitive payloads are safe to expose via `system.peek`.
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

/**
 * Framework-owned saga bookkeeping. Lives under `state._saga` in the
 * full saga state shape so the split from user-owned
 * `input` / `context` is explicit in both type and runtime.
 */
export interface SagaInternalState<Context = unknown> {
  phase: SagaPhase;
  currentStep: string | null;
  completedSteps: Array<{ name: string; contextSnapshot: Context }>;
  failReason?: string;
  /** Set by `startCompensation` from the currentStep at failure time. */
  failedStep?: string;
}

export interface SagaState<Input = unknown, Context = unknown> {
  _saga: SagaInternalState<Context>;
  input: Input;
  context: Context;
}

// ── Internal helpers ────────────────────────────────────────────

function snapshotValue<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

function makeSagaStepCtx(internalCtx: InternalProcessCtx): SagaStepCtx {
  return {
    self: { type: internalCtx.self.type, name: internalCtx.self.name },
    now: () => internalCtx.now(),
    fail: (reason, details) => internalCtx.fail(reason, details),
    stub<D extends AnyProcess>(def: D, name: string): SagaStub<D> {
      const base = internalCtx.stub(def, name);
      return {
        send: base.send.bind(base),
        peek: base.peek.bind(base),
        ask(msgType, payload) {
          const schema = def.messages[msgType]?.payload;
          if (!schema) {
            throw new Error(
              `saga ask: unknown msgType "${msgType}" on process "${def.type}"`,
            );
          }
          const parsed = schema.safeParse(payload);
          if (!parsed.success) {
            throw new Error(
              `saga ask: invalid payload for "${def.type}.${msgType}": ${parsed.error.message}`,
            );
          }
          const descriptor: AskDescriptor<ReturnOf<D, typeof msgType>> = {
            __sagaAsk: true,
            def,
            name,
            msgType,
            payload: parsed.data,
          };
          return descriptor;
        },
      };
    },
  };
}

function makeSagaCompensateCtx(
  internalCtx: InternalProcessCtx,
): SagaCompensateCtx {
  return {
    self: { type: internalCtx.self.type, name: internalCtx.self.name },
    now: () => internalCtx.now(),
    stub<D extends AnyProcess>(def: D, name: string): SagaCompensateStub<D> {
      return internalCtx.stub(def, name);
    },
  };
}

// ── Core step execution logic ───────────────────────────────────

/**
 * Execute the step chain starting from `state._saga.currentStep`.
 * Chains through sync steps in a loop; breaks on an ask step (emits
 * the ask effect and returns, waiting for the reply message).
 */
function runStepChain<Input, Context, StepNames extends string>(
  state: SagaState<Input, Context>,
  steps: Record<string, SagaStep<Input, Context, StepNames>>,
  internalCtx: InternalProcessCtx,
): void {
  while (state._saga.currentStep !== null) {
    const stepName = state._saga.currentStep;
    const step = steps[stepName];
    if (!step) {
      throw new Error(`saga: unknown step "${stepName}"`);
    }

    const stepCtx = makeSagaStepCtx(internalCtx);
    const result = step.run(state.input, state.context, stepCtx);

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
      internalCtx.pushAsk(
        result.def,
        result.name,
        result.msgType,
        result.payload,
        `${stepName}_reply`,
        null,
      );
      return;
    }

    // Sync step — apply transition inline and continue
    const transition = result;
    state._saga.completedSteps.push({
      name: stepName,
      contextSnapshot: snapshotValue(state.context),
    });
    if (transition.context !== undefined) {
      state.context = transition.context;
    }
    if (transition.next === null) {
      state._saga.phase = "completed";
      state._saga.currentStep = null;
      return;
    }
    if (!(transition.next in steps)) {
      throw new Error(
        `saga: step "${stepName}" transitioned to unknown step "${transition.next}"`,
      );
    }
    state._saga.currentStep = transition.next;
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
  internalCtx: InternalProcessCtx,
): void {
  // Record which step triggered compensation before we clear currentStep.
  if (state._saga.currentStep !== null) {
    state._saga.failedStep = state._saga.currentStep;
  }
  const reversed = [...state._saga.completedSteps].reverse();
  for (const { name, contextSnapshot } of reversed) {
    const step = steps[name];
    if (step?.compensate) {
      try {
        const compensateCtx = makeSagaCompensateCtx(internalCtx);
        step.compensate(state.input, contextSnapshot, compensateCtx);
      } catch {
        // Best-effort: continue compensating remaining steps even if one throws
        // TODO: Log the error
      }
    }
  }
  state._saga.phase = "failed";
  state._saga.currentStep = null;
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
  const sagaInternalSchema = z.object({
    phase: z.enum(["idle", "running", "completed", "failed"]),
    currentStep: z.string().nullable(),
    completedSteps: z.array(
      z.object({ name: z.string(), contextSnapshot: spec.context }),
    ),
    failReason: z.string().optional(),
    failedStep: z.string().optional(),
  });

  const sagaStateSchema = z.object({
    _saga: sagaInternalSchema,
    input: spec.input,
    context: spec.context,
  });

  const { steps } = spec;

  // ── Build messages ──
  const messages: { start: { payload: InputV } } & Record<string, MessageDef> =
    {
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
      ctx: InternalProcessCtx,
    ) => Promise<unknown>
  > = {};

  handle.start = async (state, payload, internalCtx) => {
    if (state._saga.phase !== "idle") {
      internalCtx.fail("saga_already_started", {
        currentPhase: state._saga.phase,
      });
    }
    state._saga.phase = "running";
    state.input = payload as Input;
    state.context = spec.initialContext();
    state._saga.completedSteps = [];
    state._saga.currentStep = spec.firstStep;

    try {
      runStepChain<Input, Context, StepNames>(state, steps, internalCtx);
    } catch (e) {
      if (e instanceof FailSentinel) {
        state._saga.failReason = e.reason;
        startCompensation<Input, Context, StepNames>(
          state,
          steps,
          internalCtx,
        );
        return;
      }
      throw e;
    }
  };

  for (const stepName of Object.keys(steps)) {
    const step = steps[stepName];
    if (!step.onSuccess) continue;

    handle[`${stepName}_reply`] = async (state, payload, internalCtx) => {
      if (state._saga.phase !== "running") return; // stale reply
      const { result } = payload as ReplyPayload;

      if (result.kind !== "success") {
        state._saga.failReason =
          result.kind === "fail" ? result.reason : result.error;
        startCompensation<Input, Context, StepNames>(
          state,
          steps,
          internalCtx,
        );
        return;
      }

      try {
        // Ask succeeded — mark the step as completed
        state._saga.completedSteps.push({
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
          state._saga.phase = "completed";
          state._saga.currentStep = null;
          return;
        }
        if (!(transition.next in steps)) {
          throw new Error(
            `saga "${spec.type}": onSuccess for "${stepName}" transitioned to unknown step "${transition.next}"`,
          );
        }
        state._saga.currentStep = transition.next;
        runStepChain<Input, Context, StepNames>(state, steps, internalCtx);
      } catch (e) {
        if (e instanceof FailSentinel) {
          state._saga.failReason = e.reason;
          startCompensation<Input, Context, StepNames>(
            state,
            steps,
            internalCtx,
          );
          return;
        }
        throw e;
      }
    };
  }

  // ── Assemble definition ──
  return {
    type: spec.type,
    state: sagaStateSchema,
    messages,
    initialState: (): State => ({
      _saga: {
        phase: "idle",
        currentStep: null,
        completedSteps: [],
        failReason: undefined,
        failedStep: undefined,
      },
      input: null as Input,
      context: spec.initialContext(),
    }),
    project: (state: State): SagaProjection<StepNames> => ({
      phase: state._saga.phase,
      currentStep: state._saga.currentStep as StepNames | null,
      completedSteps: state._saga.completedSteps.map(
        (s) => s.name,
      ) as StepNames[],
      failedStep: (state._saga.failedStep ?? null) as StepNames | null,
      failReason: state._saga.failReason,
    }),
    handle,
    __saga: {} as {
      steps: Steps;
      input: Input;
      context: Context;
    },
  } as unknown as SagaDefinition<Type, InputV, ContextV, Steps>;
}

// ── Saga definition brand ───────────────────────────────────────

/**
 * Return type of `defineSaga`. A `ProcessDefinition` plus the
 * `__saga` phantom brand that carries the Steps / Input / Context
 * generics so client helpers (`createSagaAwaiter`) can narrow
 * projection step names.
 */
export type SagaDefinition<
  Type extends string,
  InputV extends z.ZodTypeAny,
  ContextV extends z.ZodTypeAny,
  Steps,
> = ProcessDefinition<
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
 * (`<D extends AnySagaDefinition>`) when a helper needs the __saga
 * brand without caring about the specific shape.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnySagaDefinition = AnyProcess & {
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
export type StepNamesOf<D extends AnySagaDefinition> = string &
  keyof D["__saga"]["steps"];

/** Saga's declared input type — the payload of `start`. */
export type SagaInputOf<D extends AnySagaDefinition> = D["__saga"]["input"];

/** Saga's declared context type. */
export type SagaContextOf<D extends AnySagaDefinition> =
  D["__saga"]["context"];

/** Fully-narrowed projection shape for a specific saga definition. */
export type SagaProjectionOf<D extends AnySagaDefinition> = SagaProjection<
  StepNamesOf<D>
>;
