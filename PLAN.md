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
> 2026-04-08 (later): **deleted `test.ts`**. `import.meta.glob` is
> Vite-only syntax and Convex's push-time module analyzer choked on
> `import.meta` inside the component dir (`InvalidModules: Failed to
> analyze test.js`). Convex auto-excludes `*.test.ts` files from
> analysis, which is why the actual `*.test.ts` siblings don't trip
> the same error even though they use the same glob. Nothing imported
> `test.ts` yet (component-internal tests inline their own
> `import.meta.glob("./**/*.ts")`), so deletion is a no-op for the
> current suite. When Phase 3+ app-level tests need to mount the
> component via `t.registerComponent`, re-add the helper outside
> `convex/` (e.g. at repo root under `test-helpers/`) so Convex never
> tries to analyze it — mirrors workpool's `src/test.ts` sitting
> outside `src/component/`.
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

**Status:** `done`

**Notes:**
> 2026-04-08: Added `actors.ts` with `getActorRow`, `getOrCreateActorRow`,
> `getMailboxRow`. All plain async fns over `QueryCtx`/`MutationCtx` so
> upcoming handlers (`enqueue`, `kick`, drain primitives) can compose
> them inside a single transaction without `runMutation` hops. Invariant
> enforced in one place: every `actor` insert is immediately followed by
> its paired `mailboxState` insert (`generation: 0`, `drain: idle`);
> nothing else in the component is allowed to insert into these tables.
> Throws loudly if a re-call ever finds an actor without a mailbox, which
> would mean the invariant was violated elsewhere.
> `actors.test.ts` covers: unknown lookup → null; first call creates
> paired rows with correct initial shape; second call is idempotent
> (same ids, externally-patched state preserved); distinct `(type, name)`
> tuples stay independent; `getMailboxRow` round-trip.
> 2026-04-08 (revision): dropped the `initialState` thunk arg from
> `getOrCreateActorRow`. The component has no access to the app-level
> definition registry, and passing initialState through enqueue was
> leaking execution-loop concerns into the row-level primitive. Now
> `actor.state` is `v.optional(v.any())` — populated by the drain loop
> on first handler invocation, which is the only place that can see
> `definition.initialState()` and the definition's `state` validator.
> This also makes bad-initialState failures naturally land as drain
> defects (SPEC §Initial state) without any special enqueue-time
> plumbing. Resolves the ugly `initialState: () => null` shim that had
> been introduced in `enqueue.ts`.

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

**Status:** `done`

**Notes:**
> 2026-04-08: Added `enqueue.ts` with `enqueueMessage` mutation + an
> exported `enqueueMessageHandler(ctx, effects)` helper so tests (and
> the future drain effect-apply path) can call straight into it without
> round-tripping through `runMutation`.
> Deviation from plan args shape: rather than
> `{ actorType, name, msgType, payload, deliverAt, effectList? }` with a
> single/list dual mode, the mutation takes a flat
> `{ effects: Array<...> }`. The single-send path just passes a
> 1-element array. This collapses two code paths into one and matches
> the plan's stated intent ("single-send path reuses the same code with
> a 1-element list") more directly.
> Batch-efficiency detour: briefly added a `getOrCreateActorIds`
> batch helper with parallel reads + parallel lazy-creates and
> `Promise.all` effect inserts, plus a per-target sendSeq counter.
> Reverted after review: the parallelization wasn't buying a real
> latency win (Convex transactions are effectively single-threaded
> for writes) and the per-target counter added complexity without
> improving any guarantee. Shipping the elegant version instead: a
> sequential for-loop with an in-call `(actorType, name) -> actorId`
> cache, `sendSeq = i` (input index) as the deterministic
> `by_actor_deliverable` tiebreaker. Sequential inserts also make the
> pending rows' `_creationTime` monotonic in input order, giving a
> belt-and-suspenders FIFO story. ~20 lines.
> `sendSeq` is assigned from the effect's index in the input array —
> repeated targets in one batch retain their original indices
> (e.g. a batch targeting [a, b, a] gives actor `a` sendSeqs 0 and 2,
> not 0 and 1). Contiguous per-target numbering would require a
> per-target counter; deferring unless a drain test shows it matters
> (cross-transaction ties still fall through to `_creationTime`).
> Enqueue calls `getOrCreateActorRow` with just `{ actorType, name }`;
> the row is inserted with no `state` field (`state` is
> `v.optional(v.any())`). The drain loop populates state on first
> handler invocation via the app-level definition. This keeps the
> component free of definition-registry plumbing and makes
> bad-initialState failures fall out as drain defects without special
> casing at enqueue time (SPEC §Initial state, revisit retry-count
> decision in Step 4.5).
> Does not kick the mailbox (Step 2.3 will wire that in after Step 2.2).
> `enqueue.test.ts` — 5 cases, all green: new-address creation, repeat
> address reuse, N-effect batch with sendSeq 0..N-1, multi-target batch
> with one actor-creation per distinct address, and index order via
> `by_actor_deliverable` with mixed `deliverAt` values + sendSeq
> tiebreaker. Full suite: 3 files / 11 tests passing.

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

