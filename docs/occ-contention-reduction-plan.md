# OCC Contention Reduction Plan

Incremental plan to reduce OCC contention in the actor drain/enqueue system.
Each phase ends in a working, testable state.

---

## Current Contention Sources

The drain loop, enqueue, and kick all read/write shared documents, creating
OCC conflicts under load:

- **`actor` table**: enqueue reads it for address lookup, drain writes `state` every iteration
- **`mailboxState` table**: drain reads+writes every iteration, kick reads+writes on every enqueue
- **`pendingMessages` index range**: drain scans `[actorId, -∞..now()]`, concurrent inserts in that range cause conflicts
- **Cross-actor effects**: drain inline-kicks other actors' mailboxes, pulling their state into the transaction's read set
- **`handleTransition` future query**: unbounded scan of pendingMessages for future work, inside the main drain transaction

---

## Phase 1: Split `actor` into `actor` + `actorState`

**Goal**: Decouple address lookup from mutable actor state.

**Changes**:
- New `actorState` table: `{ actorId: Id<"actor">, state: v.any() }`
- `actor` table drops the `state` field, becomes `{ actorType, name }` — written only on creation
- Drain reads/writes `actorState` instead of patching `actor`
- `getOrCreateActorRow` reads the stable `actor` table — no longer conflicts with drain
- `getActorState` query reads from `actorState`

**Contention eliminated**: enqueue no longer conflicts with drain through the actor row.

**Test**: send messages to an active actor under concurrent load, verify no OCC retries from actor row conflicts.

---

## Phase 2: Split `mailboxState` into `drainSignal` + `drainBookkeeping`

**Goal**: Minimize what kick needs to read, isolate drain's internal bookkeeping.

**Changes**:
- `drainSignal` table: `{ actorId, drainKind, generation }` — shared between kick and drain, but only written on state transitions (idle↔scheduled↔running), not every iteration
- `drainBookkeeping` table: `{ actorId, scheduledId, drainAt, drainStartedAt, executeFn }` — only drain reads/writes, kick never touches it
- Kick reads `drainSignal` to decide whether to schedule. When `drainKind === "running"`, kick returns immediately (read-only, no write)
- Drain writes `drainSignal` only when `drainKind` actually changes
- Recovery reads `drainSignal` (indexed by `drainKind`) + `drainBookkeeping`

**Contention eliminated**: kick no longer conflicts with drain through shared bookkeeping fields. Under sustained load, `drainSignal` stays `"running"` — kick's read never conflicts because drain isn't writing it.

**Note**: we cannot drop the `ctx.db.system.get` check before `ctx.scheduler.cancel` in kick — cancel throws if the function has already completed. The system table read stays, but with the `drainSignal`/`drainBookkeeping` split, kick only hits this path (scheduled → reschedule) infrequently.

**Test**: high-throughput enqueue to an active actor. Kick should be near-free (read-only no-op on `drainSignal`).

---

## Phase 3: Frozen cursor + split drain into `drainLoop` / `updateDrainStatus`

**Goal**: Decouple producer/consumer index ranges and isolate the unbounded future-message
query from the main processing transaction.

### Approach: frozen timestamp cursor

No schema changes to `pendingMessages`. The existing `by_actor_deliverable` index
(`['actorId', 'deliverAt', 'sendSeq']`) is retained as-is.

Instead of segmenting messages into time buckets, each `drainLoop` iteration receives a
fixed `cursorTs` that caps its query range. The cursor is frozen for the lifetime of that
iteration — it never advances within a transaction, so retries read the same range and
concurrent enqueue inserts (which land at `deliverAt >= now()`) stay outside the scan
window.

**Enqueue** is unchanged — inserts at `deliverAt >= now()`.

### New drain architecture

The current `drainLoop` + `handleTransition` is replaced by two mutations:

#### `drainLoop(actorId, generation, executeFn, cursorTs)`

The main processing mutation. Runs in a tight loop via self-scheduling.

