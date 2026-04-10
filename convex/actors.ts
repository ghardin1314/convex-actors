import { v } from "convex/values";
import { components } from "./_generated/api";
import { makeExecute } from "./components/actors/client/execute";
import { ActorSystem } from "./components/actors/client/system";
import { defineActor } from "./components/actors/client/defineActor";

// ── Actor definitions ───────────────────────────────────────────

export const counter = defineActor({
  type: "counter",
  state: v.object({ count: v.number() }),
  messages: {
    inc: v.object({ by: v.number() }),
    dec: v.object({ by: v.number() }),
    reset: v.object({}),
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
  state: v.object({
    balance: v.number(),
    log: v.array(v.string()),
  }),
  messages: {
    deposit: v.object({ amount: v.number() }),
    withdraw: v.object({ amount: v.number() }),
    transfer: v.object({ to: v.string(), amount: v.number() }),
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
  state: v.object({ processed: v.number() }),
  messages: {
    work: v.object({ value: v.string() }),
    crash: v.object({}),
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
  state: v.object({ hits: v.number(), log: v.array(v.string()) }),
  messages: {
    serve: v.object({ to: v.string(), rallies: v.number() }),
    reset: v.object({}),
    hit: v.object({ from: v.string(), ralliesLeft: v.number() }),
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
  state: v.object({
    remaining: v.number(),
    running: v.boolean(),
    log: v.array(v.string()),
  }),
  messages: {
    start: v.object({ from: v.number(), intervalMs: v.number() }),
    tick: v.object({ intervalMs: v.number() }),
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
  state: v.object({
    rankings: v.array(
      v.object({ name: v.string(), count: v.number() }),
    ),
    lastRefresh: v.optional(v.number()),
  }),
  messages: {
    refresh: v.object({}),
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
        const count =
          projection &&
          typeof projection === "object" &&
          "count" in projection
            ? (projection as { count: number }).count
            : 0;
        entries.push({ name, count });
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