**Status:** `done`

**Notes:**
> 2026-04-08: Added `kick.ts` exporting `kickMailbox(ctx, { actorId,
> deliverAt, drainFn })` as a plain async helper (not a mutation) so
> `enqueueMessage`, recovery, and the drain tail can all compose it
> inside their own transactions. `DrainFnHandle =
> FunctionHandle<"mutation", { actorId, generation }>` — the handle is
> passed on every call rather than cached on the mailbox row to avoid
> surviving stale handles across app redeploys.
> Four transitions implemented per plan:
> - `running` → early return, no write
> - `scheduled` with `at <= deliverAt` → early return, no write (and
>   critically, no generation bump — skipping the bump here keeps a
>   concurrent in-flight drain from being spuriously invalidated)
> - `scheduled` with `at >  deliverAt` → `db.system.get` the existing
>   scheduledId, `scheduler.cancel` only if its state is `pending`,
>   then fall through to the idle branch
> - `idle` (or post-cancel fallthrough) → bump generation,
>   `scheduler.runAt(deliverAt, drainFn, { actorId, generation })`,
>   patch `drain: { kind: "scheduled", scheduledId, at: deliverAt }`
> Tests (`kick.test.ts`, 6 cases, all green — suite: 4 files / 18
> tests):
> - idle → scheduled: generation 0→1, scheduledTime matches deliverAt
> - later-kick no-op: generation/scheduledId/at byte-for-byte unchanged,
>   still exactly 1 row in `_scheduled_functions`
> - earlier-kick reschedule: new scheduledId, generation 1→2, old row
>   state `canceled`, new row state `pending`
> - running → no-op: byte-for-byte doc equality (`expect(after).toEqual(before)`)
>   and zero rows in `_scheduled_functions`
> - stale scheduledId (patched to `state: success`) → cancel skipped,
>   reschedule still happens, stale row left `success` not `canceled`
> - 10 concurrent `t.run` kicks with varying deliverAts → end state has
>   exactly one `pending` scheduled function matching the mailbox's
>   `drain.scheduledId`
> Test infra: `makeDrainHandle()` helper uses
> `createFunctionHandle((api as any).kick.kickMailbox)` solely to get a
> parseable `function://...` string. convex-test's scheduler only parses
> the handle — it never resolves the target unless the setTimeout
> callback fires, and with `vi.useFakeTimers()` it never does. The
> `as any` cast is because the component's `_generated/api.ts` is
> `anyApi as any` (component has no own functions registered at the
> convex.config level yet), and we just need the proxy to respond to
> the `functionName` symbol so `createFunctionHandle` can serialize it.
> One tsc/eslint escape hatch: the `ctx.db.patch(staleScheduledId, {
> state: "success" })` line in the stale-id test casts
> `ctx.db as any` because `_scheduled_functions` is a system table and
> the public writer type doesn't expose it. Convex-test allows the
> write at runtime and it's the only way to simulate a drain that has
> already completed without actually running it. Acceptable as a
> test-only shim; will revisit if a nicer seam appears during Phase 5
> (recovery) where the same state is needed.
> Step 2.3 will wire this into `enqueueMessage`; the drainFn handle
> will need to plumb through from the app-level `send` mutation down
> through `enqueueMessage` as a new arg.
>
> 2026-04-08 (SPEC amendment): Generation ownership moved from kick to
> drain, matching workpool's loop.ts pattern. Kick now reads
> `mailbox.generation` and passes it through unchanged to
> `scheduler.runAt`; the idle-branch patch only writes `drain`, not
> `generation`. SPEC §Drain generation and recovery rewritten: the
> three bump sites collapsed to two (drain step 1 + recovery). The
> bring-forward safety argument is unchanged in spirit — best-effort
> cancel + both-fire-race resolved by whoever bumps first under OCC —
> but the fencing happens on the drain side instead of the kick side.
> All six kick tests updated: idle→scheduled, reschedule, stale-id,
> and concurrent kicks all now assert `generation` stays at 0 (or at
> the manually-set value in the stale-id test's case, which starts at
> 1). Added an extra assertion that the scheduled row's args carry the
> correct `{ actorId, generation }` pair so Phase 4's drain
> implementation can rely on it. Suite green (4 files / 18 tests).
>
> 2026-04-08 (workpool robustness port): Ported three more guards from
> `.context/workpool/src/component/kick.ts` that aren't about
> saturated-parallelism semantics (which don't apply to per-actor
> drains):
> - `KICK_EPSILON_MS = 1 * SECOND` constant in `shared.ts`. Kick's
>   no-op check is now `drain.at <= deliverAt + KICK_EPSILON_MS`
>   rather than strict `<= deliverAt`. Prevents churn when a kick
>   only shaves sub-second latency off an already-scheduled drain.
>   Generalized workpool's "close to NOW" framing to "close to the
>   requested deliverAt" since our deliverAts can be arbitrarily
>   future-dated.
> - `boundScheduledTime(ms)` helper in `shared.ts`. Clamps wildly
>   stale timestamps (> 1y old → now) and absurdly future ones
>   (> 4y out → now + 1y). Mirrors workpool byte-for-byte. Kick
>   runs every `deliverAt` through it up front so both the epsilon
>   comparison and the `scheduler.runAt` call see the same clamped
>   value. `YEAR` constant added alongside the existing time
>   helpers.
> - `console.warn` on the reschedule path when `ctx.db.system.get`
>   shows the existing `scheduledId` in anything other than
>   `pending` (or missing entirely). Workpool logs in the same spot.
>   Not a correctness fix — we still silently fall through to
>   reschedule — but it surfaces cases where the `drain` pointer
>   went stale without `mailboxState.drain` being cleaned up, which
>   would point at a bug in the drain step-8 transition or recovery
>   handoff.
> Three new tests added (`kick.test.ts`, now 9 cases total,
> suite 4 files / 21 tests):
> - bring-forward within epsilon is a no-op (scheduled at T0+800ms,
>   kicked to T0: same `scheduledId`, same `at`, one scheduled row)
> - `deliverAt = T0 - 2*YEAR` clamps to `T0`
> - `deliverAt = T0 + 10*YEAR` clamps to `T0 + YEAR`
> SPEC §Per-actor drain loop updated with the epsilon phrasing, the
> warn-on-stale-id behavior, and a paragraph on `boundScheduledTime`.

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