`cursorTs` is always provided by the caller — drainLoop never computes it:
- **`kickMailbox`** sets `cursorTs = deliverAt` (the trigger message's delivery time)
- **`updateDrainStatus`** sets `cursorTs = now()` (fresh snapshot when re-entering)
- **`drainLoop` self-schedule** passes the same `cursorTs` it received

```
1. Validate generation against drainSignal (bail if stale)
2. Query pendingMessages where actorId matches and deliverAt <= cursorTs
   (index `by_actor_deliverable` returns rows in deliverAt, sendSeq order)
3. Process each message:
     - Execute handler via ctx.runMutation
     - Write actorState, response, delete pending row
     - Insert effect messages + pendingMessages (NO kicks — phase 5)
4. Check for more work (same range, deliverAt <= cursorTs):
     If found:
       → ctx.scheduler.runAfter(0, drainLoop, { ..., cursorTs })
     If empty:
       → ctx.scheduler.runAfter(0, updateDrainStatus, { actorId, generation, executeFn })
```

**Why freeze the cursor?** A moving bound like `now() - GAP_MS` shifts on every retry
and between concurrent transactions, expanding the read set into ranges where enqueue is
actively inserting. A frozen cursor guarantees the scan range is identical across retries,
eliminating spurious OCC conflicts from range drift.

**Why no cursor advancement in drainLoop?** Under sustained load, messages arrive
continuously. If drainLoop tried to creep the cursor forward (e.g. `cursorTs + INCREMENT`),
it would inch into the range where enqueue is inserting — exactly the overlap we're
avoiding. Instead, cursor advancement is delegated to `updateDrainStatus`, which only
fires when the current range is exhausted (meaning load has subsided enough that the
overlap risk is minimal).

#### `updateDrainStatus(actorId, generation, executeFn)`

Lightweight follow-up mutation. Only runs when `drainLoop` exhausts its cursor range.
Runs in its own transaction so the open-ended query doesn't pollute drain's read set.

```
1. Validate generation against drainSignal (bail if stale)
2. Open-ended query: any pendingMessages for this actorId?
   If found and deliverAt <= now():
     → schedule drainLoop immediately with cursorTs = now()
     → write drainSignal { drainKind: "running" }
   If found and deliverAt > now():
     → schedule drainLoop at deliverAt with cursorTs = deliverAt
     → write drainSignal { drainKind: "scheduled" }
     → write drainBookkeeping { scheduledId, drainAt }
   If empty:
     → write drainSignal { drainKind: "idle" }
     → clear drainBookkeeping
```

If a concurrent enqueue conflicts with this open-ended scan, only this lightweight
mutation retries — not the processing transaction.

### Contention characteristics

- **Hot path (sustained load)**: `drainLoop` self-schedules with a frozen cursor.
  Enqueue writes at `deliverAt >= now()`, drain reads `deliverAt <= cursorTs` (a past
  snapshot). No index range overlap.
- **Wind-down**: `drainLoop` exhausts its range → `updateDrainStatus` does an open-ended
  scan in isolation → kicks a fresh `drainLoop` with a new `cursorTs` if more work exists.
  One extra mutation of overhead, negligible vs OCC retry cost.
- **Wake from idle**: `kickMailbox` sets `cursorTs = deliverAt`. No concurrent drain
  to conflict with.
- **Backpressure**: drain falls behind wall clock. Frozen cursor keeps scan range stable.
  Messages process in FIFO order. Enqueue stays ahead of drain's scan range.

### Test plan

- Verify future-scheduled messages get processed after queue drains
- Verify drain transitions to idle and wakes correctly via kick
- Sustained concurrent enqueue + drain on same actor — measure OCC retry rate
- Backpressure: enqueue faster than drain — verify FIFO order and stable scan range

---

## Phase 5: Deferred cross-actor kicks

**Goal**: Remove other actors' documents from drain's read set entirely.

**Changes**:
- When drain produces effects (handler results, replies), it inserts `messages` + `pendingMessages` rows inline (pure inserts, no contention) but does NOT call `kickMailbox`
- Instead, after drain commits, it schedules one `kickMailbox` call per distinct target actor at delay 0 — each runs in its own transaction. This is the same `kickMailbox` logic, just exposed as an `internalMutation` so it can be scheduled rather than called inline.
- Convex runs these concurrently since they're independent

**Contention eliminated**: drain's transaction touches only its own actor's documents. A conflict on actor B's `drainSignal` retries only B's kick, not A's processing. Cross-actor effects can no longer cause cascading retries.

**Test**: actor A sends effects to actors B, C, D. Verify all get processed. Under load, verify A's drain retry rate is unaffected by B/C/D's activity.

---

## Summary of read/write sets after all phases

| Transaction | Reads | Writes |
|---|---|---|
| **Enqueue** | `actor` (stable), `drainSignal` (usually no-op) | `messages` (insert), `pendingMessages` (insert), `drainSignal` (only on transition) |
| **Drain (main)** | `drainSignal`, `drainBookkeeping`, `actorState`, cursor-bounded `pendingMessages` | `actorState`, `drainBookkeeping`, `responses` (insert), `messages`/`pendingMessages` for effects (insert) |
| **updateDrainStatus** | `drainSignal`, `drainBookkeeping`, `pendingMessages` (open-ended but isolated) | `drainSignal`, `drainBookkeeping` |
| **kickActor** (per target) | target's `drainSignal` | target's `drainSignal` (only on transition) |
