import { z } from "zod";
import { describe, expect, expectTypeOf, test } from "vitest";

import { defineActor } from "./defineActor";
import { createActorCtx } from "./ctx";
import type { AnyActorDefinition } from "./defineActor";
import type { EffectDescriptor } from "./ctx";
import { defineSaga, type SagaProjection, type SagaState } from "./defineSaga";

// ── Test actor definitions ──────────────────────────────────────

const wallet = defineActor({
  type: "wallet",
  state: z.object({ balance: z.number() }),
  messages: {
    deposit: {
      payload: z.object({ amount: z.number() }),
      response: z.object({ newBalance: z.number() }),
    },
    withdraw: {
      payload: z.object({ amount: z.number() }),
      response: z.object({ newBalance: z.number() }),
    },
  },
  initialState: () => ({ balance: 0 }),
  handle: {
    deposit: async (state, { amount }) => {
      state.balance += amount;
      return { newBalance: state.balance };
    },
    withdraw: async (state, { amount }, ctx) => {
      if (amount > state.balance) ctx.fail("insufficient_funds");
      state.balance -= amount;
      return { newBalance: state.balance };
    },
  },
});

const logger = defineActor({
  type: "logger",
  state: z.object({ logs: z.array(z.string()) }),
  messages: {
    log: { payload: z.object({ msg: z.string() }) },
  },
  initialState: () => ({ logs: [] }),
  handle: {
    log: async (state, { msg }) => {
      state.logs.push(msg);
    },
  },
});

// ── Test helpers ────────────────────────────────────────────────

function sagaState(def: AnyActorDefinition): SagaState {
  return def.initialState() as SagaState;
}

function runSagaHandler(
  sagaDef: AnyActorDefinition,
  state: SagaState,
  msgType: string,
  payload: unknown,
  allDefs?: Record<string, AnyActorDefinition>,
) {
  const defs: Record<string, AnyActorDefinition> = {
    wallet,
    logger,
    [sagaDef.type]: sagaDef,
    ...allDefs,
  };
  const T0 = 1_700_000_000_000;
  const { ctx, internals } = createActorCtx({
    selfType: sagaDef.type,
    selfName: "saga-1",
    now: T0,
    peekFn: async () => null,
    getDefinition: (t) => {
      const d = defs[t];
      if (!d) throw new Error(`unknown type ${t}`);
      return d;
    },
  });

  const handler = sagaDef.handle[msgType];
  if (!handler) throw new Error(`no handler for ${msgType}`);

  return {
    run: () => handler(state, payload, ctx),
    state,
    internals,
    T0,
  };
}

// ── Tests ───────────────────────────────────────────────────────

describe("defineSaga", () => {
  const transfer = defineSaga({
    type: "transfer",
    input: z.object({
      from: z.string(),
      to: z.string(),
      amount: z.number(),
    }),
    context: z.object({ withdrawTxId: z.string().optional() }),
    initialContext: () => ({ withdrawTxId: undefined }),
    firstStep: "withdraw",
    steps: {
      withdraw: {
        run: (input, _context, ctx) => {
          ctx.stub(logger, "main").send("log", {
            msg: `withdrawing ${input.amount} from ${input.from}`,
          });
          return ctx.ask(wallet, input.from, "withdraw", {
            amount: input.amount,
          });
        },
        onSuccess: (_value, _input, context) => ({
          context: { ...context, withdrawTxId: "tx_123" },
          next: "deposit" as const,
        }),
        compensate: (input, _context, ctx) => {
          ctx.stub(wallet, input.from).send("deposit", {
            amount: input.amount,
          });
        },
      },
      deposit: {
        run: (input, _context, ctx) => {
          return ctx.ask(wallet, input.to, "deposit", {
            amount: input.amount,
          });
        },
        onSuccess: () => ({ next: null }),
      },
    },
  });

  test("returns a valid ActorDefinition", () => {
    expect(transfer.type).toBe("transfer");
    expect(transfer.state).toBeDefined();
    expect(transfer.messages).toBeDefined();
    expect(transfer.messages.start).toBeDefined();
    expect(transfer.handle).toBeDefined();
    expect(transfer.initialState).toBeTypeOf("function");
    expect(transfer.project).toBeTypeOf("function");
  });

  test("type field is pinned as literal", () => {
    expectTypeOf(transfer.type).toEqualTypeOf<"transfer">();
  });

  test("start message payload matches saga input schema", () => {
    const schema = transfer.messages.start.payload;
    expect(() =>
      schema.parse({ from: "alice", to: "bob", amount: 100 }),
    ).not.toThrow();
    expect(() => schema.parse({ from: "alice" })).toThrow();
  });

  test("generates reply handler messages for ask steps", () => {
    expect(transfer.messages["withdraw_reply"]).toBeDefined();
    expect(transfer.messages["deposit_reply"]).toBeDefined();
  });

  test("initialState returns idle saga state", () => {
    const s0 = sagaState(transfer);
    expect(s0).toMatchObject({
      phase: "idle",
      currentStep: null,
      completedSteps: [],
      failReason: undefined,
    });
  });

  test("project returns saga progress info", () => {
    const state = {
      phase: "running" as const,
      currentStep: "withdraw",
      completedSteps: [
        { name: "validate", contextSnapshot: {} },
      ],
      input: {},
      context: {},
      failReason: undefined,
      failedStep: undefined,
    };
    const projection = transfer.project!(state);
    expect(projection).toEqual({
      phase: "running",
      currentStep: "withdraw",
      completedSteps: ["validate"],
      failedStep: null,
      failReason: undefined,
    });
    // Step names narrow to the saga's own union — `"withdraw" | "deposit"` —
    // rather than plain `string`, courtesy of the __saga brand on the
    // return type of defineSaga.
    expectTypeOf(projection).toEqualTypeOf<
      SagaProjection<"withdraw" | "deposit">
    >();
  });

  test("throws on invalid firstStep", () => {
    expect(() =>
      defineSaga({
        type: "bad",
        input: z.object({}),
        context: z.object({}),
        initialContext: () => ({}),
        // @ts-expect-error — intentionally invalid firstStep
        firstStep: "nonexistent",
        steps: {},
      }),
    ).toThrow(/firstStep "nonexistent" is not a defined step/);
  });
});

