# Convex Actors — MVP Spec

A virtual actor framework built as a Convex component. Actors are addressed by
`(type, name)`, hold durable state, process messages sequentially in per-actor
FIFO order, and are defined as handlers that mutate state via Immer drafts
and produce typed responses.

## Goals

- Actors keep their own state, durably.
- Actors respond to messages.
- Actors can send messages to other actors.
- Actors can schedule messages to themselves or others.
- Handlers run in Convex mutations. All side effects are mediated through the
  framework-supplied `ctx` — handlers never touch `ctx.db` or `ctx.scheduler`
  directly.
- Messages to a given actor are processed sequentially in arrival/delivery
  order. Different actors process in parallel.

## Non-goals (MVP)

- No `ask` primitive for actor-to-actor request/response. Client-to-actor
  request/response is supported via the responses table + reactive queries.
- No async/await replay-style handlers. Handlers are `async` for DB ops but
  cannot suspend across transactions. Planned for v2.
- No supervision trees, no linking, no restart policies.
- No explicit spawn/stop. Actors are virtual: they exist on first reference.
- No framework-level authorization. Users wrap `send` in their own mutations.
- No batch draining. One message per drain transaction.

## Core concepts

### Virtual actors

Actors exist conceptually as soon as they are referenced by `(type, name)`.
The first message sent to an address lazily creates the actor row using the
definition's `initialState()`. There is no `spawn` operation. Peeks on a
never-written actor return `null`.

Addressing is always `(actorType: string, name: string)` in the public API.
Internal `Id<"actor">` rows exist but are not exposed (future work if a real
use case emerges).

### Handlers

Handlers are pure reducers over `(state, payload, ctx)`. State is passed as an
Immer draft; handlers mutate freely. The handler's **return value** is stored
as the message's response. `ctx` provides cross-actor stubs and control-flow
primitives. Handlers are `async` to support DB-backed ctx operations (e.g.
enqueuing sends), but cannot suspend across transactions.

```ts
handle: {
  withdraw: async (state, { amount }, ctx) => {
    if (state.balance < amount) {
      ctx.fail("insufficient_funds", { available: state.balance })
    }
    state.balance -= amount
    return { newBalance: state.balance }
  },
}
```

### Message ordering

- FIFO per actor among _deliverable_ messages (`deliverAt <= now()`).
- Scheduled messages step out of line to their delivery time and rejoin at
  that point. A message scheduled for `T+10s` does not block messages sent
  after it but before `T+10s`.
- Ties in `deliverAt` are broken by `_creationTime`.

### Per-actor drain loop

Each actor has its own drain loop, analogous to workpool's `main` + `runStatus`
but scoped to one mailbox. At any moment, an actor is in one of three states,
tracked in a `mailboxState` row (separate from the `actor` state row to avoid
OCC between send and drain):

- **idle** — no pending work, no scheduled drain.
- **scheduled** — one `drain(actorId)` mutation queued in
  `_scheduled_functions` at time `T`.
- **running** — drain is executing now.

A **kick** happens on every `send`:

- **idle** → schedule `drain({ actorId, generation: state.generation })`
  at `deliverAt`, transition to `scheduled`. Kick reads the current
  `generation` and passes it through unchanged; see "Drain generation
  and recovery" for why kick never writes `generation`.
- **scheduled** at a time ≤ `deliverAt + KICK_EPSILON_MS` → do nothing.
  The existing run will pick up the new row. The `KICK_EPSILON_MS`
  slack (default 1 second) prevents pointless cancel-and-reschedule
  churn when a kick's requested time is only trivially earlier than
  the existing schedule; any sub-epsilon latency win isn't worth the
  scheduler row churn.
- **scheduled** at a time > `deliverAt + KICK_EPSILON_MS` (need to
  meaningfully bring drain forward) → look up the currently-scheduled
  row via `ctx.db.system.get(scheduledId)`. If it's still `pending`,
  call `ctx.scheduler.cancel(scheduledId)`. If it's in any other state
  (`inProgress`, `success`, `failed`, `canceled`) or the row is gone,
  skip the cancel and log a warning — a stale `scheduledId` pointer
  means a previous drain fired without `mailboxState.drain` being
  updated cleanly. Either way, schedule a fresh `drain` at the earlier
  time (carrying the current `state.generation` unchanged), and
  overwrite `scheduled.scheduledId` in `mailboxState`. The reschedule
  is mandatory; the cancel is best-effort cleanup.

Before any scheduling call, `deliverAt` is clamped by
`boundScheduledTime`: timestamps more than a year in the past are
rewritten to `now` ("run ASAP"), and timestamps more than four years
in the future are rewritten to `now + 1 year`. Both cases are almost
certainly bugs — clock skew, forgotten units, or a rogue caller — and
the clamp keeps them from poisoning the scheduler or the no-op epsilon
comparison on follow-up kicks.
- **running** → do nothing. The drain will loop.

