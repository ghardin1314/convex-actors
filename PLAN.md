# Convex Actors — Implementation Plan

Breakdown of SPEC.md into independently testable steps. Modeled on the
workpool component layout (`.context/workpool/src`): one file per
concern, one `*.test.ts` per file, tests exercise exported handlers
directly against `convexTest` with fake timers.

## How to use this document

Every step has a **Status** line and a **Notes** block. Update as you
go.

**Status values** (pick one, keep the literal string so it greps):

- `todo` — not started
- `in-progress` — actively being worked on
- `blocked` — waiting on something (say what in Notes)
- `done` — code merged + tests green

**Notes block** — free-form log for the implementer. Record surprises,
deviations from the plan, decisions made, links to PRs/commits,
anything future-you will want. Prepend new entries with a date stamp
`YYYY-MM-DD:` so the history reads top-down.

## Progress summary

Tick these as phases complete. Each phase is done only when all of its
steps are `done`.

- [ ] Phase 0 — Scaffolding
- [ ] Phase 1 — Data model
- [ ] Phase 2 — Send path
- [ ] Phase 3 — App-level container and definitions
- [ ] Phase 4 — Handler ctx and drain
- [ ] Phase 5 — Recovery
- [ ] Phase 6 — Response retention
- [ ] Phase 7 — Client API
- [ ] Phase 8 — Integration smoke tests

## Layout

Component already scaffolded at `convex/components/actors/` with
`convex.config.ts` + `_generated/`. App-level code lives in `convex/`.
React client lives in `src/`.

```
convex/
  convex.config.ts                # already wires components.actors
  components/actors/              # Convex component — row-level primitives only
    convex.config.ts              # already exists (defineComponent("actors"))
    schema.ts                     # NEW
    shared.ts                     # validators, constants, time helpers
    logging.ts                    # (copy from workpool; optional for MVP)
    actors.ts                     # getActorRow, initActor row-level ops
    enqueue.ts                    # enqueueMessage mutation (messages + pendingMessages + initial mailbox)
    kick.ts                       # kickMailbox — idle/scheduled/running transitions, generation bump
    drainOps.ts                   # row-level primitives the app-drain calls via runMutation
    recovery.ts                   # recovery scan handler
    crons.ts                      # recovery cron + response TTL cron
    responses.ts                  # getResponseRow, prune cron handler
    schema.test.ts                # (setup-only sanity)
    enqueue.test.ts
    kick.test.ts
    drainOps.test.ts
    recovery.test.ts
    responses.test.ts
    test.ts                       # register() helper, like workpool's src/test.ts
  actors/                         # NEW — app-level container + definitions
    system.ts                     # ActorSystem, re-exports peek/send/getResponse/drain
    defineActor.ts                # defineActor + types
    ctx.ts                        # ActorCtx + Stub implementation (effect-list collector)
    drain.ts                      # drain internalMutation factory
    send.ts                       # send mutation factory
    peek.ts                       # peek query factory
    response.ts                   # getResponse query factory
    defineActor.test.ts
    ctx.test.ts
    drain.test.ts
    send.test.ts
src/
  actors/                         # React client (thin)
    index.ts                      # createActorClient, useActorPeek, useActorSend, useActorRequest
```

Note: the component-internal import paths follow the workpool
convention (`./_generated/server.js`, etc.), so test files and handler
modules sit alongside `_generated/` inside `convex/components/actors/`.

Tests follow workpool's pattern: `convexTest(schema, modules)`,
`t.run(async ctx => ...)` for direct DB assertions, `vi.useFakeTimers()`
to control `Date.now()` deterministically, exported handlers called
directly (not through api references) where possible so tests can
inspect intermediate state.

---

## Phase 0 — Scaffolding

### Step 0.1 — Component skeleton

**Status:** `done`

**Notes:**
> 2026-04-08: scaffolded `convex/components/actors/{schema,test,setup.test}.ts`.
> `schema.ts` is an empty `defineSchema({})` placeholder. `test.ts` mirrors
> workpool's `register()` helper but globs `./**/*.ts` relative to the
> component dir (since tests/handlers live alongside `_generated/` here,
> not in a separate `component/` subfolder). `setup.test.ts` boots
> `convexTest(schema, modules)` inside `t.run` — passes.
> Installed `convex-test`, `vitest`, `immer`, `@edge-runtime/vm` as dev deps.
> Added `vitest.config.ts` at repo root with `environment: "edge-runtime"`
> and excluded `.context/**` so workpool's vendored tests don't run.
> Added `test` / `test:watch` scripts to `package.json`. `pnpm test` →
> 1 file / 1 test passing.

