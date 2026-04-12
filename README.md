# Convex Actors

A distributed actor framework built as a [Convex component](https://docs.convex.dev/components). Define stateful, message-driven actors and multi-step sagas with full type safety, durable execution, and automatic crash recovery — all running on Convex's serverless backend.

## Why actors on Convex?

Convex gives you a reactive database, serverless functions, and scheduling. Actors add a coordination layer on top: named, stateful entities that process messages one at a time, send messages to each other, and survive crashes. If you need to model a long-lived process (a checkout flow, an auction, a multi-step approval pipeline) that reacts to events over time and maintains its own state, actors are a natural fit.

## Features

- **Type-safe definitions** — Actors and sagas are defined with Zod schemas. Message payloads, state, responses, and projections are all validated and inferred at the type level.
- **Serial message processing** — Each actor processes one message at a time. No concurrent state mutations, no locking, no races within an actor.
- **Fire-and-forget (`send`) and request-response (`ask`)** — Communicate between actors with `send` for one-way messages, or `ask` when you need the response routed back to a handler.
- **Scheduled messages** — Send messages to arrive in the future with `{ after: ms }` or `{ at: timestamp }`.
- **Projections** — Define a `project` function to expose a read-only, client-safe view of actor state via `system.peek()`. Queries subscribe reactively to projections.
- **Sagas with compensation** — Multi-step workflows that automatically roll back completed steps (in reverse order) when a later step fails.
- **Crash recovery** — A background cron detects stalled actors and restarts their message processing. Messages retry up to 3 times before being marked as defects.
- **Immer-based state mutation** — Handlers receive a mutable draft of state. Mutate directly; the framework handles immutable snapshots under the hood.

---

## Core concepts

### Actors

A named, stateful entity identified by `(type, name)` — e.g. `("account", "alice")`. You define its state shape, the messages it accepts, and a handler for each message. Messages are processed serially — no concurrent mutations within a single actor.

```ts
const account = defineActor({
  type: "account",
  state: z.object({ balance: z.number() }),
  messages: {
    deposit: { payload: z.object({ amount: z.number() }) },
  },
  initialState: () => ({ balance: 0 }),
  project: (state) => ({ balance: state.balance }),
  handle: {
    deposit: async (state, { amount }) => {
      state.balance += amount;
    },
  },
});
```

### Sagas

A multi-step workflow with built-in rollback. Each step can `send` fire-and-forget messages or `ask` another actor and wait for a response. Steps define `compensate` functions that run in reverse order when a later step fails.

```ts
const transferSaga = defineSaga({
  type: "transfer",
  input: z.object({ from: z.string(), to: z.string(), amount: z.number() }),
  context: z.object({}),
  initialContext: () => ({}),
  firstStep: "debit",
  steps: {
    debit: {
      run: (input, _ctx, ctx) =>
        ctx.stub(account, input.from).ask("withdraw", { amount: input.amount }),
      onSuccess: () => ({ next: "credit" }),
      compensate: (input, _ctx, ctx) => {
        ctx.stub(account, input.from).send("deposit", { amount: input.amount });
      },
    },
    credit: {
      run: (input, _ctx, ctx) =>
        ctx.stub(account, input.to).ask("deposit", { amount: input.amount }),
      onSuccess: () => ({ next: null }), // null = saga complete
    },
  },
});
```

### ActorSystem

The dispatch layer your app code uses to send messages and read state. Created with your actor/saga definitions and the installed component.

```ts
import { components } from "./_generated/api";
import { ActorSystem, makeExecute } from "./components/actors/client";

// Register all definitions
const AllDefs = { account, transferSaga };

// Execute function — called internally by the drain loop to run handlers
export const execute = makeExecute(AllDefs, components.actors);

// System instance — your app-facing API
export const system = new ActorSystem(components.actors, AllDefs);
```

Then use it from your mutations and queries:

```ts
// Send a message (from a mutation)
const messageId = await system.send(ctx, internal.system.execute, account, "alice", "deposit", { amount: 100 });

// Read state (from a query — reactive)
const projection = await system.peek(ctx, account, "alice");
// => { balance: 100 }

// Check message outcome
const response = await system.getResponse(ctx, { messageId });
// => { kind: "success", value: undefined }
```

---

## Defining an actor

```ts
import { z } from "zod";
import { defineActor } from "./components/actors/client";

export const counter = defineActor({
  type: "counter",

  // Zod schema for persisted state
  state: z.object({
    count: z.number(),
  }),

  // Messages this actor accepts, each with a payload schema
  messages: {
    increment: { payload: z.object({ by: z.number() }) },
    reset: { payload: z.object({}) },
  },

  // State for a brand-new actor instance
  initialState: () => ({ count: 0 }),

  // Read-only projection exposed to queries via system.peek()
  project: (state) => ({ count: state.count }),

  // Handlers — one per message type
  handle: {
    increment: async (state, { by }) => {
      state.count += by;
    },
    reset: async (state) => {
      state.count = 0;
    },
  },
});
```

### Handler context

Every handler receives `(state, payload, ctx)`. The context provides:

| Method | Description |
|---|---|
| `ctx.self.send(msg, payload, opts?)` | Send a message to yourself (e.g. schedule a timer tick) |
| `ctx.stub(def, name).send(msg, payload)` | Fire-and-forget message to another actor |
| `ctx.stub(def, name).ask(msg, payload, opts)` | Send a message and route the response back to a handler on this actor |
| `ctx.stub(def, name).peek()` | Read another actor's projection |
| `ctx.now()` | Stable wall-clock timestamp for the current transaction |
| `ctx.fail(reason, details?)` | Signal a domain-level failure (caught by the framework as a `fail` response) |

### Scheduling

```ts
// Deliver after a delay
ctx.self.send("tick", { epoch: 0 }, { after: 30_000 });

// Deliver at a specific wall-clock time
ctx.self.send("remind", {}, { at: Date.now() + 60_000 });
```

### Ask / reply

When an actor needs a response from another actor, use `ask`. The response is delivered as a message to a reply handler on the calling actor:

```ts
// In the calling actor's handler:
ctx.stub(account, "alice").ask("hold", { holdId: "h1", amount: 50 }, {
  handler: "holdResult",  // name of the handler that receives the reply
});

// The reply handler receives a ReplyPayload:
holdResult: async (state, { result, from }) => {
  if (result.kind === "success") {
    // result.value contains the return value from `hold`
  } else if (result.kind === "fail") {
    // result.reason is the string passed to ctx.fail()
  }
},
```

Build reply handler payload schemas with the `reply()` helper:

```ts
import { reply } from "./components/actors/client";

messages: {
  holdResult: {
    payload: reply(account, "hold"),
  },
},
```

---

## Defining a saga

Sagas orchestrate multi-actor workflows with built-in rollback. Each step either runs synchronously or issues an `ask` and waits for the response.

```ts
import { z } from "zod";
import { defineSaga } from "./components/actors/client";

export const transferSaga = defineSaga({
  type: "transfer",

  // Input provided when the saga starts
  input: z.object({
    from: z.string(),
    to: z.string(),
    amount: z.number(),
  }),

  // Per-step context that carries data between steps
  context: z.object({ holdId: z.string() }),
  initialContext: () => ({ holdId: "" }),

  firstStep: "holdFunds",

  steps: {
    holdFunds: {
      // Ask steps return an AskDescriptor
      run: (input, _ctx, ctx) =>
        ctx.stub(account, input.from).ask("hold", {
          holdId: `transfer-${ctx.self.name}`,
          amount: input.amount,
        }),

      // Called when the ask succeeds — advance to the next step
      onSuccess: (_value, input, context) => ({
        context: { ...context, holdId: `transfer-${input.from}` },
        next: "settle",
      }),

      // Runs during rollback if a *later* step fails
      compensate: (input, _context, ctx) => {
        ctx.stub(account, input.from).send("releaseHold", {
          holdId: `transfer-${ctx.self.name}`,
        });
      },
    },

    settle: {
      run: (input, _context, ctx) =>
        ctx.stub(account, input.from).ask("settleHold", {
          holdId: `transfer-${ctx.self.name}`,
        }),
      onSuccess: () => ({ next: null }), // null = saga complete
    },
  },
});
```

### Saga lifecycle

| Phase | Meaning |
|---|---|
| `idle` | Created but not yet started |
| `running` | Processing steps |
| `completed` | All steps succeeded |
| `failed` | A step failed; compensation has run |

The saga's projection exposes `{ phase, currentStep, completedSteps, failedStep, failReason }`.

### Compensation

When a step fails, the framework walks through `completedSteps` in reverse and calls each step's `compensate` function. Compensation handlers can only `send` (fire-and-forget) — no `ask` allowed, since that would reintroduce the failure modes that triggered compensation.

---

## Wiring up the system

### 1. Install the component

In your app's `convex.config.ts`:

```ts
import { defineApp } from "convex/server";
import actors from "./components/actors/convex.config.js";

const app = defineApp();
app.use(actors);
export default app;
```

### 2. Register definitions and create the system

Create a `system.ts` that exports the execute function and system instance:

```ts
import { components } from "./_generated/api";
import { ActorSystem, makeExecute } from "./components/actors/client";
import { counter } from "./actorDefs/counter";
// ... import other actor/saga definitions

const AllDefs = { counter /* , ...others */ };

// The execute function is called internally by the drain loop to run handlers
export const execute = makeExecute(AllDefs, components.actors);

// The system is your app-facing dispatch API
export const system = new ActorSystem(components.actors, AllDefs, {
  logLevel: "DEBUG", // optional
});
```

### 3. Use from your app's mutations and queries

```ts
import { mutation, query } from "./_generated/server";
import { internal } from "./_generated/api";
import { counter } from "./actorDefs/counter";
import { system } from "./system";

// Send a message (from a mutation)
export const increment = mutation({
  args: { name: v.string(), by: v.number() },
  handler: async (ctx, { name, by }) => {
    // Returns a messageId you can use to track the response
    return await system.send(
      ctx,
      internal.system.execute,
      counter,
      name,
      "increment",
      { by },
    );
  },
});

// Read state (from a query — reactive!)
export const getCounter = query({
  args: { name: v.string() },
  handler: async (ctx, { name }) => {
    // Returns the projection, or null if the actor doesn't exist yet
    return await system.peek(ctx, counter, name);
  },
});

// Check a message's outcome
export const getResponse = query({
  args: { messageId: v.string() },
  handler: async (ctx, { messageId }) => {
    return await system.getResponse(ctx, { messageId });
  },
});
```

### Response types

`getResponse` returns `null` until the message is processed, then one of:

```ts
{ kind: "success", value: T }  // Handler returned successfully
{ kind: "fail", reason: string, details?: unknown }  // Handler called ctx.fail()
{ kind: "defect", error: string }  // Handler threw an unexpected error
```

---

## Constraints

The current implementation makes deliberate trade-offs. Understanding these upfront will save you from hitting walls mid-build.

**Mutation-only execution** — Handlers run inside Convex mutations, not actions. You cannot call third-party APIs (HTTP requests, external services) from within a handler. If you need to talk to an external system, do it in a separate action outside the actor and send the result back as a message.

**No direct database access** — Handlers cannot read or write your app's Convex tables. The only state a handler can touch is its own actor state (via the mutable `state` draft) and other actors' projections (via `ctx.stub(def, name).peek()`). If you need to update an app table based on actor state, do it in a mutation that reads the projection with `system.peek()`.

**No raw Convex ctx** — Handlers receive a sandboxed `ctx` with `self`, `stub`, `now()`, and `fail()`. There is no access to `ctx.db`, `ctx.runQuery`, `ctx.runMutation`, `ctx.scheduler`, or `ctx.auth`. All coordination happens through messages.

**Latency** — Actors are not in-memory. State is loaded from the database on each message batch and persisted after each handler. This adds a round-trip per message compared to in-memory actor systems. Suitable for workflows and coordination — not for sub-millisecond hot paths.

**Single-actor transactions** — Each handler executes in one transaction scoped to one actor. There is no cross-actor transaction. If you need atomic operations across multiple actors, use a saga (which provides eventual consistency with compensation, not ACID across actors).

**No actor deletion** — There is currently no API to destroy an actor or garbage-collect its state. Actors are created implicitly on first message and live indefinitely.

**Sagas are one-shot** — A saga instance can only be started once. Sending `start` to an already-started saga fails with `saga_already_started`. Use a unique name (e.g. an idempotency key) per attempt.

---

## Demo: auction house

The included demo is a real-time auction house that exercises every feature of the framework. It's a full-stack app with a React frontend and Convex backend.

### Actor topology

```
┌──────────────┐   reportState    ┌──────────────────┐
│ auctionHouse │ ◄──────────────  │ auction (per item)│
│  (singleton) │ ──createAuction──►                   │
└──────────────┘                  └──────┬───────────-┘
                                         │ settlementComplete/Failed
                                         ▲
                                  ┌──────┴───────────┐
                                  │ settlementSaga    │
                                  └──────┬────────────┘
                                         │ settleHold / deposit
                                         ▼
┌──────────────┐   hold/release   ┌──────────────────┐
│   bidSaga    │ ────────────────►│ account (per user)│
│ (per bid)    │                  └──────────────────-┘
└──────┬───────┘
       │ bid
       ▼
  auction (target)
```

### Actors

**`account`** — Per-user balance with hold/release/settle semantics. Holds reserve funds for an in-flight bid without deducting the balance, enabling safe concurrent bidding across multiple auctions.

**`auction`** — State machine for a single auction: `initializing → active → going_once → going_twice → settling → sold`. Features snipe protection (bids during going_once/going_twice reset the countdown) and timer-driven phase transitions via self-scheduled `tick` messages.

**`auctionHouse`** — Singleton supervisor that allocates auction names, maintains a registry of all auctions (updated via push-based `reportState` messages from each auction), and runs a lazy health-check loop to detect auctions stuck in `settling`.

**`userBids`** — Per-user index of bid attempts, for display in the UI. Idempotent on the saga's idempotency key.

### Sagas

**`bidSaga`** — Orchestrates a bid attempt:
1. **holdFunds** — `ask` the bidder's account to hold the bid amount
2. **placeBid** — `ask` the auction to accept the bid

If `placeBid` fails (e.g. outbid, auction closed), compensation releases the hold.

**`settlementSaga`** — Drives post-auction settlement:
1. **begin** — Sync marker step whose compensation notifies the auction of failure
2. **settleWinnerHold** — `ask` winner's account to debit the held amount
3. **payoutSeller** — `ask` seller's account to receive the payout
4. **notifyAuction** — Fire-and-forget `settlementComplete` to the auction

Compensation refunds the winner and notifies the auction via `settlementFailed`.

### App API layer

The UI never talks to the actor framework directly. `convex/auctions.ts` defines typed queries and mutations that wrap `system.send()` and `system.peek()`:

| Endpoint | Type | Description |
|---|---|---|
| `list` | query | Lobby view — all auctions from the supervisor's projection |
| `getAuction(name)` | query | Single auction detail (reactive) |
| `getAccount(user)` | query | User's balance and available balance |
| `listUserBids(user)` | query | User's bid history |
| `getBidStatus(key)` | query | Bid saga projection (phase, steps, failure reason) |
| `getResponse(id)` | query | Raw message response (success/fail/defect) |
| `createAuction(...)` | mutation | Sends `createAuction` to the auction house |
| `placeBid(...)` | mutation | Starts a `bidSaga` |
| `deposit(...)` | mutation | Deposits funds into a user's account |

### Frontend patterns

The React frontend uses `@convex-dev/react-query` for reactive data. Two key patterns:

**Response awaiting** — Mutations return a `messageId`. The UI subscribes to `getResponse(messageId)` and resolves a promise when the response lands. This gives fire-and-wait semantics over the async actor pipeline.

**Saga awaiting** — For bids, the UI subscribes to `getBidStatus(idempotencyKey)` and waits for the saga to reach a terminal phase (`completed` or `failed`). The saga projection gives step-by-step progress.

### Running the demo

```bash
pnpm install
pnpm dev
```

This starts both the Convex dev server and the Vite frontend. Open the URL printed by Vite to see the auction lobby.

---

## Comparison with other actor systems

| | Convex Actors | Cloudflare Durable Objects | Microsoft Orleans | Akka / Pekko | Temporal |
|---|---|---|---|---|---|
| **Runtime** | Serverless (Convex functions) | Serverless (Workers) | Self-hosted or Azure | Self-hosted JVM | Self-hosted or Cloud |
| **State storage** | Convex database (persistent, transactional) | Key-value store co-located with the object | Grain state in external storage (table, blob, etc.) | In-memory by default; optional persistence via event sourcing | Workflow history in database |
| **State durability** | Always persisted — every handler runs in a transaction | Persisted via explicit `storage` API calls | Persisted on deactivation or explicit save | Opt-in (event sourcing / snapshotting) | Implicit — workflow history is the state |
| **Activation model** | No warm instance — state loaded from DB per message batch | Single-threaded isolate, routed by ID | Virtual actors — activated on demand, deactivated after idle | Long-lived in-memory processes | Workers poll for tasks — no persistent process |
| **Message ordering** | Serial per actor (drain loop processes one at a time) | Serial per object (single-threaded) | Serial per grain (turn-based reentrancy by default) | Mailbox-ordered, configurable dispatchers | N/A — step-based, not message-based |
| **Request-response** | `ask` with typed reply routing to a handler | Direct method calls (RPC) | Direct method calls (RPC) | `ask` pattern with futures | Activity return values |
| **Multi-step workflows** | Built-in sagas with automatic compensation | Manual (write your own orchestration) | Manual (write your own orchestration) | Saga pattern libraries available | Core primitive — workflows are step sequences with replay |
| **Reactive queries** | Native — `system.peek()` in a Convex query subscribes to state changes | Requires WebSocket or polling | Requires SignalR or polling | Requires custom pub/sub | Requires polling or async completion |
| **Schema validation** | Zod schemas on state, messages, and responses | None built-in | None built-in | None built-in (Protobuf optional) | None built-in (Protobuf/JSON schema optional) |
| **Crash recovery** | Automatic — cron detects stalled drains, retries messages (max 3 attempts) | Platform handles isolate crashes; storage survives | Silo failover reactivates grains on healthy nodes | Supervision trees restart failed actors | Automatic — replays workflow history from last checkpoint |
| **Infrastructure** | Zero — runs on Convex | Cloudflare account | Cluster of silo hosts + storage backend | JVM cluster + optional persistence backend | Temporal server + database + worker hosts |

### Key differences

**vs. Durable Objects** — Durable Objects are co-located compute + storage with a single-threaded isolate per object. Convex Actors don't maintain a warm process — state is loaded from the database on each message batch, which trades latency for simpler operational semantics (no evacuation, no hibernation API). Convex's reactive queries also mean the client gets pushed state changes automatically, whereas DOs require WebSockets.

**vs. Orleans** — Orleans virtual actors (grains) activate on demand and stay in memory until idle timeout. State persistence is a pluggable provider. Convex Actors are similar in the "virtual" sense (no explicit lifecycle management), but state is always transactionally persisted and queries are reactive. Orleans has no built-in saga primitive.

**vs. Akka** — Akka actors are long-lived in-memory processes with optional persistence via event sourcing. They offer much lower latency for in-memory state access and fine-grained supervision trees. Convex Actors are a better fit when you want durable-by-default state, transactional guarantees, and zero infrastructure — but not for sub-millisecond message processing.

**vs. Temporal** — Temporal is purpose-built for durable workflows (sagas). Its replay-based execution model is more battle-tested for long-running, multi-step processes. Convex Actors are a lighter-weight alternative when your workflows also need reactive state that the UI can subscribe to, and you're already on Convex. Temporal requires dedicated infrastructure; Convex Actors run as a component with no extra services.

---

## Future Potential plans

Roughly ordered by expected complexity.

**TTL for messages and responses** — Processed messages and response rows accumulate indefinitely. A TTL mechanism would let the framework automatically clean up completed messages and their responses after a configurable retention window, reducing storage costs for high-throughput actors.

**App table access from handlers** — Currently handlers are sandboxed: they can only mutate their own actor state and communicate via messages. Allowing handlers to read (and possibly write) app-defined tables would unlock patterns like writing to a shared log, querying reference data, or maintaining denormalized views — without round-tripping through a separate mutation.

**Actor lifecycle management** — No API exists to destroy an actor or reclaim its state. A `destroy` / `deactivate` primitive would enable cleanup of short-lived actors (e.g. one-off sagas, expired sessions). This likely pairs with TTL — idle actors past a threshold could be candidates for automatic garbage collection.

**Actor event subscriptions** — Allow actors to emit named events and let other actors subscribe to them. Currently, inter-actor communication requires the sender to know its recipients (e.g. `auction` explicitly sends `reportState` to `auctionHouse`). An event system would invert this: an actor emits `"bidPlaced"` and any subscriber receives it, decoupling producers from consumers. Enables fan-out patterns, audit logging actors, and reactive projections without hardcoding the wiring in every handler. This could also be extended outside of the actor system so app workflows could be triggered by actor events. 

**Batched drain execution** — The drain loop currently processes one message per transaction. Processing multiple messages in a single transaction (up to a configurable batch size) would reduce scheduling overhead for actors with high message throughput, at the cost of larger transaction conflict windows.

**Action-based actors** — The big one. Handlers currently run as mutations, which means no HTTP calls, no third-party APIs, no LLM calls. Action-based actors would run handlers as Convex actions, enabling external I/O. This is architecturally hard: actions aren't transactional, so state persistence, effect ordering, and retry semantics all need rethinking. Likely requires a two-phase approach — action executes with optimistic state, then a follow-up mutation commits or rolls back.

**Durable workflows** — Building on action-based actors, a workflow primitive (like Temporal's workflow/activity split) where long-running orchestrations can call external services, sleep for arbitrary durations, and resume from checkpoints. This would extend the saga model with replay-based durability: each step's result is persisted, and on recovery the workflow replays from the last checkpoint rather than re-executing. Depends on action-based actors landing first.