Kick attempts `ctx.scheduler.cancel` as an **optimization**, not for
correctness: it avoids accumulating stale `_scheduled_functions` rows for
hot actors that get kicked repeatedly, and it frees the old scheduler slot
so the new drain doesn't sit behind it. Correctness comes entirely from
the generation check at the top of `drain` — any stale invocation
that slips through (cancel raced, scheduler already dispatched it, etc.)
loads `mailboxState`, sees `args.generation !== state.generation`, and
returns without touching anything.

**Running-state race.** A drain in flight must not miss a message
committed by a concurrent send. Two mechanisms combine to guarantee this:

1. **Range-read OCC on `pendingMessages`.** Step 2 of the drain range-scans
   `by_actor_deliverable` for this actor. Step 8 range-scans again to
   decide what to reschedule. Convex's OCC tracks range reads: any insert
   into that range by a concurrent transaction will conflict with the
   drain's commit, forcing Convex to retry the drain from the top. On
   retry, the new row is visible.
2. **`mailboxState` writes for state transitions.** An idle-path kick
   writes `idle → scheduled`; a drain commit writes its step-8 transition.
   These serialize on the `mailboxState` row itself so two kicks, or a
   kick plus a drain transition, cannot interleave incoherently.

Running-path kicks **do not** write `mailboxState` — they are pure no-ops
on that row — so there is no direct write-write conflict between a kick
and a running drain. Safety comes entirely from (1): the send's insert
conflicts with the drain's `pendingMessages` range read, and Convex
retries the drain, which then observes the insert.

Generation is the orthogonal mechanism that makes the *scheduling* side
safe without `ctx.scheduler.cancel`: any in-flight scheduled drain whose
generation no longer matches exits at step 1.

The drain is `drain({ actorId, generation })`. It processes exactly one
message per transaction:

1. Load `mailboxState`. If `args.generation !== state.generation`, this
   invocation is stale (superseded by recovery, or by a sibling drain
   that already committed and bumped) — return immediately, no state
   change. Otherwise bump `state.generation` by one, transition
   `mailboxState` to `running`, and load the actor row. The bump is the
   fence: any other scheduled drain that was racing this one now
   carries a stale `generation` arg and will exit on its own step 1.
2. Read next deliverable `pendingMessages` row by
   `[actorId, deliverAt, sendSeq]` (see "Send ordering" below). The full
   message payload lives in the permanent `messages` table, referenced by
   `messageId`.
3. If none: transition `mailboxState` to `scheduled` for the next future
   `deliverAt`, or `idle` if no pending rows at all. Return.
4. If `pendingMessages.attempts >= 3` (a prior run already burned the attempt
   budget), skip straight to step 7's defect path. Otherwise invoke handler
   via fnHandle with `(state, payload, ctx)`. Handler-side `stub.send(...)`
   calls push **effect descriptors** onto a private list on ctx — no DB
   writes happen yet.
5. **On success:** commit next state, apply accumulated effect descriptors
   as real inserts into `messages` and `pendingMessages` (each row's
   `sendSeq` is its index in the effect list), write a `success` response
   row, delete the processed `pendingMessages` row. The `messages` row for
   the processed message is kept.
6. **On `ctx.fail`** (sentinel thrown by the handler, caught by the wrapper):
   discard state mutations and the effect descriptor list (nothing was
   inserted, so nothing to roll back), write a `fail` response row, delete
   the processed `pendingMessages` row.
7. **On handler throw** (any non-`ctx.fail` exception, caught by the
   wrapper): the wrapper does **not** let the transaction roll back.
   Instead, it discards state mutations and the effect list, increments
   `pendingMessages.attempts`, and commits. If the new `attempts` value is
   `>= 3`, the same transaction also writes a `defect` response row and
   deletes the processed `pendingMessages` row. Drain continues.

   Convex OCC read/write-conflict retries surface as a distinct exception
   type that the wrapper does **not** catch — those bubble up so Convex
   retries the whole mutation, and they do not increment `attempts`.
8. Reschedule drain based on remaining work. Step 8 does **not** bump
   `generation` — the next run will bump on entry at step 1. Schedule
   with the current `state.generation`:
   - another row with `deliverAt <= now()`:
     `runAfter(0, drain, { actorId, generation: state.generation })`,
     stay in `running`;
   - next row has future `deliverAt`:
     `runAfter(deliverAt - now(), drain, { actorId, generation: state.generation })`,
     transition `mailboxState` to `scheduled`;
   - no rows: transition `mailboxState` to `idle` (no schedule).

One message per transaction gives clean failure semantics, bounded
transaction size, and natural interleaving of replies and other messages.
Because handler-side effects are collected as data and applied only on
success, `ctx.fail` rolls back cleanly: nothing was ever inserted.

### Drain generation and recovery

Every `mailboxState` row carries a `generation: number`. Generation is a
fencing token: every scheduled `drain({ actorId, generation })` carries
the value of `state.generation` at its scheduling instant, and the
drain's first action is to compare `args.generation` against
`state.generation`. A mismatch means this invocation has been superseded
— older scheduled invocations, double-deliveries, and zombie resumes are
guaranteed no-ops.

**Generation is owned by the drain.** It is bumped in exactly two
places:

1. **Top of the drain mutation (step 1).** On successful fence check, the
   drain bumps `state.generation` by one as part of transitioning to
   `running`. This is the fence: any other scheduled drain racing this
   one now carries a stale arg and will exit on its own step 1.
2. **Recovery cron.** See below. Recovery bumps because it is acting in
   lieu of a drain that never got the chance to bump for itself.

**Kick does not write `generation`.** Neither the `idle → scheduled`
path nor the bring-forward cancel-and-reschedule path touches the
counter. Both schedule with the current `state.generation` value. Safety
of the bring-forward path comes from two facts:

- `ctx.scheduler.cancel` is called first as a best-effort cleanup. If
  the old scheduled row is still `pending`, cancel removes it and there
  is no race.
- If cancel lost the race (the scheduled drain has already started
  running, or already fired and committed), then either:
  - It already committed, which means it already bumped to `N+1`. Our
    newly scheduled drain still carries `N`, so it will exit on its
    step 1 fence — correct.
  - It is still running concurrently. Both this transaction and the
    in-flight drain contend on `mailboxState`; Convex serializes them.
    Whichever commits first bumps to `N+1`. The loser retries under
    OCC, re-reads state, and on retry its fence check fails — it exits.
    Only one drain run actually mutates per scheduled pair.

**Step 8 self-reschedule does not bump either.** The drain's tail
schedules its follow-up with the same `state.generation` value it just
wrote at step 1. The follow-up run will bump on its own entry. This
collapses the three write sites that earlier drafts of the spec
described into one, matching the workpool reference implementation
(`.context/workpool/src/component/loop.ts`).

**Recovery cron.** A cron (default: every 5 minutes) scans `mailboxState`
for rows in `running` whose `startedAt` is older than a threshold (default:
5 minutes, well above any realistic single-message drain). For each, it
bumps `generation` and schedules a fresh `drain` at `now`. Two things
can happen:

- **Drain actually died** (process crash, timeout, uncaught framework
  bug). The new run takes over cleanly.
- **Drain is still alive** (stuck on a truly long handler, or the
  threshold was set too low). Its commit will contend on `mailboxState`
  with the recovery write; whichever commits second sees an OCC conflict
  and retries, and on retry the drain's generation no longer matches and
  it exits. The recovery run proceeds. The in-flight message's
  `pendingMessages.attempts` was never incremented (the drain never
  committed), so the next run retries it from scratch — idempotent.

Recovery is safe because a live drain's state writes all flow through the
same `mailboxState` row, so any recovery that races a live drain is
serialized by OCC and at most one of them can commit. Without generation,
recovery would have no way to distinguish "drain crashed" from "drain
running fine, just slow" and would risk double-processing a message.

Threshold tuning is operator-facing: the default 5 minutes is comfortable
for typical handlers, but a deployment with known-long handlers should
either raise the threshold or split those handlers into scheduled
self-sends. The threshold is **not** a handler deadline — it is the
"assume dead" cutoff for recovery.

### Per-actor throughput ceiling

Sequential drain caps a single actor at roughly 20-100 messages/sec,
bounded by mutation round-trip time. Cross-actor throughput is unconstrained
by this — distinct actors drain in parallel. If a single "logical actor"
needs more throughput, batch processing of messages in a transaction may be needed. If global scheduler throughput becomes an issue, we may need to shard actor handler loops.

## Data model

```ts
// Component schema (sketch)

actor: defineTable({
  actorType: v.string(),
  name: v.string(),
  state: v.any(), // validated by defineActor's state validator
}).index('by_type_name', ['actorType', 'name'])

mailboxState: defineTable({
  actorId: v.id('actor'),
  // Monotonic generation: bumped at the top of every drain run and by
  // recovery. Kick reads and re-passes it unchanged. The drain mutation
  // takes generation as an arg and bails if it no longer matches.
  // See "Drain generation and recovery".
  generation: v.number(),
  drain: v.union(
    v.object({ kind: v.literal('idle') }),
    v.object({
      kind: v.literal('scheduled'),
      scheduledId: v.id('_scheduled_functions'),
      at: v.number(),
    }),
    v.object({ kind: v.literal('running'), startedAt: v.number() }),
  ),
}).index('by_actor', ['actorId'])
// Recovery scans all mailboxState rows (one per ever-used actor — bounded
// and small in practice). If this grows unwieldy, lift a top-level
// `drainKind` field and index it.

// Permanent record of every message ever sent. Never deleted by the drain.
// No by_actor_deliverable index — not on the hot path.
// In future, may need TTL if this gets unwieldy
messages: defineTable({
  actorId: v.id('actor'),
  actorType: v.string(),
  msgType: v.string(),
  payload: v.any(),
  deliverAt: v.number(), // ms since epoch, for historical reference
  sentAt: v.number(),
}).index('by_actor', ['actorId'])

// The drain work queue. Inserted at send time, deleted on process.
// Hot index lives here, not on `messages`, so the drain scan stays lean.
pendingMessages: defineTable({
  messageId: v.id('messages'),
  actorId: v.id('actor'),
  deliverAt: v.number(),
  // Handler-local tiebreaker: 0..N-1 across the sender handler's effect
  // list. Only needed to disambiguate multiple sends from one transaction
  // to the same target at the same deliverAt. See "Send ordering".
  sendSeq: v.number(),
  attempts: v.number(),
}).index('by_actor_deliverable', ['actorId', 'deliverAt', 'sendSeq'])

// Outcome row per processed message. Always written.
// In future, may need TTL if this gets unwieldy
responses: defineTable({
  messageId: v.id('messages'), // always resolvable — messages are never deleted
  actorId: v.id('actor'),
  actorType: v.string(),
  msgType: v.string(),
  response: v.union(
    v.object({ kind: v.literal('success'), value: v.any() }),
    v.object({
      kind: v.literal('fail'),
      reason: v.string(),
      details: v.optional(v.any()),
    }),
    v.object({
      kind: v.literal('defect'),
      error: v.string(),
      attempts: v.number(),
    }),
  ),
  retainUntil: v.optional(v.number()), // TTL; null = no TTL (defects)
})
  .index('by_message', ['messageId'])
  .index('by_actor', ['actorId'])
```