- Component already exists at `convex/components/actors/` with
  `convex.config.ts` + `_generated/`. App-level `convex/convex.config.ts`
  already registers it.
- Add empty `convex/components/actors/schema.ts` exporting
  `defineSchema({})` placeholder so `_generated` picks it up.
- Add `convex-test`, `vitest`, `immer` deps. Add `vitest.config.ts` at
  repo root.
- Add `convex/components/actors/test.ts` with a `register()` helper
  mirroring `.context/workpool/src/test.ts`.
- **Test:** `setup.test.ts` in the component dir — `convexTest(schema, modules)`
  boots without error.

### Step 0.2 — Shared module

**Status:** `done`

**Notes:**
> 2026-04-08: Added `convex/components/actors/shared.ts` with time
> constants (`SECOND`/`MINUTE`/`HOUR`/`DAY`), tunables
> (`RECOVERY_THRESHOLD_MS`, `RECOVERY_PERIOD_MS = 5*MINUTE`,
> `MAX_ATTEMPTS = 3`), `RESPONSE_TTL_MS = { success: 1h, fail: 1h,
> defect: undefined }`, a `now()` wrapper, and validators `vAddress`,
> `vMailboxDrainState`, `vResponse` with `Infer<>`-derived types.
> No runtime test — picked up by `setup.test.ts`'s module glob for
> import-side-effect typecheck.
> Skipped the `logging.ts` module for now (MVP can use `console.*`);
> flagged in open decision #5.

- `shared.ts`: constants (`RECOVERY_THRESHOLD_MS = 5 * MINUTE`,
  `RECOVERY_PERIOD_MS = 5 * MINUTE`, `MAX_ATTEMPTS = 3`, response TTLs),
  validators (`vResponse`, `vMailboxDrainState`, `vAddress`), helpers
  (`now()` wrapper for test injection if needed).
- **Test:** import + type check only. No runtime test needed.

---

## Phase 1 — Data model

### Step 1.1 — Schema

**Status:** `done`

**Notes:**
> 2026-04-08: Five tables landed in `schema.ts`. `mailboxState.drain` and
> `responses.response` reuse `vMailboxDrainState` / `vResponse` from
> `shared.ts`. Indexes: `actor.by_type_name`, `mailboxState.by_actor`,
> `messages.by_actor`, `pendingMessages.by_actor_deliverable =
> [actorId, deliverAt, sendSeq]`, `responses.by_message`,
> `responses.by_actor`.
> Dropped denormalized `actorType` from `messages` and `responses`, and
> `msgType` + `retainUntil` from `responses` — nothing in the drain path
> reads them, and `(actorType, name)` is immutable on the actor row so
> they can be re-added later behind an observability query without a
> migration risk. TTL lives only on the prune cron's read-time policy
> for now (revisit in Phase 6).
> No `schema.test.ts` — the originally-planned round-trip + index-order
> assertions were either duplicating TypeScript's job or testing
> platform behavior. Upcoming handler tests (`enqueue`, `kick`,
> `drainOps`) will exercise every table and index through real code
> paths and fail loudly on any schema mistake.

- Define tables from SPEC §Data model: `actor`, `mailboxState`,
  `messages`, `pendingMessages`, `responses`.
- Indexes: `actor.by_type_name`, `mailboxState.by_actor`,
  `messages.by_actor`, `pendingMessages.by_actor_deliverable`
  (`[actorId, deliverAt, sendSeq]`), `responses.by_message`,
  `responses.by_actor`.
- ~~**Test (`schema.test.ts`):** insert one row of each kind inside
  `t.run`, read back, assert round-trip.~~ Dropped — see Notes.

### Step 1.2 — Actor row primitives (`actors.ts`)

**Status:** `todo`

**Notes:**
> _none yet_

- `getActorRow(ctx, actorType, name)` — index lookup.
- `getOrCreateActorRow(ctx, { actorType, name, initialState })` —
  insert actor + sibling `mailboxState { generation: 0, drain: idle }`
  atomically. Idempotent on re-call (returns existing).
