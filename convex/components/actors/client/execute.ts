/**
 * App-level execute function factory. The component's drain loop calls
 * this via function handle to invoke a process handler. Execute
 * resolves the definition, runs the handler inside Immer, and returns
 * the outcome. All commits happen in the component drain loop, not
 * here.
 *
 * Kind-agnostic: operates on `ProcessDefinition`, which both
 * `ActorDefinition` and `SagaDefinition` extend.
 */
import { createDraft, finishDraft } from "immer";
import { internalMutationGeneric } from "convex/server";
import { v } from "convex/values";
import { createLogger, logLevel } from "../logging.js";
import type { AnyProcess } from "./defineProcess";
import { createProcessCtx, FailSentinel } from "./ctx";
import type { ActorsComponent } from "./system";
import type { ExecuteOutcome } from "../shared.js";

/**
 * Build a lookup map from actor type string → definition. The input
 * `defs` record is keyed by JS identifier; the authoritative lookup
 * key is `definition.type`.
 */
function buildDefsByType(
  defs: Record<string, AnyProcess>,
): Map<string, AnyProcess> {
  const m = new Map<string, AnyProcess>();
  for (const def of Object.values(defs)) {
    m.set(def.type, def);
  }
  return m;
}

/**
 * Factory for the app-level `execute` internalMutation. The component's
 * drain loop calls this via a function handle. Execute:
 *
 * 1. Resolves the process definition + handler from `defs`
 * 2. Builds initial state if absent
 * 3. Creates InternalProcessCtx (with peek support via component queries)
 * 4. Runs the handler inside an Immer draft
 * 5. Returns the outcome (success/fail/defect) — no DB writes
 */
export function makeExecute(
  defs: Record<string, AnyProcess>,
  component: ActorsComponent,
) {
  const defsByType = buildDefsByType(defs);

  return internalMutationGeneric({
    args: {
      actorType: v.string(),
      actorName: v.string(),
      msgType: v.string(),
      payload: v.any(),
      logLevel,
    },
    returns: v.any(),
    handler: async (ctx, args): Promise<ExecuteOutcome> => {
      const def = defsByType.get(args.actorType);
      if (!def) {
        return {
          outcome: "defect",
          error: `unknown actor type "${args.actorType}"`,
        };
      }

      const handler = def.handle[args.msgType];
      if (!handler) {
        return {
          outcome: "defect",
          error: `no handler for msgType "${args.msgType}" on actor type "${args.actorType}"`,
        };
      }

      // Payload is already validated by the time it reaches execute:
      // external sends validate in sendRaw, handler-to-handler sends
      // validate in stub.send/self.send. No duplicate validation here.

      const rawState = await ctx.runQuery(
        component.actors.getActorState,
        { actorType: args.actorType, name: args.actorName },
      );
      const currentState =
        rawState !== null && rawState !== undefined
          ? rawState
          : def.initialState();

      const logger = createLogger(args.logLevel);

      const { ctx: processCtx, internals } = createProcessCtx({
        selfDefinition: def,
        selfName: args.actorName,
        now: Date.now(),
        logger,
        peekFn: async (actorType, name) => {
          const state = await ctx.runQuery(
            component.actors.getActorState,
            { actorType, name },
          );
          if (state === null || state === undefined) return null;
          const targetDef = defsByType.get(actorType);
          if (!targetDef?.project) return null;
          return targetDef.project(state);
        },
      });

      try {
        const draft = createDraft(currentState);
        internals.returnValue = await handler(draft, args.payload, processCtx);
        const nextState = finishDraft(draft);
        const response =
          internals.returnValue === undefined ? null : internals.returnValue;

        return {
          outcome: "success",
          newState: nextState,
          effects: internals.effects,
          response,
        };
      } catch (e) {
        if (e instanceof FailSentinel) {
          return {
            outcome: "fail",
            reason: e.reason,
            details: e.details,
          };
        }
        return {
          outcome: "defect",
          error: e instanceof Error ? e.message : String(e),
        };
      }
    },
  });
}