describe("saga start handler", () => {
  const transfer = defineSaga({
    type: "transfer",
    input: z.object({ from: z.string(), to: z.string(), amount: z.number() }),
    context: z.object({ memo: z.string().optional() }),
    initialContext: () => ({ memo: undefined }),
    firstStep: "withdraw",
    steps: {
      withdraw: {
        run: (input, _context, ctx) => {
          return ctx.ask(wallet, input.from, "withdraw", {
            amount: input.amount,
          });
        },
        onSuccess: (_value, _input, context) => ({
          context: { ...context, memo: "withdrawn" },
          next: "deposit" as const,
        }),
        compensate: (input, _context, ctx) => {
          ctx.stub(wallet, input.from).send("deposit", {
            amount: input.amount,
          });
        },
      },
      deposit: {
        run: (input, _context, ctx) => {
          return ctx.ask(wallet, input.to, "deposit", {
            amount: input.amount,
          });
        },
        onSuccess: () => ({ next: null }),
      },
    },
  });

  test("start sets up saga state and executes first step", async () => {
    const state = sagaState(transfer);
    const { run, internals } = runSagaHandler(
      transfer,
      state,
      "start",
      { from: "alice", to: "bob", amount: 100 },
    );
    await run();

    expect(state.phase).toBe("running");
    expect(state.currentStep).toBe("withdraw");
    expect(state.input).toEqual({ from: "alice", to: "bob", amount: 100 });
    // Ask step not yet in completedSteps — only added after onSuccess
    expect(state.completedSteps).toHaveLength(0);

    // Should have emitted an ask effect to wallet
    const askEffect = internals.effects.find(
      (e: EffectDescriptor) => e.replyTo !== undefined,
    );
    expect(askEffect).toBeDefined();
    expect(askEffect!.actorType).toBe("wallet");
    expect(askEffect!.name).toBe("alice");
    expect(askEffect!.msgType).toBe("withdraw");
    expect(askEffect!.payload).toEqual({ amount: 100 });
    expect(askEffect!.replyTo!.handler).toBe("withdraw_reply");
  });

  test("start handler preserves side-effect sends alongside ask", async () => {
    const sagaWithSideEffects = defineSaga({
      type: "loggedTransfer",
      input: z.object({ from: z.string(), amount: z.number() }),
      context: z.object({}),
      initialContext: () => ({}),
      firstStep: "withdraw",
      steps: {
        withdraw: {
          run: (input, _context, ctx) => {
            ctx.stub(logger, "main").send("log", { msg: "starting withdraw" });
            return ctx.ask(wallet, input.from, "withdraw", {
              amount: input.amount,
            });
          },
          onSuccess: () => ({ next: null }),
        },
      },
    });

    const state = sagaState(sagaWithSideEffects);
    const { run, internals } = runSagaHandler(
      sagaWithSideEffects,
      state,
      "start",
      { from: "alice", amount: 50 },
    );
    await run();

    // Two effects: the log send + the ask
    expect(internals.effects).toHaveLength(2);
    expect(internals.effects[0].actorType).toBe("logger");
    expect(internals.effects[1].replyTo).toBeDefined();
  });
});