- **Test:** lazy-creates on first call; returns same id on second call;
  always creates paired `mailboxState`; `mailboxState.generation` starts
  at 0 and `drain.kind === "idle"`.

---

## Phase 2 — Send path (no drain yet)

### Step 2.1 — `enqueueMessage` mutation

**Status:** `todo`

**Notes:**
> _none yet_

- Args: `{ actorType, name, msgType, payload, deliverAt, effectList? }`.
  `effectList` for when this is called from inside a drain to apply an
  effect descriptor list atomically (see Step 4.3). Single-send path
  reuses the same code with a 1-element list.
- Behavior per SPEC §Data model:
  - Look up or create actor (Step 1.2).
  - Insert one `messages` row per effect, one `pendingMessages` row per
    effect with `sendSeq = index`.
- Returns array of `Id<"messages">`.
- Does **not** kick. Kick is a separate step so it can be tested
  independently.
- **Tests (`enqueue.test.ts`):**
  - First send to new `(type, name)` creates actor + mailbox + one
    message + one pending row.
  - Second send to same address reuses actor row.
  - Batch with N effects writes N `messages` + N `pendingMessages`
    rows with `sendSeq` = `0..N-1` in order.
  - `pendingMessages.attempts` starts at 0.
  - Index scan via `by_actor_deliverable` returns rows in
    `(deliverAt, sendSeq)` order.

### Step 2.2 — `kickMailbox` (the scheduling transition)

**Status:** `todo`

**Notes:**
> _none yet_

- Pure SPEC §Per-actor drain loop logic. Takes `(ctx, actorId, deliverAt)`.
- Transitions:
  - `idle` → bump generation, schedule `drain({ actorId, generation })`
    at `deliverAt`, write `scheduled { scheduledId, at }`.
  - `scheduled` with `at <= deliverAt` → no-op.
  - `scheduled` with `at > deliverAt` → best-effort `ctx.scheduler.cancel`
    (check `ctx.db.system.get(scheduledId).state === "pending"`), bump
    generation, reschedule, overwrite `scheduledId`.
  - `running` → no-op (no mailbox write).
- Scheduled target is passed in as a `FunctionHandle<"drain">` argument
  — the component doesn't know about the app-level `drain` function. We
  store the handle on the mailbox row at first-kick time (or pass it on
  every kick; prefer passing to avoid stale handles).
- **Tests (`kick.test.ts`):** mirrors `workpool/kick.test.ts` style.
  - idle → scheduled; generation incremented to 1; `scheduledId`
    populated; one row in `_scheduled_functions`.
  - scheduled with later `deliverAt` → unchanged, same `scheduledId`.
  - scheduled with earlier `deliverAt` → new `scheduledId`, generation
    bumped again, old `_scheduled_functions` row `canceled`.
  - running → no state write (assert `mailboxState` doc unchanged
    byte-for-byte).
  - Stale `scheduledId` (row already `success`/`canceled`) → cancel is
    skipped, reschedule still happens.
  - Concurrent kicks (run in parallel `t.run`s) — assert end state is
    consistent, matching workpool's "handles race conditions" test.

### Step 2.3 — `enqueueMessage` + kick wiring

**Status:** `todo`

**Notes:**
> _none yet_

- Once 2.1 and 2.2 pass independently, have `enqueueMessage` call
  `kickMailbox(actorId, earliestDeliverAt)` after inserts. Earliest is
  the min `deliverAt` across the effect batch.
- **Test:** send from cold state schedules a drain at the requested
  `deliverAt`; send #2 at a later time with drain already scheduled
  earlier is a no-op on scheduler.

---

## Phase 3 — App-level container and definitions

### Step 3.1 — `defineActor`

**Status:** `todo`

**Notes:**
> _none yet_

- Signature per SPEC §Defining actors. Inputs: `type`, `state`
  validator, `messages` record of payload validators, `initialState`,
  `project?`, `handle`.
- Returns a plain definition object (no side effects). Infer `Payload<M>`
  and `Projection` types via `Infer<>` and function return type.
- **Test (`defineActor.test.ts`):** type-level snapshot (exhaustive
  `expectTypeOf`) + runtime shape check. Validators callable.