**Status:** `done`

**Notes:**
> 2026-04-08: `enqueueMessage` now takes a `drainFn: v.string()` arg
> alongside `effects`. Handler casts it to `DrainFnHandle` and passes
> it through to `kickMailbox`. Matches workpool's pattern of carrying
> `FunctionHandle` over the wire as `v.string()` and narrowing at the
> use site — avoids pulling a validator for branded strings that
> serialize identically to plain strings anyway.
> Per-target earliest-deliverAt: plan originally said "min deliverAt
> across the effect batch" but that conflates multi-target batches.
> Actual impl maintains an `earliestByActor: Map<Id<"actor">, number>`
> populated inside the insert loop, then kicks each distinct actor
> once with its own min. A batch re-targeting the same actor at
> multiple deliverAts collapses to a single kick at the tightest
> deadline; a batch targeting N distinct actors produces N kicks.
> No duplicate kicks, no lost earlier-deadline info.
> Kicks are issued sequentially after all inserts complete, not
> interleaved. Two reasons: (1) the kick's state-machine read of
> `mailboxState` must see the post-insert world, and (2) sequential
> ordering makes `_scheduled_functions` rows appear in a predictable
> order for the multi-target test.
> Test delta: 6 existing tests updated to pass `drainFn` through
> (drainFn is built inside each `t.run` via `makeDrainHandle()` since
> `createFunctionHandle` requires a convex runtime — `beforeEach`
> can't build it, tried and hit a "database used outside backend"
> syscall error). First test's drain assertion flipped from
> `{ kind: "idle" }` to `scheduled` + `at === T0`, reflecting the
> fact that enqueue now leaves mailboxes scheduled, not idle.
> Three new tests cover the wiring itself:
> - single-actor mixed-deliverAt batch → kick at the min, not at
>   `effects[0].deliverAt`; one `_scheduled_functions` row carrying
>   `{ actorId, generation: 0 }`.
> - second send at a later deliverAt is a no-op on the scheduler
>   (same `scheduledId`, same `at`, still one pending row). Covers
>   the idempotent bring-back-forward path through `kickMailbox`'s
>   `at <= deliverAt + KICK_EPSILON_MS` early return.
> - multi-target `[a, b, a]` batch with per-target differing
>   deliverAts → 2 scheduled rows, each keyed to its own actor with
>   its own per-target min (a's later `deliverAt: T0 + 500` beats
>   its earlier `T0 + 2000`). Assert via `args[0].actorId` lookup.
> Suite: 4 files / 25 tests passing.

- Once 2.1 and 2.2 pass independently, have `enqueueMessage` call
  `kickMailbox(actorId, earliestDeliverAt)` after inserts. Earliest is
  the min `deliverAt` across the effect batch — computed **per target
  actor**, not globally, so multi-target batches kick each distinct
  address with its own tightest deadline.
- **Test:** send from cold state schedules a drain at the requested
  `deliverAt`; send #2 at a later time with drain already scheduled
  earlier is a no-op on scheduler.

---

## Phase 3 — App-level container and definitions

> **Branded types retrofit — decide during Phase 3.** Consider introducing
> a literal-parameterized brand `ActorType<T extends string>` / `ActorName<T>`
> at the app-level surface (`defineActor`, `ActorSystem`, stubs, `send`,
> `peek`). Goal: make `stub(counter, "a")` and `stub(ping, "a")` distinct
> at the type level so cross-type mix-ups fail to compile, and fix the
> literal in each `defineActor` result. Keep the component internals
> (`shared.ts`, `actors.ts`, schema, enqueue/kick/drainOps) on plain
> `string` — brand only at the typed API seam, since validators
> serialize as `v.string()` either way. Revisit once `defineActor` +
> stubs exist and there is a real consumer to protect.

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