describe("sync step chaining", () => {
  test("chains through multiple sync steps to completion", async () => {
    const saga = defineSaga({
      type: "syncSaga",
      input: z.object({ value: z.number() }),
      context: z.object({ doubled: z.number().optional(), tripled: z.number().optional() }),
      initialContext: () => ({ doubled: undefined, tripled: undefined }),
      firstStep: "double",
      steps: {
        double: {
          run: (input, context) => ({
            next: "triple" as const,
            context: { ...context, doubled: input.value * 2 },
          }),
        },
        triple: {
          run: (input, context) => ({
            next: null,
            context: { ...context, tripled: input.value * 3 },
          }),
        },
      },
    });

    const state = sagaState(saga);
    const { run } = runSagaHandler(saga, state, "start", { value: 5 });
    await run();

    expect(state.phase).toBe("completed");
    expect(state.currentStep).toBeNull();
    expect(state.context).toEqual({ doubled: 10, tripled: 15 });
    expect(state.completedSteps).toHaveLength(2);
    expect(state.completedSteps.map((s: { name: string }) => s.name)).toEqual([
      "double",
      "triple",
    ]);
  });

  test("sync steps followed by an ask step", async () => {
    const saga = defineSaga({
      type: "mixedSaga",
      input: z.object({ target: z.string(), amount: z.number() }),
      context: z.object({ validated: z.boolean().optional() }),
      initialContext: () => ({ validated: undefined }),
      firstStep: "validate",
      steps: {
        validate: {
          run: (_input, context) => ({
            next: "withdraw" as const,
            context: { ...context, validated: true },
          }),
        },
        withdraw: {
          run: (input, _context, ctx) => {
            return ctx.ask(wallet, input.target, "withdraw", {
              amount: input.amount,
            });
          },
          onSuccess: () => ({ next: null }),
        },
      },
    });

    const state = sagaState(saga);
    const { run, internals } = runSagaHandler(
      saga,
      state,
      "start",
      { target: "alice", amount: 50 },
    );
    await run();

    expect(state.phase).toBe("running");
    expect(state.currentStep).toBe("withdraw");
    expect(state.context).toEqual({ validated: true });
    // Only the sync validate step is completed; withdraw (ask) awaits reply
    expect(state.completedSteps).toHaveLength(1);
    // Ask effect emitted
    expect(internals.effects.some((e: EffectDescriptor) => e.replyTo)).toBe(true);
  });
});

describe("reply handling", () => {
  const transfer = defineSaga({
    type: "transfer",
    input: z.object({ from: z.string(), to: z.string(), amount: z.number() }),
    context: z.object({ withdrawn: z.boolean().optional() }),
    initialContext: () => ({ withdrawn: undefined }),
    firstStep: "withdraw",
    steps: {
      withdraw: {
        run: (input, _context, ctx) => {
          return ctx.ask(wallet, input.from, "withdraw", {
            amount: input.amount,
          });
        },
        onSuccess: (_value, _input, context) => ({
          context: { ...context, withdrawn: true },
          next: "deposit" as const,
        }),
        compensate: (input, _context, ctx) => {
          ctx.stub(wallet, input.from).send("deposit", {
            amount: input.amount,
          });
        },
      },
      deposit: {
        run: (input, _context, ctx) => {
          return ctx.ask(wallet, input.to, "deposit", {
            amount: input.amount,
          });
        },
        onSuccess: () => ({ next: null }),
      },
    },
  });

  function makeReplyState() {
    const state = sagaState(transfer);
    // Simulate state after start emitted the withdraw ask (not yet completed)
    state.phase = "running";
    state.currentStep = "withdraw";
    state.input = { from: "alice", to: "bob", amount: 100 };
    state.context = { withdrawn: undefined };
    state.completedSteps = [];
    return state;
  }

  test("successful reply advances to next step", async () => {
    const state = makeReplyState();
    const { run, internals } = runSagaHandler(
      transfer,
      state,
      "withdraw_reply",
      {
        result: { kind: "success", value: { newBalance: 900 } },
        context: null,
        from: { type: "wallet", name: "alice" },
      },
    );
    await run();

    // Should have advanced context and moved to deposit
    expect(state.context).toEqual({ withdrawn: true });
    expect(state.currentStep).toBe("deposit");
    // Deposit step emits its own ask
    const askEffect = internals.effects.find(
      (e: EffectDescriptor) => e.replyTo !== undefined,
    );
    expect(askEffect).toBeDefined();
    expect(askEffect!.actorType).toBe("wallet");
    expect(askEffect!.name).toBe("bob");
    expect(askEffect!.msgType).toBe("deposit");
    expect(askEffect!.replyTo!.handler).toBe("deposit_reply");
  });

  test("successful final reply completes saga", async () => {
    const state = makeReplyState();
    // Simulate: withdraw reply succeeded, now awaiting deposit reply
    state.currentStep = "deposit";
    state.context = { withdrawn: true };
    state.completedSteps = [
      { name: "withdraw", contextSnapshot: { withdrawn: undefined } },
    ];

    const { run } = runSagaHandler(
      transfer,
      state,
      "deposit_reply",
      {
        result: { kind: "success", value: { newBalance: 200 } },
        context: null,
        from: { type: "wallet", name: "bob" },
      },
    );
    await run();

    expect(state.phase).toBe("completed");
    expect(state.currentStep).toBeNull();
  });

  test("failed reply on first ask step fails with no compensation", async () => {
    const state = makeReplyState();
    const { run, internals } = runSagaHandler(
      transfer,
      state,
      "withdraw_reply",
      {
        result: { kind: "fail", reason: "insufficient_funds" },
        context: null,
        from: { type: "wallet", name: "alice" },
      },
    );
    await run();

    expect(state.phase).toBe("failed");
    expect(state.failReason).toBe("insufficient_funds");
    // No compensation — the withdraw ask failed, nothing to undo
    expect(internals.effects).toHaveLength(0);
  });

  test("failed reply after prior steps triggers compensation", async () => {
    // Simulate: withdraw succeeded, deposit ask pending
    const state = makeReplyState();
    state.currentStep = "deposit";
    state.context = { withdrawn: true };
    state.completedSteps = [
      { name: "withdraw", contextSnapshot: { withdrawn: undefined } },
    ];

    const { run, internals } = runSagaHandler(
      transfer,
      state,
      "deposit_reply",
      {
        result: { kind: "fail", reason: "target_locked" },
        context: null,
        from: { type: "wallet", name: "bob" },
      },
    );
    await run();

    expect(state.phase).toBe("failed");
    expect(state.failReason).toBe("target_locked");

    // Compensation should undo the withdraw (re-deposit to alice)
    const compensationEffect = internals.effects.find(
      (e: EffectDescriptor) =>
        e.actorType === "wallet" && e.msgType === "deposit",
    );
    expect(compensationEffect).toBeDefined();
    expect(compensationEffect!.name).toBe("alice");
    expect(compensationEffect!.payload).toEqual({ amount: 100 });
  });

  test("defect reply triggers compensation", async () => {
    const state = makeReplyState();
    const { run } = runSagaHandler(
      transfer,
      state,
      "withdraw_reply",
      {
        result: { kind: "defect", error: "handler crashed" },
        context: null,
        from: { type: "wallet", name: "alice" },
      },
    );
    await run();

    expect(state.phase).toBe("failed");
    expect(state.failReason).toBe("handler crashed");
  });
});