### Step 3.2 — `ActorSystem` container

**Status:** `todo`

**Notes:**
> _none yet_

- `new ActorSystem(component, { [type]: definition })`.
- Stores definition map by type. Exposes factory methods:
  `peek`, `send`, `getResponse`, `drain` (each returns a registered
  Convex function bound to this system).
- Throws on unknown type at lookup time.
- **Test:** register two defs, retrieve by type, unknown type throws.

### Step 3.3 — `send` mutation factory

**Status:** `todo`

**Notes:**
> _none yet_

- Built by `system.send`. App-level `mutation({ args, handler })`.
- Handler:
  1. Look up definition by `actorType`; 404 if missing.
  2. Validate `payload` against `definition.messages[msgType]`.
  3. Compute `deliverAt` from `opts.at` / `opts.after` / default `now()`,
     clamp to now if past.
  4. `ctx.runMutation(component.enqueueMessage, {...})` — pass the
     app-level drain function handle here too.
  5. Return single `Id<"messages">`.
- **Tests (`send.test.ts`):**
  - Valid payload → message row + response row is absent (no drain yet
    in test, or drain runs — see Phase 4 tests).
  - Invalid payload shape → throws before any write (assert no rows in
    `messages`).
  - `at` + `after` both set → `at` wins.
  - `at` in past → clamped, still enqueued.

### Step 3.4 — `peek` query factory

**Status:** `todo`

**Notes:**
> _none yet_

- Resolves `(type, name)` → actor row via component query, runs
  `definition.project(state)` in-process, returns result.
- `null` if actor row missing OR definition lacks `project`.
- **Test:** peek on never-sent actor → null; peek after send+drain
  reflects committed state; peek on def without `project` → null.

### Step 3.5 — `getResponse` query factory

**Status:** `todo`

**Notes:**
> _none yet_

- Pass-through to component `getResponseRow(messageId)`.
- Returns `Response | null` matching SPEC §Three outcomes.
- **Test:** null before drain, success shape after drain, fail shape
  after `ctx.fail`, defect shape after 3 throws.

---

## Phase 4 — Handler ctx and drain

### Step 4.1 — Effect list + `Stub` + `ActorCtx` (`ctx.ts`)

**Status:** `todo`

**Notes:**
> _none yet_

- `createActorCtx({ self, system, now, effectList })`.
- `stub(def, name)`:
  - `peek()` → runs `component.getActorRow` + `def.project` in the same
    transaction.
  - `send(msgType, payload, opts?)` → validate payload, push
    `{ actorType, name, msgType, payload, deliverAt }` onto `effectList`.
    Returns `void`.
- `sendSelf(...)` → same, address is own.
- `fail(reason, details?)` → throws `FailSentinel`.
- `self()`, `now()` — simple accessors.
- **Tests (`ctx.test.ts`):**
  - `stub.send` pushes descriptor, does not write to DB (assert
    `messages` empty after handler simulation).
  - Multiple `stub.send` assign `sendSeq` only at apply time, not here
    (ctx stays pure data).
  - `ctx.fail` throws `FailSentinel` with reason/details.
  - `now()` stable across calls within same ctx.
  - Payload validation at enqueue push time, not at apply time
    (consistent with send mutation).

### Step 4.2 — Drain wrapper (`drain.ts`)

**Status:** `todo`

**Notes:**
> _none yet_

- `system.drain` returns an `internalMutation`:
  ```
  args: { actorId, generation }
  ```
- Handler per SPEC §Per-actor drain loop steps 1–8. Implemented as a
  straight-line function calling component primitives via
  `ctx.runMutation(component.drainOps.*)`:
  1. `loadMailboxAndCheckGeneration` — if mismatch, return.
     Else transition to `running`, return actor row + mailbox.
  2. `readNextPending(actorId)` — returns first deliverable row or null.
  3. If null: `transitionAfterDrain(actorId, { nextDeliverAt? })` and
     return.
  4. Attempts guard: if `pending.attempts >= MAX_ATTEMPTS`, treat as
     step-7 defect-commit path immediately.
  5. Load def, build ctx, invoke handler wrapped in Immer `produce` (use
     `produceWithPatches` or plain `produce` — plain is fine since we
     only need next state).
  6. **success branch:** `commitSuccess(ctx, { actorId, messageId, newState, effectList, response })`
     — single component mutation that writes state, applies effects
     (calls enqueue logic with `effectList`), writes `response` row,
     deletes `pending` row. Single transaction boundary.
  7. **FailSentinel branch:** `commitFail(ctx, { actorId, messageId, reason, details })`.
  8. **Other throw branch:** `commitDefectOrRetry(ctx, { pendingId, messageId, error })`
     — increments attempts; on ≥3, writes defect response + deletes
     pending.
  9. After commit, compute remaining-work transition: call
     `scheduleFollowup(ctx, actorId)` which reads next pending row, bumps
     generation, schedules the next drain (via `ctx.scheduler.runAfter`
     at app layer — drain is app-level so this works directly).
