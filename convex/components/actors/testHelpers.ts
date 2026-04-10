/**
 * Test-only actor definitions and execute mutation. Lives in the
 * component so drain.test.ts can call drainLoop directly with a real
 * executeFn handle (no mocks, no DI seams).
 */
import { z } from "zod";
import { v } from "convex/values";
import { createDraft, finishDraft } from "immer";
import { internalMutation } from "./_generated/server.js";
import { getActorRow } from "./actors.js";
import { defineActor } from "./client/defineActor.js";
import { createActorCtx, FailSentinel } from "./client/ctx.js";
import type { AnyActorDefinition } from "./client/defineActor.js";

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

const defs: Record<string, AnyActorDefinition> = {
  counter,
  failActor,
  throwActor,
  senderActor,
};

const defsByType = new Map<string, AnyActorDefinition>();
for (const def of Object.values(defs)) {
  defsByType.set(def.type, def);
}

export const testExecute = internalMutation({
  args: {
    actorType: v.string(),
    actorName: v.string(),
    msgType: v.string(),
    payload: v.any(),
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
    const currentState =
      actor?.state !== null && actor?.state !== undefined
        ? actor.state
        : def.initialState();

    const { ctx: actorCtx, internals } = createActorCtx({
      selfType: args.actorType,
      selfName: args.actorName,
      now: Date.now(),
      peekFn: async (actorType, name) => {
        const target = await getActorRow(ctx, actorType, name);
        if (!target?.state) return null;
        const targetDef = defsByType.get(actorType);
        if (!targetDef?.project) return null;
        return targetDef.project(target.state);
      },
      getDefinition: (t) => {
        const d = defsByType.get(t);
        if (!d) throw new Error(`unknown actor type "${t}"`);
        return d;
      },
    });

    try {
      const draft = createDraft(currentState);
      internals.returnValue = await handler(draft, args.payload, actorCtx);
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