describe("compensation ordering and context snapshots", () => {
  test("compensates in reverse order with correct snapshots", async () => {
    const compensationLog: Array<{ step: string; context: unknown }> = [];

    const saga = defineSaga({
      type: "threeStepper",
      input: z.object({ target: z.string() }),
      context: z.object({ step1Done: z.boolean().optional(), step2Done: z.boolean().optional() }),
      initialContext: () => ({ step1Done: undefined, step2Done: undefined }),
      firstStep: "step1",
      steps: {
        step1: {
          run: (_input, context) => ({
            next: "step2" as const,
            context: { ...context, step1Done: true },
          }),
          compensate: (_input, context) => {
            compensationLog.push({ step: "step1", context });
          },
        },
        step2: {
          run: (_input, context) => ({
            next: "step3" as const,
            context: { ...context, step2Done: true },
          }),
          compensate: (_input, context) => {
            compensationLog.push({ step: "step2", context });
          },
        },
        step3: {
          run: (input, _context, ctx) => {
            return ctx.ask(wallet, input.target, "withdraw", { amount: 100 });
          },
          onSuccess: () => ({ next: null }),
          compensate: (_input, context) => {
            compensationLog.push({ step: "step3", context });
          },
        },
      },
    });

    // Run start to get through step1, step2 (sync) then step3 (ask)
    const state = sagaState(saga);
    const { run: runStart } = runSagaHandler(
      saga,
      state,
      "start",
      { target: "alice" },
    );
    await runStart();

    // Sync steps completed, ask step (step3) awaits reply
    expect(state.completedSteps).toHaveLength(2);

    // Now simulate a failed reply on step3
    const { run: runReply } = runSagaHandler(
      saga,
      state,
      "step3_reply",
      {
        result: { kind: "fail", reason: "boom" },
        context: null,
        from: { type: "wallet", name: "alice" },
      },
    );
    await runReply();

    expect(state.phase).toBe("failed");

    // step3's ask failed so it's NOT in completedSteps — only step1 and step2
    // compensate. Compensation runs in reverse: step2, step1
    expect(compensationLog.map((e) => e.step)).toEqual([
      "step2",
      "step1",
    ]);

    // Each compensation gets the context snapshot from when that step ran
    // step1 snapshot: before step1 modified context
    expect(compensationLog[1].context).toEqual({
      step1Done: undefined,
      step2Done: undefined,
    });
    // step2 snapshot: after step1, before step2
    expect(compensationLog[0].context).toEqual({
      step1Done: true,
      step2Done: undefined,
    });
  });
});