- OCC conflicts are NOT caught (they must bubble). Only `FailSentinel`
  and any other `Error` are caught.
- **Tests (`drain.test.ts`):** see §4.4.

### Step 4.3 — Component-level drain primitives (`drainOps.ts`)

**Status:** `todo`

**Notes:**
> _none yet_

Each is a small `internalMutation` with narrow args so drain.ts remains
free of direct schema writes from app code, but tests can still call
them directly.

- `loadAndStartRunning({ actorId, generation })` → returns
  `{ mailbox, actor } | { stale: true }`. Writes `running { startedAt }`
  on match.
- `readNextPending({ actorId })` → first row by index.
- `commitSuccess({ actorId, pendingId, newState, effects, response })` —
  patches state, inserts each effect (messages + pendingMessages with
  sendSeq = index), inserts response, deletes pending row. Also calls
  `kickMailbox` for **each distinct target actor** touched by effects.
- `commitFail({ actorId, pendingId, messageId, response })`.
- `commitDefectOrRetry({ pendingId, messageId, errorString, actorType, msgType })`
  — reads pending, increments attempts; on 3rd, writes defect response +
  deletes row; otherwise just patches attempts.
- `transitionAfterDrain({ actorId, generation })` — reads next pending
  (inside same tx as commits for OCC coverage); bumps generation;
  transitions mailbox to `scheduled {...}` / `idle`; returns new
  generation + follow-up `runAfter` delay so the app-drain can issue
  `ctx.scheduler.runAfter(...)` itself with the app-level function
  handle.

Each primitive has its own test cases in `drainOps.test.ts`:
- `commitSuccess` writes exactly the expected rows, leaves `messages`
  row intact, only deletes pending.
- `commitSuccess` applies multiple effects with correct sendSeq.
- `commitSuccess` targeting 2 different actors calls their mailbox
  kicks (assert via `_scheduled_functions` row count).
- `commitDefectOrRetry` increments on first throw, does not write
  response; on 3rd throw writes defect + deletes pending.
- `transitionAfterDrain` with more `deliverAt <= now()` rows → schedules
  `runAfter(0)`, stays `running`.
- `transitionAfterDrain` with only future rows → `scheduled` at correct
  time, generation bumped.
- `transitionAfterDrain` with no rows → `idle`, generation not bumped.
- `loadAndStartRunning` with mismatched generation → returns
  `{ stale: true }` and does not modify mailbox.

### Step 4.4 — End-to-end drain tests (`drain.test.ts`)

**Status:** `todo`

**Notes:**
> _none yet_

Uses a real definition registered into an `ActorSystem` + test
component. Invokes the drain mutation via `t.mutation(api.drain, ...)`.

- **Success path.** Define a counter actor. `send("inc")`, run scheduled
  drain (fake timers + `t.finishInProgressScheduledFunctions`), assert
  state patched, response row success, pending row gone, message row
  kept.
- **FIFO within same deliverAt.** Send A, B, C in the same transaction
  via a sender actor. Assert handler invocations happen in that order.
  Verify `sendSeq` is the discriminator.
- **Per-actor FIFO across transactions.** Two sends from a sender
  actor across two separate sender-drain transactions; target processes
  them in order.
- **`ctx.fail` path.** Handler calls `ctx.fail("nope", { a: 1 })`.
  Assert: state unchanged on actor row, response row is
  `{ kind: "fail", reason: "nope", details: { a: 1 } }`, pending row
  deleted, attempts never incremented.