- `sendSeq` is the tiebreaker for messages with identical `deliverAt`
  that originate from the **same** transaction (see "Send ordering"
  below). Cross-transaction ordering is handled by Convex's implicit
  `_creationTime` tail on the index.
- On first send to a never-seen `(actorType, name)`, `mailboxState` is
  inserted with `{ generation: 0, drain: { kind: 'idle' } }` in the same
  transaction that creates the `actor` row and enqueues the first
  message. The first kick schedules the drain carrying `generation: 0`;
  the drain bumps generation to 1 on its first run (step 1).
- No separate payload table — 1MB doc limit is documented as a message size cap.
- No `from` field — sender info goes in payload if needed.
- **`messages` is append-only.** Every send writes one row; the drain never
  deletes from it. This makes it a complete historical record, and lets
  response rows reference messages by id without worrying about dangling
  references.
- **`pendingMessages` is the work queue.** Drain reads and deletes from here.
  The hot `by_actor_deliverable` index lives on this table, so drain scans
  only see undelivered work regardless of total history size.
- **Every processed message gets a response row**, always. There is no
  `retainResponse` opt-in. Retention is a response-table policy: success
  responses default to a 1-hour TTL, defects have no TTL, fail responses
  default to a 1-hour TTL. Cron-based cleanup prunes expired rows.
- **Write amplification:** two inserts per send (one each to `messages` and
  `pendingMessages`). This is the price of permanent history + lean drain
  index. Acceptable for MVP; batching can amortize it later if needed.

### Send ordering

The goal is **per-sender FIFO** into a target actor's mailbox: if A's
code causally issues two sends to B, the first must be processed by B
before the second. We do **not** offer a total order across unrelated
senders. The reason is not that the storage layer is non-deterministic
— it isn't, see "Cross-sender ordering" below — but that the
underlying timing the storage layer keys on is determined by Convex's
transaction scheduling, which the application has no visibility into.
Don't rely on cross-sender ordering even when it appears stable.

The drain index is `[actorId, deliverAt, sendSeq]`, with Convex's
implicit `_creationTime` appended as a final tail.

**What each component handles:**

- `deliverAt` is the primary sort key — scheduled messages step out of
  line and rejoin at their delivery time.
- `_creationTime` (implicit) handles cross-transaction ties. Two
  different transactions inserting rows with the same `deliverAt` have
  different `_creationTime`, so the earlier committer comes first.
  Multiple sequential transactions from the same sender (e.g., A
  processes msg X, sends to B; next drain processes msg Y, sends to B)
  land in the correct order without any sender-owned field.