describe("ctx.fail in saga steps", () => {
  test("fail in sync step triggers compensation for prior steps", async () => {
    const compensated: string[] = [];

    const saga = defineSaga({
      type: "failingSaga",
      input: z.object({}),
      context: z.object({ ready: z.boolean().optional() }),
      initialContext: () => ({ ready: undefined }),
      firstStep: "setup",
      steps: {
        setup: {
          run: (_input, context) => ({
            next: "validate" as const,
            context: { ...context, ready: true },
          }),
          compensate: () => {
            compensated.push("setup");
          },
        },
        validate: {
          run: (_input, _context, ctx) => {
            ctx.fail("validation_error");
            // unreachable but needed for return type
            return { next: null };
          },
        },
      },
    });

    const state = sagaState(saga);
    const { run } = runSagaHandler(saga, state, "start", {});
    await run();

    expect(state.phase).toBe("failed");
    expect(state.failReason).toBe("validation_error");
    expect(compensated).toEqual(["setup"]);
  });

  test("fail in first step with no completed steps still marks failed", async () => {
    const saga = defineSaga({
      type: "immediateFailSaga",
      input: z.object({}),
      context: z.object({}),
      initialContext: () => ({}),
      firstStep: "bomb",
      steps: {
        bomb: {
          run: (_input, _context, ctx) => {
            ctx.fail("instant_fail");
            return { next: null };
          },
        },
      },
    });

    const state = sagaState(saga);
    const { run } = runSagaHandler(saga, state, "start", {});
    await run();

    expect(state.phase).toBe("failed");
    expect(state.failReason).toBe("instant_fail");
    expect(state.completedSteps).toHaveLength(0);
  });
});

describe("saga ask validation", () => {
  test("ctx.ask validates payload against target schema", () => {
    const saga = defineSaga({
      type: "badPayload",
      input: z.object({}),
      context: z.object({}),
      initialContext: () => ({}),
      firstStep: "go",
      steps: {
        go: {
          run: (_input, _context, ctx) => {
            // @ts-expect-error — intentionally bad payload
            return ctx.ask(wallet, "alice", "withdraw", { amount: "not a number" });
          },
          onSuccess: () => ({ next: null }),
        },
      },
    });

    const state = sagaState(saga);
    const { run } = runSagaHandler(saga, state, "start", {});
    expect(run()).rejects.toThrow(/invalid payload/);
  });

  test("ctx.ask rejects unknown message type", () => {
    const saga = defineSaga({
      type: "badMsg",
      input: z.object({}),
      context: z.object({}),
      initialContext: () => ({}),
      firstStep: "go",
      steps: {
        go: {
          run: (_input, _context, ctx) => {
            // @ts-expect-error — intentionally bad msgType
            return ctx.ask(wallet, "alice", "bogus", {});
          },
          onSuccess: () => ({ next: null }),
        },
      },
    });

    const state = sagaState(saga);
    const { run } = runSagaHandler(saga, state, "start", {});
    expect(run()).rejects.toThrow(/unknown msgType "bogus"/);
  });

  test("ask step without onSuccess is a compile error", () => {
    defineSaga({
      type: "missingOnSuccess",
      input: z.object({}),
      context: z.object({}),
      initialContext: () => ({}),
      firstStep: "go",
      steps: {
        // @ts-expect-error — ask step requires onSuccess
        go: {
          run: (_input: Record<string, never>, _context: Record<string, never>, ctx) =>
            ctx.ask(wallet, "alice", "withdraw", { amount: 1 }),
        },
      },
    });
  });

  test("runtime error on transition to unknown step", async () => {
    const saga = defineSaga({
      type: "badTransition",
      input: z.object({}),
      context: z.object({}),
      initialContext: () => ({}),
      firstStep: "go",
      steps: {
        go: {
          run: () => ({
            next: "nonexistent" as "go", // lie about the type
          }),
        },
      },
    });

    const state = sagaState(saga);
    const { run } = runSagaHandler(saga, state, "start", {});
    await expect(run()).rejects.toThrow(/unknown step "nonexistent"/);
  });
});