- **Handler throw path.**
  - First throw: `pendingMessages.attempts === 1`, no response row.
  - Second throw: attempts 2.
  - Third throw: attempts 3, `response.kind === "defect"`, pending row
    deleted.
- **OCC discipline.** Handler throws a synthetic `ConvexError`-style
  OCC conflict (or better: test by racing two `send`s against a drain
  and assert the drain retries and processes both). Attempts stay 0
  under OCC retry.
- **Generation staleness.** Schedule drain with `generation = 0`, bump
  mailbox to `generation = 1` manually, run the stale drain directly,
  assert it returns without touching state and without writing a
  response row.
- **Effect application.** Handler calls `ctx.stub(other).send("ping")`.
  Assert: target actor + mailbox created, one message + one pending row
  on target, target mailbox kicked to `scheduled`, caller's state
  reflects any mutation it made.
- **Effect rollback on fail.** Handler emits two effects then calls
  `ctx.fail`. Assert no `messages`/`pendingMessages` rows were inserted
  on targets and no target mailbox rows created.
- **Past deliverAt clamp.** Handler schedules self-send with `at` in the
  past → processed at `now`, not jumping queue ahead of already-pending
  messages with the same `now` deliverAt (use sendSeq tiebreaker).
- **Peek from handler.** `ctx.stub(other).peek()` returns committed
  projection of another actor in the same transaction.
- **Peek of a def without `project`** → null.
- **Scheduled self-send** with `after: 1000` lands in the future; not
  processed by the drain that emitted it.

### Step 4.5 — `initialState` validation

**Status:** `todo`

**Notes:**
> _none yet_

- On first send, `definition.initialState()` runs, result validated
  against `state` validator before insert.
- Bad initialState throws → surfaced as a defect on the message that
  triggered creation? Or throws at send time?
- SPEC: "a bad `initialState` throws on first send and is surfaced as a
  defect response." So `enqueueMessage` path must create the actor (so
  the message row and response target exist), then the first drain
  processes the message and fails to build state → defect.
