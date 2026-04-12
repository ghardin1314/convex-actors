/**
 * Test-only actor definitions and execute mutation. Lives in the
 * component so drain.test.ts can call drainLoop directly with a real
 * executeFn handle (no mocks, no DI seams).
 */
import { z } from "zod";
import { v } from "convex/values";
import { createDraft, finishDraft } from "immer";
import { internalMutation } from "./_generated/server.js";
import { getActorRow, getActorStateRow } from "./actors.js";
import { createLogger, type LogLevel } from "./logging.js";
import { createProcessCtx, FailSentinel } from "./client/ctx.js";
import type { AnyProcess } from "./client/defineProcess.js";
import { defineActor } from "./client/defineActor.js";

// ── Test actor definitions ───────────────────────────────────────

export const counter = defineActor({
  type: "counter",
  state: z.object({ n: z.number() }),
  messages: {
    inc: { payload: z.object({ by: z.number() }) },
    reset: { payload: z.object({}) },
  },
  initialState: () => ({ n: 0 }),
  project: (state) => ({ count: state.n }),
  handle: {
    inc: async (state, { by }) => {
      state.n += by;
      return { newCount: state.n };
    },
    reset: async (state) => {
      state.n = 0;
    },
  },
});

export const failActor = defineActor({
  type: "failActor",
  state: z.object({}),
  messages: { doFail: { payload: z.object({ reason: z.string() }) } },
  initialState: () => ({}),
  handle: {
    doFail: async (_state, { reason }, ctx) => {
      ctx.fail(reason, { extra: 42 });
    },
  },
});

export const throwActor = defineActor({
  type: "throwActor",
  state: z.object({}),
  messages: { boom: { payload: z.object({}) } },
  initialState: () => ({}),
  handle: {
    boom: async () => {
      throw new Error("kaboom");
    },
  },
});

export const senderActor = defineActor({
  type: "senderActor",
  state: z.object({ sent: z.number() }),
  messages: {
    sendToCounter: { payload: z.object({ counterName: z.string(), by: z.number() }) },
  },
  initialState: () => ({ sent: 0 }),
  handle: {
    sendToCounter: async (state, { counterName, by }, ctx) => {
      ctx.stub(counter, counterName).send("inc", { by });
      state.sent++;
    },
  },
});

// ── Execute mutation ─────────────────────────────────────────────

const defs: Record<string, AnyProcess> = {
  counter,
  failActor,
  throwActor,
  senderActor,
};

const defsByType = new Map<string, AnyProcess>();
for (const def of Object.values(defs)) {
  defsByType.set(def.type, def);
}

export const testExecute = internalMutation({
  args: {
    actorType: v.string(),
    actorName: v.string(),
    msgType: v.string(),
    payload: v.any(),
    logLevel: v.string(),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    const def = defsByType.get(args.actorType);
    if (!def) {
      return { outcome: "defect", error: `unknown actor type "${args.actorType}"` };
    }

    const handler = def.handle[args.msgType];
    if (!handler) {
      return {
        outcome: "defect",
        error: `no handler for msgType "${args.msgType}" on actor type "${args.actorType}"`,
      };
    }

    const actor = await getActorRow(ctx, args.actorType, args.actorName);
    const stateRow = actor ? await getActorStateRow(ctx, actor._id) : null;
    const currentState = stateRow?.state ?? def.initialState();

    const { ctx: processCtx, internals } = createProcessCtx({
      selfDefinition: def,
      selfName: args.actorName,
      now: Date.now(),
      logger: createLogger(args.logLevel as LogLevel),
      peekFn: async (actorType, name) => {
        const target = await getActorRow(ctx, actorType, name);
        if (!target) return null;
        const targetState = await getActorStateRow(ctx, target._id);
        if (!targetState) return null;
        const targetDef = defsByType.get(actorType);
        if (!targetDef?.project) return null;
        return targetDef.project(targetState.state);
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
        return { outcome: "fail", reason: e.reason, details: e.details };
      }
      return {
        outcome: "defect",
        error: e instanceof Error ? e.message : String(e),
      };
    }
  },
});