describe("edge cases", () => {
  const simpleSaga = defineSaga({
    type: "simple",
    input: z.object({ target: z.string() }),
    context: z.object({}),
    initialContext: () => ({}),
    firstStep: "go",
    steps: {
      go: {
        run: (input, _context, ctx) =>
          ctx.ask(wallet, input.target, "withdraw", { amount: 10 }),
        onSuccess: () => ({ next: null }),
      },
    },
  });

  test("calling start on a running saga fails", async () => {
    const state = sagaState(simpleSaga);
    // First start succeeds
    const { run: run1 } = runSagaHandler(
      simpleSaga, state, "start", { target: "alice" },
    );
    await run1();
    expect(state.phase).toBe("running");

    // Second start should fail
    const { run: run2 } = runSagaHandler(
      simpleSaga, state, "start", { target: "bob" },
    );
    await expect(run2()).rejects.toThrow(/FailSentinel/);
    // State unchanged — still running the original saga
    expect(state.phase).toBe("running");
    expect(state.input).toEqual({ target: "alice" });
  });

  test("calling start on a completed saga fails", async () => {
    const state = sagaState(simpleSaga);
    state.phase = "completed";

    const { run } = runSagaHandler(
      simpleSaga, state, "start", { target: "alice" },
    );
    await expect(run()).rejects.toThrow(/FailSentinel/);
    expect(state.phase).toBe("completed");
  });

  test("calling start on a failed saga fails", async () => {
    const state = sagaState(simpleSaga);
    state.phase = "failed";

    const { run } = runSagaHandler(
      simpleSaga, state, "start", { target: "alice" },
    );
    await expect(run()).rejects.toThrow(/FailSentinel/);
    expect(state.phase).toBe("failed");
  });

  test("stale reply on completed saga is ignored", async () => {
    const state = sagaState(simpleSaga);
    state.phase = "completed";
    state.currentStep = null;
    state.input = { target: "alice" };
    state.completedSteps = [{ name: "go", contextSnapshot: {} }];

    const { run } = runSagaHandler(
      simpleSaga,
      state,
      "go_reply",
      {
        result: { kind: "success", value: { newBalance: 90 } },
        context: null,
        from: { type: "wallet", name: "alice" },
      },
    );
    await run();

    // State unchanged
    expect(state.phase).toBe("completed");
    expect(state.completedSteps).toHaveLength(1);
  });

  test("stale reply on failed saga is ignored", async () => {
    const state = sagaState(simpleSaga);
    state.phase = "failed";
    state.currentStep = "go";
    state.input = { target: "alice" };
    state.completedSteps = [];
    state.failReason = "earlier_failure";

    const { run } = runSagaHandler(
      simpleSaga,
      state,
      "go_reply",
      {
        result: { kind: "fail", reason: "insufficient_funds" },
        context: null,
        from: { type: "wallet", name: "alice" },
      },
    );
    await run();

    // State unchanged — original fail reason preserved
    expect(state.phase).toBe("failed");
    expect(state.failReason).toBe("earlier_failure");
  });

  test("compensation continues when a compensate handler throws", async () => {
    const compensated: string[] = [];

    const saga = defineSaga({
      type: "throwingCompensation",
      input: z.object({}),
      context: z.object({}),
      initialContext: () => ({}),
      firstStep: "step1",
      steps: {
        step1: {
          run: (_input, context) => ({
            next: "step2" as const,
            context,
          }),
          compensate: () => {
            compensated.push("step1");
          },
        },
        step2: {
          run: (_input, context) => ({
            next: "step3" as const,
            context,
          }),
          compensate: () => {
            throw new Error("compensation exploded");
          },
        },
        step3: {
          run: (_input, _context, ctx) =>
            ctx.ask(wallet, "alice", "withdraw", { amount: 10 }),
          onSuccess: () => ({ next: null }),
        },
      },
    });

    const state = sagaState(saga);
    const { run: runStart } = runSagaHandler(saga, state, "start", {});
    await runStart();

    // Simulate failed reply on step3
    const { run: runReply } = runSagaHandler(
      saga,
      state,
      "step3_reply",
      {
        result: { kind: "fail", reason: "boom" },
        context: null,
        from: { type: "wallet", name: "alice" },
      },
    );
    await runReply();

    expect(state.phase).toBe("failed");
    // step3's ask failed so it's not compensated. step2's compensate
    // threw, but step1's still ran.
    expect(compensated).toEqual(["step1"]);
  });
});