- Alternative: validate in app-level send before calling component, so
  the error surfaces synchronously. SPEC text ("surfaced as a defect
  response") favors the first option.
- **Test:** define actor whose `initialState()` throws. Send a message.
  Poll response row, assert `kind: "defect"` after 3 attempts (or 1 —
  clarify in implementation whether bad initialState retries).
  **Decision to make during Phase 4.5: does bad initialState consume all
  3 attempts or short-circuit to defect immediately?** Short-circuit
  seems saner — record as open question.

---

## Phase 5 — Recovery

### Step 5.1 — Recovery scan (`recovery.ts`)

**Status:** `todo`

**Notes:**
> _none yet_

- Internal mutation scanning all `mailboxState` rows where
  `drain.kind === "running"` and `drain.startedAt < now - RECOVERY_THRESHOLD_MS`.
- For each: bump generation, schedule fresh drain at `now` with new
  generation, update `scheduledId` on mailbox (transition to
  `scheduled`).
- **Tests (`recovery.test.ts`):**
  - Empty → no-op.
  - Fresh running row (startedAt within threshold) → no-op.
  - Stale running row → generation bumped, new drain scheduled,
    old-generation drain if run manually is a no-op (generation guard).
  - Live-drain race: simulate running drain committing at the same time
    as recovery bumps generation — only one commit wins (OCC on
    mailboxState). Verify via two parallel `t.run`s.

### Step 5.2 — Recovery cron (`crons.ts`)

**Status:** `todo`

**Notes:**
> _none yet_

- Cron every 5 minutes calling `recovery.scan`.
- **Test:** register cron, assert it exists in `ctx.db.system` cron
  listing (matches workpool's crons test pattern if there is one; if
  not, skip and test handler directly).

---

## Phase 6 — Response retention

### Step 6.1 — TTL on write

**Status:** `todo`

**Notes:**
> _none yet_

- `commitSuccess`, `commitFail`, `commitDefectOrRetry` set `retainUntil`
  per SPEC §Three outcomes (success/fail: +1h; defect: undefined).
- **Test:** inspect `retainUntil` after each outcome.

### Step 6.2 — Prune cron (`responses.ts`)

**Status:** `todo`

**Notes:**
> _none yet_

- Cron every minute (or hour — tune) deleting rows where
  `retainUntil < now`. Defects (no `retainUntil`) are never pruned.
- **Tests:**
  - Expired success row pruned, fresh success row kept.
  - Defect row never pruned regardless of age.
  - Fail row respects TTL.

---

## Phase 7 — Client API

### Step 7.1 — `createActorClient` (`src/actors/index.ts`)

**Status:** `todo`

**Notes:**
> _none yet_

- Takes the generated `api.actors` object; returns `{ stub }` and hooks.
- `actors.stub(type, name)` returns an opaque handle `{ type, name }`
  typed against the `typeof system`.
- **Test (jsdom-less):** type-level tests for stub inference; runtime
  stub is just the tuple.

### Step 7.2 — Hooks

**Status:** `todo`

**Notes:**
> _none yet_

- `useActorPeek(stub)` — `useQuery(api.peek, { type, name })`.
- `useActorSend(stub)` — returns `(msgType, payload, opts?) => Promise<MsgId>`
  backed by `useMutation(api.send)`.
- `useActorRequest(stub, msgType)` — state machine as in SPEC:
  - `call(payload)` → call mutation, stash returned `messageId`,
    subscribe `useQuery(api.getResponse, { messageId })`.
  - `status` derived from response row: `idle | pending | success | fail | defect`.
- **Tests:** light jsdom tests with `@testing-library/react` if desired,
  or skip in favor of a smoke integration test against a live dev
  deployment. Not blocking for MVP.

---

## Phase 8 — Integration smoke test

### Step 8.1 — Two-actor conversation

**Status:** `todo`

**Notes:**
> _none yet_

- Define `counter` and `ping` actors. `ping` sends to `counter`,
  `counter` increments. Run against `convexTest`.
- Assert end-to-end: send to `ping` → eventually counter state is N,
  response rows exist for all messages.
- Run with fake timers, drive drains via
  `t.finishInProgressScheduledFunctions()` loops.

### Step 8.2 — Parallelism across actors

**Status:** `todo`

**Notes:**
> _none yet_

- 10 actors, each receives 10 sequential sends. Assert they interleave
  (non-blocking) but each actor's own state shows ordered processing.

### Step 8.3 — Crash recovery smoke

**Status:** `todo`

**Notes:**
> _none yet_

- Hand-write a `mailboxState` in `running` with old `startedAt`, no
  actual drain running. Run recovery cron handler. Assert a fresh drain
  eventually drains the pending queue.

---

## Open decisions (resolve during implementation)

Record the resolution in the relevant step's **Notes** block when
decided, and update this list.

1. **Bad `initialState` — defect immediately or consume all attempts?**
   Favoring immediate defect; deterministic failure shouldn't retry.
   _Resolve in Step 4.5._
2. **Drain function handle storage.** Pass per-kick as an arg vs. store
   on `mailboxState` once. Passing per-kick is simpler and avoids stale
   handle issues across definition-map changes. _Tentative: per-kick.
   Confirm in Step 2.2._
3. **Response TTL cron frequency.** Every minute vs every 5 minutes.
   Pick based on expected response row volume; start at 5 min.
   _Resolve in Step 6.2._
4. **Whether `drainOps.commitSuccess` should take effect descriptors
   as an array of objects vs. call a shared `enqueueInner` helper.**
   Prefer a shared `enqueueInner` so `enqueueMessage` and drain effect
   apply share code paths. _Resolve in Step 4.3._
5. **Logging.** Workpool has a full logging module; for MVP this can be
   a stub that delegates to `console.*`. Revisit if needed.
   _Resolve in Step 0.2 or later._

## Test harness notes

- Follow workpool `src/test.ts`: export `register(t, name)` that calls
  `t.registerComponent("actors", schema, modules)` so app-level tests
  can mount the component.
- All tests use `vi.useFakeTimers()` + fixed `setSystemTime` in
  `beforeEach` to make `now()`/`deliverAt` comparisons deterministic.
- Prefer calling exported handler functions directly (like workpool's
  `kickMainLoop(ctx, ...)`) over routing through `t.mutation`; it keeps
  tests fast and lets them assert intermediate state within the same
  transaction.
- For drain tests that need actual scheduling behavior, use
  `t.finishInProgressScheduledFunctions()` and
  `t.finishAllScheduledFunctions()` from `convex-test`.