- `sendSeq` (explicit, handler-local) handles the one case
  `_creationTime` cannot: multiple sends emitted from a **single**
  handler invocation with the same `deliverAt`. All those rows share
  the same `_creationTime` (they're in the same transaction), so
  `_creationTime` is no longer a discriminator. Convex would still
  return them in *some* deterministic order — but that order falls
  back to internal sort criteria like `_id`, not to the order the
  handler emitted the sends. So `stub.send(B, 'debit')` followed by
  `stub.send(B, 'credit')` could come out in either order. `sendSeq`
  is set to the effect's index in the handler's effect list
  (`0`, `1`, `2`, ...), forcing the index to return them in
  handler-emission order.

That is the whole story. `sendSeq` is not a counter on any actor, is
never read by anyone except the index scan, and resets to `0` every
handler invocation. Nothing is written to any row owned by the target
actor beyond the `messages` + `pendingMessages` inserts themselves.

**Cross-sender ordering (what we do not promise).**

If two unrelated senders A and C both send to B with the same
`deliverAt`, the drain processes them in `_creationTime` order — which
is determined by Convex's transaction scheduling. At the storage layer
this ordering is **deterministic and stable**: a re-query of the same
committed data will return the same order. (Per the [Convex indexes
docs](https://docs.convex.dev/database/reading-data/indexes/): "The
`_creationTime` field is automatically added to the end of every index
to ensure a stable ordering.")

But the `_creationTime` values themselves depend on which transaction
the Convex backend happened to start first, which is sensitive to
network arrival order, OCC retries, backend load, and other things the
application has no visibility into. So from an application-level
perspective the order between unrelated senders is **unpredictable,
even though it's deterministic once committed**. A test that fires "the
same" two sends in two separate runs may see them land in opposite
orders across runs — not because the index is non-deterministic, but
because the transaction scheduling that produced the `_creationTime`
values came out different.

The reason this is acceptable: A and C have no shared timeline. If they
needed a particular order, they would have to coordinate via B (or some
shared point), and that coordination would naturally push their
`deliverAt`s apart, eliminating the tie.

**What this does not guarantee** (and by design):

- Batches from one transaction are not kept contiguous in the queue. If
  tx1 emits two sends to B and tx2 emits one send to B, all at the same
  `deliverAt`, processing order may be `tx1.msg1, tx2.msg1, tx1.msg2`
  (tx1 and tx2 have distinct `_creationTime`, but sendSeq orders
  `(T, 0, tx1)` and `(T, 0, tx2)` before `(T, 1, tx1)`). This is fine:
  tx1's per-sender FIFO is preserved, and tx2 has no causal ordering
  with tx1 to violate. If a user needs multi-message atomicity, they
  should collapse the batch into a single message.

## Defining actors

Actors are declared with `defineActor`, which takes Convex validators for
state and each message's payload. Validators drive both runtime validation
(reject bad payloads on enqueue) and static type inference via `Infer<>`. The
peek projection is inferred from its return type and does not require a
validator.

```ts
import { v } from 'convex/values'
import { defineActor } from 'convex-actors/client'

export const chatRoom = defineActor({
  type: 'chatRoom',

  state: v.object({
    members: v.array(v.string()),
    messages: v.array(v.object({ from: v.string(), text: v.string() })),
    lastActivity: v.number(),
  }),

  messages: {
    join: v.object({ user: v.string() }),
    leave: v.object({ user: v.string() }),
    post: v.object({ from: v.string(), text: v.string() }),
  },

  initialState: () => ({ members: [], messages: [], lastActivity: 0 }),

  project: (state) => ({
    memberCount: state.members.length,
    isActive: Date.now() - state.lastActivity < 60_000,
  }),

  handle: {
    join: async (state, { user }, ctx) => {
      state.members.push(user)
      state.lastActivity = ctx.now()
    },
    leave: async (state, { user }) => {
      state.members = state.members.filter((m) => m !== user)
    },
    post: async (state, { from, text }, ctx) => {
      state.messages.push({ from, text })
      state.lastActivity = ctx.now()
    },
  },
})
```

The `project` function is the actor's **public surface**: private state by
default, only the projection is observable via `peek`. Actors without a
`project` function cannot be peeked (peek returns `null`). `project` must be
pure `(state) => view` — no ctx, no I/O, no `Date.now()` (use a `lastActivity`
field on state instead).

**Definition-level semantics:**

- `initialState()` runs on the first send to a never-seen `(type, name)`.
  Its return value is validated against the `state` validator before being
  inserted; a bad `initialState` throws on first send and is surfaced as a
  defect response.
- Handlers are wrapped in Immer's async-capable `produce`. `await` between
  draft mutations is supported; users should not retain references to the
  draft across awaits. Return values are snapshotted through Immer's
  structural-sharing path.
- Payload validators run at **enqueue** time (in the app-level `send`
  wrapper, before the component insert), not at drain time. A bad payload
  never reaches the `messages` table.

**Terminology:** the `type` field on `defineActor` is the actor **type**; the
instance identifier is called **name** and is supplied at send time. Both
together are the address `(type, name)`.

## Container and drain

Actor definitions are registered into an `ActorSystem` container in app
code. The system exposes a bundle of app-level functions that the user
re-exports once. These wrappers are the real public API — the underlying
component exposes only primitive operations.

```ts
// convex/actors.ts
import { ActorSystem } from 'convex-actors/client'
import { components } from './_generated/api'
import { chatRoom } from './chatRoom'
import { counter } from './counter'

export const system = new ActorSystem(components.actors, { chatRoom, counter })

// App-level public API. These MUST live in app code (not the component)
// because project functions and payload validators are user TS.
export const peek = system.peek               // query
export const send = system.send               // mutation
export const getResponse = system.getResponse // query
export const drain = system.drain             // internalMutation
```

### Why the split

`project` functions and payload validators live in the app's TS source and
cannot be serialized into the component. Anything that needs to *run* them
must therefore be an app-level function. Queries/mutations inside the
component can only manipulate rows.

Responsibilities land as:

| Layer     | Knows about            | Functions                                              |
| --------- | ---------------------- | ------------------------------------------------------ |
| Component | row shapes, queue mechanics | `getActorRow`, `enqueueMessage`, `getResponseRow`, and other row-level primitives the app's `drain` calls into |
| App       | definitions, project, validators, types | `peek`, `send`, `getResponse`, `drain` |

- `peek(actorType, name)`: calls `component.getActorRow`, runs the matching
  definition's `project` in-process, returns the projection.
- `send(actorType, name, msgType, payload, opts?)`: validates `payload`
  against the definition's validator, calls `component.enqueueMessage`,
  returns the resulting `Id<"messages">`.
- `getResponse(messageId)`: thin pass-through to `component.getResponseRow`.
- `drain`: the per-actor drain `internalMutation`. Invoked only by the
  scheduler. It is app code (so it can call user handlers and `project`),
  and its row-level I/O — state reads, effect applies, response writes,
  `mailboxState` transitions — goes through component mutations executed
  via `ctx.runMutation(component.*)`.

Scheduled drain runs reference `drain` by its app-level function handle,
not a component-internal one.

## Handler ctx

The `actor` ctx parameter exposes a narrow surface:

```ts
interface ActorCtx<SelfDef> {
  // identity / time
  self(): { type: string; name: string }
  now(): number

  // cross-actor stubs (typed against the target's definition)
  stub<D extends AnyActorDef>(def: D, name: string): Stub<D>

  // self-send, optionally scheduled
  sendSelf<M extends keyof SelfDef['handle']>(
    msgType: M,
    payload: PayloadOf<SelfDef, M>,
    opts?: { after?: number; at?: number },
  ): void

  // domain failure — throws a sentinel caught by the wrapper
  fail(reason: string, details?: unknown): never
}

interface Stub<D extends AnyActorDef> {
  peek(): Promise<ProjectionOf<D> | null>
  send<M extends keyof D['handle']>(
    msgType: M,
    payload: PayloadOf<D, M>,
    opts?: { after?: number; at?: number },
  ): void
}
```

- **`ctx.now()`** returns the drain transaction's start time in ms. It is
  stable across OCC retries of the same logical drain — handlers that
  branch on `now()` see the same value on every retry of a given message,
  which keeps behavior deterministic under OCC.
- **`opts: { after?, at? }`** semantics:
  - `at` is an absolute ms timestamp; `after` is a ms offset from
    `ctx.now()`.
  - If both are provided, `at` wins and `after` is ignored.
  - If neither is provided, `deliverAt = ctx.now()` (immediate).
  - A computed `deliverAt` in the past is clamped to `ctx.now()` — it is
    not an error, and it does not jump the queue ahead of other
    already-pending messages (tiebreaker is `sendSeq`).
- **Handlers do not know the `messageId` of the message they are
  processing.** The drain wrapper does not expose it, by design: MVP has no
  `ask`/`reply`, so a stable self-id is not needed, and withholding it
  prevents users from building correlation schemes that would constrain
  v2's replay-style handlers. If this bites, a `ctx.messageId()` accessor
  is additive.
- **`stub.send(...)` from inside a handler returns `void`.** It pushes an
  effect descriptor onto a private list on `ctx`; the wrapper applies the
  descriptors as real DB inserts after the handler returns successfully,
  stamping each row's `sendSeq` with its index in the effect list (see
  "Send ordering"). The wrapper never writes to any row owned by a target
  actor other than the two rows it inserts. This is what gives
  `ctx.fail()` clean rollback semantics: if the handler fails, the effect
  list is discarded and nothing was ever written. Client-to-actor sends
  go through the app-level `send` mutation directly and DO return the
  real Convex message id, because there's no handler wrapper in that
  path.
- `stub.peek(...)` is a transactional read of the target actor's projection.
  Since it's in the same transaction as the caller's drain, it's strongly
  consistent with any state the caller has already committed.
- `ctx.fail(reason, details?)` throws a private `FailSentinel` caught by the
  drain wrapper. State mutations and queued effects are discarded; a `fail`
  response is written; the `pendingMessages` row is deleted; drain continues.
- No `ask`, no `reply`, no `spawn`, no `stop`, no `setState`.
- If handlers later need to track the id of a message they sent (e.g. to
  correlate a future reply), we can add a synthetic id scheme — a UUID
  generated in `stub.send` and stored on the `messages` row — without
  changing the public API. Deferred until a real use case emerges.

## Three outcomes

| Outcome            | Mechanism     | State     | pendingMessages             | Attempts        | Response written |
| ------------------ | ------------- | --------- | --------------------------- | --------------- | ---------------- |
| **Success**        | normal return | committed | deleted                     | —               | `success`        |
| **Domain failure** | `ctx.fail()`  | discarded | deleted                     | not incremented | `fail`           |
| **Defect**         | handler throw | discarded | incremented; deleted on 3rd | incremented     | `defect` on 3rd  |

- The `messages` row is **never** deleted by the drain. It's the permanent
  historical record. Only the `pendingMessages` row is removed on process.
- Handler throws are caught by the drain wrapper and committed as an
  attempts bump on `pendingMessages` — the transaction does **not** roll
  back. Convex OCC read/write conflicts bubble past the wrapper, trigger
  Convex's automatic retry, and do **not** count toward `attempts`.
- **Every processed message gets a response row**, always. Retention is a
  table-level policy:
  - `success` responses: default 1-hour TTL.
  - `fail` responses: default 1-hour TTL.
  - `defect` responses: no TTL (operator/debug signal).
- A periodic cron prunes responses past their `retainUntil`. The `messages`
  table is not pruned by the framework — future work may add a per-actor
  TTL or compaction helper.
- **Late-subscriber race.** `useActorRequest` subscribes to `getResponse`
  *after* `send` resolves. If the drain finishes and the 1-hour TTL prunes
  the row before the subscription registers, the hook will observe `null`
  indefinitely. 1 hour is comfortably larger than realistic network + tab
  sleep windows, but operators should bump the TTL if long-lived background
  tabs are a target use case.
- Because every response references the permanent `messages` row, the
  response is a self-contained outcome record: follow `messageId` to recover
  the original payload, msgType, deliverAt, and sent timestamp.

## Client API

React client mirrors the stub pattern. Types are imported type-only from the
convex file so the client gets full fidelity without server runtime.

```ts
// src/actors.ts (client)
import type { system } from '../convex/actors'
import { createActorClient } from 'convex-actors/react'
import { api } from '../convex/_generated/api'

export const actors = createActorClient<typeof system>(api.actors)
```

Three hooks:

```ts
function Room({ roomName }: { roomName: string }) {
  const room = actors.stub("chatRoom", roomName)  // typed

  // Reactive read of the projection
  const view = useActorPeek(room)
  // view: { memberCount: number; isActive: boolean } | undefined

  // Fire-and-forget send; returns a typed sender
  const send = useActorSend(room)
  // send("join", { user: "alice" }) → Promise<MsgId>

  // Send with reactive response subscription (client-side "ask")
  const withdraw = useActorRequest(actors.stub("account", "me"), "withdraw")
  // withdraw.status: "idle" | "pending" | "success" | "fail" | "defect"
  // withdraw.data: typed success value when status === "success"
  // withdraw.error: { reason, details } when status === "fail"

  return (
    <div>
      <span>{view?.memberCount ?? "…"}</span>
      <button onClick={() => send("join", { user: "alice" })}>join</button>
      <button onClick={() => withdraw.call({ amount: 5 })}>withdraw</button>
      {withdraw.status === "success" && <p>New: {withdraw.data.newBalance}</p>}
      {withdraw.status === "fail" && <p>Nope: {withdraw.error.reason}</p>}
    </div>
  )
}
```

Under the hood, `useActorRequest` does:

1. `send(...)` → receives `messageId` (the real Convex id from the permanent
   `messages` table).
2. Stashes `messageId` in React state.
3. Subscribes to `useQuery(api.actors.getResponse, { messageId })`.
4. Exposes `status` / `data` / `error` derived from the row.

Because every processed message gets a response row unconditionally, there
is no opt-in flag at the send site — the hook just subscribes and waits.

No new component primitives required. Client-initiated request/response is
built entirely on existing send + response table + reactive query.

### App-level public API

These are the functions `createActorClient` binds against. They are defined
in app code (see "Container and drain") because they need access to
`project` and the payload validators, which cannot live inside the component.

- `query peek({ actorType, name })` → projection or `null`
- `mutation send({ actorType, name, msgType, payload, at?, after? })` → `Id<"messages">`
- `query getResponse({ messageId })` → `Response | null`

The underlying component exposes only row-level primitives
(`getActorRow`, `enqueueMessage`, `getResponseRow`, and the internal drain
mutation). Clients never call the component directly.

## Peek semantics

- Private by default. If a definition does not include `project`, peek returns
  `null`.
- The projection is a pure `(state) => view` function. No ctx, no DB access,
  no asker identity.
- Lazily computed on each peek. Can be cached on the actor row later as an
  optimization without API changes.
- Peek is a read-only operation. Cross-actor state **writes** are only
  allowed via message passing — there is no `modify` primitive. Peek exists
  because reads do not violate actor encapsulation the way writes would,
  and because Convex's transactional store lets us offer strong-consistency
  cross-actor reads for free.

## Failure and retries

- **OCC retries** (Convex auto-retry on read/write conflict) are transparent
  and do not count toward `pendingMessages.attempts`. They are a distinct
  exception type from handler throws and the wrapper lets them bubble.
- **Handler throws** are **caught** by the drain wrapper; the transaction is
  not rolled back. The wrapper discards state mutations + effects, commits
  an `attempts++` on the `pendingMessages` row, and continues. On the 3rd
  throw the same transaction also writes a `defect` response row and
  deletes the `pendingMessages` row. The permanent `messages` row remains
  for debugging.
- **Domain failures** via `ctx.fail()` never retry and never dead-letter.
  They produce a `fail` response row and the `pendingMessages` row is deleted.
- **Actors never block.** There is no pause, no stop, no poison-message
  deadlock.

## Open questions / future work

- **`ask` via replay-style async handlers.** Planned for v2. Requires
  append-only call history per in-flight message, a replay-aware ctx wrapper,
  and determinism enforcement (free from Convex's mutation sandbox). The
  responses table is already the continuation store, so no schema changes
  needed — this is a strictly additive feature.
- **Id-based addressing.** Internal row ids exist but are not exposed. Can be
  added to `ctx.stub(def, { id })` later without breaking the name-based API.
- **Batch drain.** A `drainBatch: N` config per actor to amortize per-mutation
  overhead for hot actors. Trade-off: handler throw rolls back the batch and
  retries idempotently. Additive.
- **Reply from dead letters.** A mutation to re-enqueue a defect response's
  original message. Useful for post-fix recovery. Additive.
- **Observability helpers.** Reactive queries over the responses table for
  "dead letters in the last hour" / "active actors by message rate" /
  per-actor health dashboards. Additive.
- **`ctx.log()` / telemetry hook.** For structured audit trails without
  polluting user state. Additive.
- **Framework-level auth.** Users wrap `send` in their own mutations that
  check `ctx.auth` for MVP. A declarative `authorize` hook on `defineActor`
  could be added if patterns stabilize.
- **Per-actor function handles.** Currently the container uses a single
  `drain` fnHandle for all actor types. We may later generate per-actor
  fnHandles for dashboard visibility and per-type configuration. Transparent
  to users.
- **Large payloads.** 1MB doc cap per message. If this bites, we can copy
  workpool's pattern of extracting payloads >8KB to a separate table.
- **State schema migration.** Changing a definition's `state` validator
  will reject existing rows at read-validation time. MVP has no migration
  tooling; users either design schemas defensively (optional fields,
  unions) or ship a one-off migration mutation. A framework-level
  `migrateState` hook is additive.
- **Actor lifecycle and growth.** Actors exist forever once created.
  `actor`, `messages`, and `responses` (for defects) grow without bound.
  MVP does not provide delete/archive. Plausible additions: an explicit
  `deleteActor` that tombstones the row and prunes its mailbox, a
  per-actor-type `messages` TTL, or a compaction helper that drops
  `messages` rows whose responses have already expired.
- **Global scheduler pressure.** The `_scheduled_functions` table absorbs
  one drain entry per active actor. A hot system with many distinct actors
  can push scheduler throughput before it pushes any individual actor's
  ceiling. No MVP mitigation; shard or batch if observed.
## Constraint recap (what's firm)

- Actors are virtual, addressed by `(type, name)`, lazy-created on first
  send.
- Flat model — no supervision, no parent-child, no lifecycle primitives.
- One message per drain transaction. Per-actor FIFO among deliverable
  messages.
- Per-actor drain loop coordinated by a `mailboxState` row (which also
  holds `generation`). At most one *effective* drain at a time, enforced
  by a generation check at the top of `drain`: the drain bumps
  generation on entry (and recovery bumps it when resurrecting a stale
  `running` mailbox), so any racing or zombie run exits on its fence
  check. Kick calls `ctx.scheduler.cancel` as a best-effort cleanup on
  the bring-forward path but never writes generation.
- Recovery cron periodically sweeps `running` mailboxes older than a
  threshold and reschedules them; any zombie or still-live drain is
  harmlessly invalidated by the generation bump.
- FIFO tiebreaker within equal `deliverAt` is `sendSeq` (a handler-local
  counter, 0..N-1 per sender transaction). Cross-transaction ordering
  falls through to Convex's implicit `_creationTime` index tail. No
  writes to any row owned by the target actor.
- State validated by Convex `v.object(...)`, mutated via Immer draft.
  `initialState()` is validated against the same validator on first send.
- Message payloads validated by Convex validators at **enqueue time** in
  the app-level `send` wrapper; types inferred via `Infer<>`. Peek
  projection inferred from function return type.
- Handler return value is the success response. Handlers do not know the
  `messageId` they are processing.
- `ctx.fail(reason, details?)` is the domain-failure primitive.
- Handler throws are caught by the drain wrapper and committed as an
  attempts bump; on the 3rd throw a `defect` response is written in the
  same transaction. OCC conflicts are a separate path and do not count.
- Two-table queue split: `messages` is the permanent append-only record;
  `pendingMessages` is the lean work queue with the hot index. Drain reads
  from `pendingMessages` and never deletes from `messages`.
- `responses` table is the unified outcome store; subsumes dead letters and
  domain failure records. Every processed message gets a response row (no
  opt-in). Responses reference `messages` by id — no payload duplication.
- Handler-side `stub.send(...)` uses effects-as-data: descriptors are
  queued on `ctx`, applied as `messages` + `pendingMessages` inserts
  after the handler returns successfully. The wrapper never writes any
  row owned by a target actor beyond the inserts themselves — in
  particular, there is no counter on the target's mailbox. `ctx.fail()`
  discards the queue; nothing was written, nothing to roll back.
  Client-side sends go through the app-level `send` mutation directly
  and return real message ids.
- Public API (`peek`, `send`, `getResponse`) lives in **app** code, not the
  component, because it needs the definition registry. The component
  exposes only row-level primitives.
- `peek` is read-only, private by default, pure `(state) => view`.
- No `ask`, `reply`, `spawn`, `stop`, `modify`, or `setState` in MVP.
- Client API: `actors.stub(type, name)` + `useActorPeek` / `useActorSend` /
  `useActorRequest`.