describe("looping steps", () => {
  const multiWithdraw = defineSaga({
    type: "multiWithdraw",
    input: z.object({
      sources: z.array(z.string()),
      target: z.string(),
      amount: z.number(),
    }),
    context: z.object({ index: z.number() }),
    initialContext: () => ({ index: 0 }),
    firstStep: "withdraw",
    steps: {
      withdraw: {
        run: (input, context, ctx) =>
          ctx.ask(wallet, input.sources[context.index], "withdraw", {
            amount: input.amount,
          }),
        onSuccess: (_value, input, context) => {
          const nextIndex = context.index + 1;
          if (nextIndex < input.sources.length) {
            return { context: { index: nextIndex }, next: "withdraw" as const };
          }
          return { context, next: "deposit" as const };
        },
        compensate: (input, context, ctx) => {
          ctx.stub(wallet, input.sources[context.index]).send("deposit", {
            amount: input.amount,
          });
        },
      },
      deposit: {
        run: (input, _context, ctx) =>
          ctx.ask(wallet, input.target, "deposit", {
            amount: input.amount * input.sources.length,
          }),
        onSuccess: () => ({ next: null }),
      },
    },
  });

  function successReply(from: string) {
    return {
      result: { kind: "success" as const, value: { newBalance: 50 } },
      context: null,
      from: { type: "wallet", name: from },
    };
  }

  function failReply(from: string) {
    return {
      result: { kind: "fail" as const, reason: "insufficient_funds" },
      context: null,
      from: { type: "wallet", name: from },
    };
  }

  test("loops through all sources then deposits", async () => {
    const state = sagaState(multiWithdraw);
    const input = { sources: ["alice", "bob", "charlie"], target: "vault", amount: 10 };

    // Start: runs first withdraw ask
    const { run: runStart, internals: startEffects } = runSagaHandler(
      multiWithdraw, state, "start", input,
    );
    await runStart();
    expect(state.phase).toBe("running");
    expect(state.context).toEqual({ index: 0 });
    expect(startEffects.effects.find((e: EffectDescriptor) => e.replyTo)!.name).toBe("alice");

    // Reply from alice: advances to bob
    const { run: run1, internals: effects1 } = runSagaHandler(
      multiWithdraw, state, "withdraw_reply", successReply("alice"),
    );
    await run1();
    expect(state.context).toEqual({ index: 1 });
    expect(state.completedSteps).toHaveLength(1);
    expect(effects1.effects.find((e: EffectDescriptor) => e.replyTo)!.name).toBe("bob");

    // Reply from bob: advances to charlie
    const { run: run2, internals: effects2 } = runSagaHandler(
      multiWithdraw, state, "withdraw_reply", successReply("bob"),
    );
    await run2();
    expect(state.context).toEqual({ index: 2 });
    expect(state.completedSteps).toHaveLength(2);
    expect(effects2.effects.find((e: EffectDescriptor) => e.replyTo)!.name).toBe("charlie");

    // Reply from charlie: transitions to deposit
    const { run: run3, internals: effects3 } = runSagaHandler(
      multiWithdraw, state, "withdraw_reply", successReply("charlie"),
    );
    await run3();
    expect(state.completedSteps).toHaveLength(3);
    expect(state.currentStep).toBe("deposit");
    const depositEffect = effects3.effects.find((e: EffectDescriptor) => e.replyTo);
    expect(depositEffect!.name).toBe("vault");
    expect(depositEffect!.payload).toEqual({ amount: 30 });

    // Deposit reply: completes
    const { run: run4 } = runSagaHandler(
      multiWithdraw, state, "deposit_reply", successReply("vault"),
    );
    await run4();
    expect(state.phase).toBe("completed");
    expect(state.completedSteps).toHaveLength(4);
  });

  test("failure mid-loop compensates all prior iterations", async () => {
    const state = sagaState(multiWithdraw);
    const input = { sources: ["alice", "bob", "charlie"], target: "vault", amount: 10 };

    // Start
    const { run: runStart } = runSagaHandler(
      multiWithdraw, state, "start", input,
    );
    await runStart();

    // Alice succeeds
    const { run: run1 } = runSagaHandler(
      multiWithdraw, state, "withdraw_reply", successReply("alice"),
    );
    await run1();

    // Bob succeeds
    const { run: run2 } = runSagaHandler(
      multiWithdraw, state, "withdraw_reply", successReply("bob"),
    );
    await run2();
    expect(state.completedSteps).toHaveLength(2);

    // Charlie fails
    const { run: run3, internals } = runSagaHandler(
      multiWithdraw, state, "withdraw_reply", failReply("charlie"),
    );
    await run3();

    expect(state.phase).toBe("failed");
    expect(state.failReason).toBe("insufficient_funds");

    // Compensation: bob then alice (reverse order), each gets a deposit
    const compensationEffects = internals.effects.filter(
      (e: EffectDescriptor) => e.actorType === "wallet" && e.msgType === "deposit",
    );
    expect(compensationEffects).toHaveLength(2);
    // Reverse order: bob (index 1) then alice (index 0)
    expect(compensationEffects[0].name).toBe("bob");
    expect(compensationEffects[1].name).toBe("alice");
    expect(compensationEffects[0].payload).toEqual({ amount: 10 });
    expect(compensationEffects[1].payload).toEqual({ amount: 10 });
  });

  test("failure on first iteration has nothing to compensate", async () => {
    const state = sagaState(multiWithdraw);
    const input = { sources: ["alice", "bob"], target: "vault", amount: 10 };

    const { run: runStart } = runSagaHandler(
      multiWithdraw, state, "start", input,
    );
    await runStart();

    // Alice fails immediately
    const { run, internals } = runSagaHandler(
      multiWithdraw, state, "withdraw_reply", failReply("alice"),
    );
    await run();

    expect(state.phase).toBe("failed");
    expect(state.completedSteps).toHaveLength(0);
    // No compensation effects
    expect(internals.effects).toHaveLength(0);
  });

  test("context snapshots track correct index per iteration", async () => {
    const state = sagaState(multiWithdraw);
    const input = { sources: ["a", "b", "c"], target: "t", amount: 5 };

    const { run: runStart } = runSagaHandler(
      multiWithdraw, state, "start", input,
    );
    await runStart();

    for (let i = 0; i < 3; i++) {
      const { run } = runSagaHandler(
        multiWithdraw, state, "withdraw_reply", successReply(input.sources[i]),
      );
      await run();
    }

    // Each completed step has the correct index snapshot
    expect(state.completedSteps).toHaveLength(3);
    expect(state.completedSteps[0].contextSnapshot).toEqual({ index: 0 });
    expect(state.completedSteps[1].contextSnapshot).toEqual({ index: 1 });
    expect(state.completedSteps[2].contextSnapshot).toEqual({ index: 2 });
  });
});

