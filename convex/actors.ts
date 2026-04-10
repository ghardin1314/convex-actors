import { z } from "zod";
import { components } from "./_generated/api";
import { makeExecute } from "./components/actors/client/execute";
import { ActorSystem } from "./components/actors/client/system";
import { defineActor } from "./components/actors/client/defineActor";

// ── Actor definitions ───────────────────────────────────────────

export const counter = defineActor({
  type: "counter",
  state: z.object({ count: z.number() }),
  messages: {
    inc: z.object({ by: z.number() }),
    dec: z.object({ by: z.number() }),
    reset: z.object({}),
  },
  initialState: () => ({ count: 0 }),
  project: (state) => ({ count: state.count }),
  handle: {
    inc: async (state, { by }) => {
      state.count += by;
    },
    dec: async (state, { by }) => {
      state.count -= by;
    },
    reset: async (state) => {
      state.count = 0;
    },
  },
});

export const wallet = defineActor({
  type: "wallet",
  state: z.object({
    balance: z.number(),
    log: z.array(z.string()),
  }),
  messages: {
    deposit: z.object({ amount: z.number() }),
    withdraw: z.object({ amount: z.number() }),
    transfer: z.object({ to: z.string(), amount: z.number() }),
  },
  initialState: () => ({ balance: 0, log: [] }),
  project: (state) => ({ balance: state.balance, log: state.log }),
  handle: {
    deposit: async (state, { amount }) => {
      state.balance += amount;
      state.log = [...state.log.slice(-9), `+$${amount} (balance: $${state.balance})`];
      return { newBalance: state.balance };
    },
    withdraw: async (state, { amount }, ctx) => {
      if (amount > state.balance) {
        ctx.fail("insufficient_funds", {
          requested: amount,
          available: state.balance,
        });
      }
      state.balance -= amount;
      state.log = [...state.log.slice(-9), `-$${amount} (balance: $${state.balance})`];
      return { newBalance: state.balance };
    },
    transfer: async (state, { to, amount }, ctx) => {
      // Atomic: balance check + debit + send deposit all in one handler.
      // No TOCTOU race because the wallet processes messages sequentially.
      if (amount > state.balance) {
        state.log = [
          ...state.log.slice(-9),
          `REJECTED transfer $${amount} -> ${to} (balance: $${state.balance})`,
        ];
        ctx.fail("insufficient_funds", {
          requested: amount,
          available: state.balance,
        });
      }
      state.balance -= amount;
      ctx.stub(wallet, to).send("deposit", { amount });
      state.log = [
        ...state.log.slice(-9),
        `transferred $${amount} -> ${to} (balance: $${state.balance})`,
      ];
      return { newBalance: state.balance };
    },
  },
});

export const fragile = defineActor({
  type: "fragile",
  state: z.object({ processed: z.number() }),
  messages: {
    work: z.object({ value: z.string() }),
    crash: z.object({}),
  },
  initialState: () => ({ processed: 0 }),
  project: (state) => ({ processed: state.processed }),
  handle: {
    work: async (state, { value }) => {
      state.processed++;
      return { echo: value };
    },
    crash: async () => {
      throw new Error("unexpected internal failure");
    },
  },
});

export const pingPong = defineActor({
  type: "pingPong",
  state: z.object({ hits: z.number(), log: z.array(z.string()) }),
  messages: {
    serve: z.object({ to: z.string(), rallies: z.number() }),
    reset: z.object({}),
    hit: z.object({ from: z.string(), ralliesLeft: z.number() }),
  },
  initialState: () => ({ hits: 0, log: [] }),
  project: (state) => ({ hits: state.hits, log: state.log }),
  handle: {
    serve: async (state, { to, rallies }, ctx) => {
      const self = ctx.self();
      state.hits = 0;
      state.log = [`serving to ${to} (${rallies} rallies)`];
      ctx.stub(pingPong, to).send("reset", {});
      ctx.stub(pingPong, to).send("hit", {
        from: self.name,
        ralliesLeft: rallies - 1,
      });
    },
    reset: async (state) => {
      state.hits = 0;
      state.log = [];
    },
    hit: async (state, { from, ralliesLeft }, ctx) => {
      const self = ctx.self();
      state.hits++;
      const action =
        ralliesLeft > 0
          ? `${from} -> ${self.name} -> ${from}`
          : `${from} -> ${self.name} (end)`;
      state.log = [...state.log.slice(-9), `#${state.hits} ${action}`];

      if (ralliesLeft > 0) {
        ctx.stub(pingPong, from).send("hit", {
          from: self.name,
          ralliesLeft: ralliesLeft - 1,
        });
      }
    },
  },
});

export const countdown = defineActor({
  type: "countdown",
  state: z.object({
    remaining: z.number(),
    running: z.boolean(),
    log: z.array(z.string()),
  }),
  messages: {
    start: z.object({ from: z.number(), intervalMs: z.number() }),
    tick: z.object({ intervalMs: z.number() }),
  },
  initialState: () => ({ remaining: 0, running: false, log: [] }),
  project: (state) => ({
    remaining: state.remaining,
    running: state.running,
    log: state.log,
  }),
  handle: {
    start: async (state, { from, intervalMs }, ctx) => {
      state.remaining = from;
      state.running = true;
      state.log = [`started at ${from}`];
      ctx.sendSelf("tick", { intervalMs }, { after: intervalMs });
    },
    tick: async (state, { intervalMs }, ctx) => {
      if (!state.running) return;
      state.remaining--;
      state.log = [
        ...state.log.slice(-9),
        `tick -> ${state.remaining}`,
      ];
      if (state.remaining <= 0) {
        state.running = false;
        state.log = [...state.log.slice(-9), "done!"];
      } else {
        ctx.sendSelf("tick", { intervalMs }, { after: intervalMs });
      }
    },
  },
});

const LEADERBOARD_COUNTERS = ["alice", "bob", "charlie"];

export const leaderboard = defineActor({
  type: "leaderboard",
  state: z.object({
    rankings: z.array(
      z.object({ name: z.string(), count: z.number() }),
    ),
    lastRefresh: z.number().optional(),
  }),
  messages: {
    refresh: z.object({}),
  },
  initialState: () => ({ rankings: [], lastRefresh: undefined }),
  project: (state) => ({
    rankings: state.rankings,
    lastRefresh: state.lastRefresh,
  }),
  handle: {
    refresh: async (state, _payload, ctx) => {
      const entries: { name: string; count: number }[] = [];
      for (const name of LEADERBOARD_COUNTERS) {
        const projection = await ctx.stub(counter, name).peek();
        entries.push({ name, count: projection?.count ?? 0 });
      }
      entries.sort((a, b) => b.count - a.count);
      state.rankings = entries;
      state.lastRefresh = ctx.now();
    },
  },
});

// ── Wire-up ─────────────────────────────────────────────────────

const defs = { counter, wallet, fragile, pingPong, countdown, leaderboard };

export const execute = makeExecute(defs, components.actors);
export const system = new ActorSystem(components.actors, defs);
