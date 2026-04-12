/**
 * Public barrel for the actor framework. Consumer code should import
 * from here; direct imports of the internal files (`defineProcess`,
 * `ctx`, `defineActor`, `defineSaga`, `system`, `execute`) are
 * framework-internal and not stable.
 *
 * React hooks live in `./react` — that file carries React dependencies
 * and is imported from frontend code separately.
 */

// ── Core process types (shared base for actors and sagas) ───────
export type {
  MessageDef,
  ProcessDefinition,
  AnyProcess,
  StateOf,
  PayloadOf,
  ProjectionOf,
  MessageNamesOf,
  ReturnOf,
  ActorResponse,
  ResponseEnvelope,
} from "./defineProcess";

// ── Actor API ───────────────────────────────────────────────────
export { defineActor, reply } from "./defineActor";
export type {
  ActorDefinition,
  AnyActorDefinition,
  ActorSpec,
  ActorHandlerCtx,
  ActorStub,
  SelfStub,
  ReplyPayload,
  ReplyContextOf,
  ValidReplyHandlers,
  AskOpts,
} from "./defineActor";

// ── Saga API ────────────────────────────────────────────────────
export { defineSaga } from "./defineSaga";
export type {
  SagaDefinition,
  AnySagaDefinition,
  SagaStepCtx,
  SagaCompensateCtx,
  SagaStub,
  SagaCompensateStub,
  SagaStep,
  StepTransition,
  SagaPhase,
  SagaProjection,
  SagaProjectionOf,
  SagaState,
  SagaInternalState,
  SagaInputOf,
  SagaContextOf,
  StepNamesOf,
  AskDescriptor,
} from "./defineSaga";

// ── System + dispatch ───────────────────────────────────────────
export { ActorSystem } from "./system";
export type {
  ActorsComponent,
  ActorSystemOptions,
  ExecuteRef,
  RegisteredActorType,
  DefinitionByType,
  RunMutationCtx,
  RunQueryCtx,
} from "./system";

// ── Execute factory ─────────────────────────────────────────────
export { makeExecute } from "./execute";

// ── Logging ────────────────────────────────────────────────────
export { logLevel as vLogLevel } from "../logging.js";
export type { LogLevel } from "../logging.js";

// ── Error + effect types (useful in tests + diagnostics) ────────
export { FailSentinel, resolveDeliverAt } from "./ctx";
export type { ScheduleOpts } from "./ctx";
export type { Effect, ReplyTo } from "../shared.js";