describe("dynamic next steps", () => {
  test("onSuccess chooses different next step based on value", async () => {
    const saga = defineSaga({
      type: "dynamicNext",
      input: z.object({ target: z.string() }),
      context: z.object({}),
      initialContext: () => ({}),
      firstStep: "check",
      steps: {
        check: {
          run: (input, _context, ctx) =>
            ctx.ask(wallet, input.target, "withdraw", { amount: 1 }),
          onSuccess: (value, _input, context) => {
            const bal = (value as { newBalance: number }).newBalance;
            if (bal > 100) {
              return { context, next: "highBalance" as const };
            }
            return { context, next: "lowBalance" as const };
          },
        },
        highBalance: {
          run: (_input, context) => ({ next: null, context }),
        },
        lowBalance: {
          run: (_input, context) => ({ next: null, context }),
        },
      },
    });

    // High balance path
    const state1 = sagaState(saga);
    const { run: runStart1 } = runSagaHandler(
      saga, state1, "start", { target: "rich" },
    );
    await runStart1();

    const { run: runReply1 } = runSagaHandler(
      saga, state1, "check_reply",
      {
        result: { kind: "success", value: { newBalance: 500 } },
        context: null,
        from: { type: "wallet", name: "rich" },
      },
    );
    await runReply1();
    expect(state1.phase).toBe("completed");
    expect(state1.completedSteps.map((s) => s.name)).toEqual([
      "check",
      "highBalance",
    ]);

    // Low balance path
    const state2 = sagaState(saga);
    const { run: runStart2 } = runSagaHandler(
      saga, state2, "start", { target: "poor" },
    );
    await runStart2();

    const { run: runReply2 } = runSagaHandler(
      saga, state2, "check_reply",
      {
        result: { kind: "success", value: { newBalance: 5 } },
        context: null,
        from: { type: "wallet", name: "poor" },
      },
    );
    await runReply2();
    expect(state2.phase).toBe("completed");
    expect(state2.completedSteps.map((s) => s.name)).toEqual([
      "check",
      "lowBalance",
    ]);
  });

  test("sync step chains with conditional branching", async () => {
    const saga = defineSaga({
      type: "conditionalSync",
      input: z.object({ value: z.number() }),
      context: z.object({ path: z.string().optional() }),
      initialContext: () => ({ path: undefined }),
      firstStep: "decide",
      steps: {
        decide: {
          run: (input, context) => {
            if (input.value > 0) {
              return { next: "positive" as const, context: { ...context, path: "positive" } };
            }
            return { next: "negative" as const, context: { ...context, path: "negative" } };
          },
        },
        positive: {
          run: (_input, context) => ({
            next: null,
            context: { ...context, path: context.path + "->done" },
          }),
        },
        negative: {
          run: (_input, context) => ({
            next: null,
            context: { ...context, path: context.path + "->done" },
          }),
        },
      },
    });

    const state1 = sagaState(saga);
    const { run: run1 } = runSagaHandler(saga, state1, "start", { value: 42 });
    await run1();
    expect(state1.phase).toBe("completed");
    expect(state1.context).toEqual({ path: "positive->done" });
    expect(state1.completedSteps.map((s) => s.name)).toEqual(["decide", "positive"]);

    const state2 = sagaState(saga);
    const { run: run2 } = runSagaHandler(saga, state2, "start", { value: -1 });
    await run2();
    expect(state2.phase).toBe("completed");
    expect(state2.context).toEqual({ path: "negative->done" });
    expect(state2.completedSteps.map((s) => s.name)).toEqual(["decide", "negative"]);
  });
});
