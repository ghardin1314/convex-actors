# Demo: Real-Time Auction House

A fully-featured auction platform showcasing every actor pattern in the framework.

---

## Actor Inventory

### Core Actors

#### `account`
User's financial account and activity log.

```ts
state: { balance, holds: Map<holdId, amount>, displayName }
messages:
  deposit    { amount }                        -> void
  hold       { holdId, amount }                -> void  (fails if insufficient)
  releaseHold { holdId }                       -> void
  settleHold  { holdId }                       -> void
project: { balance, availableBalance, displayName }
```

- **`deposit`** — add funds
- **`hold`** — reserve funds for a pending bid. `ctx.fail("insufficient_funds")` if available balance too low
- **`releaseHold`** — cancel a hold (bidder was outbid)
- **`settleHold`** — deduct the held amount permanently (bidder won)

Patterns: **Entity Actor**, **Typed Failures via `ctx.fail()`**

---

#### `auction`
Single auction instance — a full state machine with timer-driven transitions and snipe protection. Created by and reports state back to the `auctionHouse` supervisor.

```ts
state: {
  phase: "initializing" | "active" | "going_once" | "going_twice"
       | "settling" | "sold" | "expired" | "settlement_failed",
  item: { title, description, imageUrl },
  seller: string,
  startingPrice: number,
  currentBid: { bidder, amount, holdId } | null,
  previousBids: Array<{ bidder, amount, ts }>,
  endsAt: number,
  tickEpoch: number,    // bumped on snipe extension to invalidate stale ticks
  config: { durationMs, goingOnceMs, goingTwiceMs, minIncrement }
}
messages:
  init               { item, seller, startingPrice, config? }  -> void  (from auctionHouse)
  bid                { bidder, amount, holdId }                -> void  (fails if wrong phase / too low)
  close              {}                                        -> void
  tick               { epoch: number }                         -> void  (self-only; ignored if epoch stale)
  settlementComplete {}                                        -> void  (from settlementSaga)
  settlementFailed   { reason: string }                        -> void  (from settlementSaga)
project: { phase, item, currentBid: { bidder, amount } | null, previousBids, endsAt }
```

Every phase transition and every accepted bid fires a `reportState` send to `auctionHouse:"main"` (fire-and-forget) so the supervisor's registry stays current.

**State machine transitions:**

```
              create (init)       tick (endsAt)       tick (+goingOnceMs)    tick (+goingTwiceMs)
  ──> pending ──────> active ──────> going_once ──────> going_twice ──────> settling
                         ^               |                   |                  │
                         |    (bid: snipe protection)        |                  │  settlementComplete ──> sold
                         |    resets to going_once           |                  │  settlementFailed   ──> settlement_failed
                         └───────────────┘                   │
                                                             └── (bid: resets to going_once)
                                                             │
                                                    no bid at tick ──> expired
```

**Messages:**

- **`init { item, seller, startingPrice, config? }`** — sent by `auctionHouse` immediately after the actor is created. Populates state from defaults, transitions `initializing -> active`, schedules first `tick` at `endsAt`, reports initial state to supervisor
- **`bid { bidder, amount, holdId }`** — place a bid. Must exceed `currentBid.amount + minIncrement`. On success: fires `releaseHold` at the previous bidder's account (fire-and-forget), stores new bid, reports updated bid to supervisor. **Snipe protection:** if phase is `going_once` or `going_twice`, reset phase to `going_once`, bump `tickEpoch`, set `endsAt = now + goingOnceMs`, schedule a fresh `tick` with the new epoch, and report the phase change. `ctx.fail("phase_closed")` if not biddable, `ctx.fail("bid_too_low")` if amount insufficient
- **`close {}`** — admin force-close
- **`tick { epoch }`** — internal self-scheduled message. **First line of the handler:** `if (payload.epoch !== state.tickEpoch) return` — discards stale ticks from a pre-snipe generation. Otherwise drives the state machine forward and reports each phase change. In `going_twice` with a bid: transition to `settling` and kick off a `settlementSaga` (fire-and-forget). No bid at any tick: transition to `expired`
- **`settlementComplete {}`** — from settlement saga. Transition `settling -> sold`, report to supervisor
- **`settlementFailed { reason }`** — from settlement saga (rare — compensation also failed). Transition `settling -> settlement_failed`, report to supervisor. Terminal state

**Why epochs?** When a snipe-protected bid extends the timer, the previously-scheduled tick is still sitting in the mailbox. We can't cancel it, so we invalidate it: bump `tickEpoch` on every reschedule, compare in the handler, drop mismatches. Every phase transition that schedules a follow-up tick also bumps the epoch so only the latest tick is ever honored.

**Timer scheduling:**

```ts
// On create:
state.tickEpoch = 0
ctx.sendSelf("tick", { epoch: 0 }, { after: config.durationMs })

// On tick (active -> going_once):
state.tickEpoch += 1
ctx.sendSelf("tick", { epoch: state.tickEpoch }, { after: config.goingOnceMs })

// On snipe-protected bid (reset to going_once):
state.tickEpoch += 1
state.endsAt = ctx.now() + config.goingOnceMs
ctx.sendSelf("tick", { epoch: state.tickEpoch }, { after: config.goingOnceMs })

// On tick (going_once -> going_twice):
state.tickEpoch += 1
ctx.sendSelf("tick", { epoch: state.tickEpoch }, { after: config.goingTwiceMs })
```

Patterns: **State Machine**, **Timer / Self-Scheduling**, **Cross-Actor `ask/reply`**, **Snipe Protection**

---

#### `bidSaga`
Orchestrates the multi-step bid flow using `defineSaga`. One saga per bid attempt.

```ts
defineSaga({
  type: "bidSaga",
  input: z.object({
    bidder: z.string(),
    auctionName: z.string(),
    amount: z.number(),
    holdId: z.string(),
  }),
  context: z.object({}),
  initialContext: () => ({}),
  firstStep: "holdFunds",
  steps: {
    holdFunds: {
      run: (input, _context, ctx) =>
        ctx.ask(account, input.bidder, "hold", {
          holdId: input.holdId,
          amount: input.amount,
        }),
      onSuccess: (_value, _input, context) => ({
        context,
        next: "placeBid",
      }),
      // If a later step fails, release the hold we just placed
      compensate: (input, _context, ctx) => {
        ctx.stub(account, input.bidder).send("releaseHold", {
          holdId: input.holdId,
        })
      },
    },
    placeBid: {
      run: (input, _context, ctx) =>
        ctx.ask(auction, input.auctionName, "bid", {
          bidder: input.bidder,
          amount: input.amount,
          holdId: input.holdId,
        }),
      onSuccess: () => ({ next: null }), // done
      // No compensate on the final step — if it fails, nothing to undo at this level;
      // the framework walks back to holdFunds.compensate
    },
  },
})
```

**Failure semantics:**
- If `holdFunds` itself fails (insufficient funds), nothing was reserved — saga fails with no compensation
- If `placeBid` fails (outbid / phase closed), the saga walks back through `completedSteps` in reverse and runs `holdFunds.compensate` — releasing the hold

**Flow:**

```
  start          holdFunds (ask)       placeBid (ask)
  ──> holding ──────> bidding ──────> done
        │                │
        │ fail           │ fail (outbid / closed)
        └──> failed      └──> failed + compensation (releaseHold)
```

- `holdFunds` asks the bidder's account to hold funds. If account fails (`insufficient_funds`), saga fails — no compensation needed since nothing was reserved yet
- `placeBid` asks the auction to accept the bid. If auction fails (`bid_too_low`, `phase_closed`), compensation runs automatically — releases the hold
- No manual phase tracking, no explicit failure messages — `defineSaga` handles it all

Patterns: **Saga / Process Manager**, **Automatic Compensation**

---

#### `settlementSaga`
Orchestrates the final money movement when an auction closes with a winning bid. Split out from the auction actor because it's a multi-step distributed transaction that can fail halfway through and needs proper compensation.

```ts
defineSaga({
  type: "settlementSaga",
  input: z.object({
    auctionName: z.string(),
    winner: z.string(),
    seller: z.string(),
    amount: z.number(),
    holdId: z.string(),
  }),
  context: z.object({}),
  initialContext: () => ({}),
  firstStep: "settleWinnerHold",
  steps: {
    settleWinnerHold: {
      run: (input, _context, ctx) =>
        ctx.ask(account, input.winner, "settleHold", {
          holdId: input.holdId,
        }),
      onSuccess: (_value, _input, context) => ({
        context,
        next: "payoutSeller",
      }),
      // If payoutSeller fails, refund the winner
      compensate: (input, _context, ctx) => {
        ctx.stub(account, input.winner).send("deposit", {
          amount: input.amount,
        })
      },
    },
    payoutSeller: {
      run: (input, _context, ctx) =>
        ctx.ask(account, input.seller, "deposit", {
          amount: input.amount,
        }),
      onSuccess: (_value, input, _context) => ({
        context: {},
        next: "notifyAuction",
      }),
    },
    notifyAuction: {
      // Sync step — just notify the auction that settlement completed
      run: (input, _context, ctx) => {
        ctx.stub(auction, input.auctionName).send("settlementComplete", {})
        return { next: null }
      },
    },
  },
})
```

**Flow:**

```
  start       settleWinnerHold (ask)    payoutSeller (ask)    notifyAuction (sync)
  ──> running ──────> ──────────────> ──────> ──────────────> ──────> done
                             │                     │
                             │ fail                │ fail
                             └──> failed           └──> compensate: deposit refund to winner
                                                        then send settlementFailed to auction
```

**Failure semantics:**
- `settleWinnerHold` fails → nothing moved, saga fails, auction receives `settlementFailed` (via error reporting)
- `payoutSeller` fails → `settleWinnerHold.compensate` runs, refunding the winner; auction receives `settlementFailed`
- `notifyAuction` is a sync step with no external call, so it can't really fail; if it did, the compensation chain would run and we'd be in trouble — arguably this last step should be replaced with a post-completion hook if the framework supports one

**Why a separate saga?** Keeping settlement in the auction's `tick` handler would mean: (1) no compensation if step 2 fails after step 1 succeeds, (2) the auction's state machine has to model in-flight settlement anyway (hence the `settling` phase), (3) retries on defect would re-run state mutations. Extracting it isolates the distributed-transaction concerns from the state machine.

Patterns: **Saga / Compensation**, **Multi-Actor Transaction**

---

#### `auctionHouse`
Singleton supervisor/registry. Owns auction creation, tracks every auction's current state in a single projection, and periodically health-checks for stuck settlements. Named `"main"`.

```ts
state: {
  nextAuctionId: number,
  auctions: Record<auctionName, {
    item: { title, imageUrl },
    seller: string,
    phase: AuctionPhase,
    currentBid: { bidder, amount } | null,
    endsAt: number,
    lastUpdate: number,
  }>,
  stuckAlerts: Array<{ auctionName, reason, ts }>,
}
messages:
  createAuction { item, seller, startingPrice, config? }  -> { auctionName: string }
  reportState   { auctionName, phase, currentBid, endsAt } -> void  (from auction)
  checkHealth   {}                                         -> void  (self-scheduled)
project: {
  listings: Array<{ name, item, phase, currentBid, endsAt }>,
  count: number,
  stuckAlerts: Array<{ auctionName, reason, ts }>,
}
```

- **`createAuction`** — allocates a fresh name (e.g. `auction-${nextAuctionId++}`), sends `init` to that new auction via stub, inserts a placeholder entry into `auctions` with phase `initializing`, returns `{ auctionName }` as the reply
- **`reportState`** — called by each auction on every phase transition and accepted bid. Updates the registry entry for that auction, refreshes `lastUpdate`. Fire-and-forget from the auction's perspective
- **`checkHealth`** — self-scheduled via `ctx.sendSelf("checkHealth", {}, { after: intervalMs })`. Walks `auctions`, flags any entry in `settling` phase with `lastUpdate > staleThreshold`, records to `stuckAlerts`. Schedules the next check

**Why a supervisor instead of a cross-actor query?**

- Single actor to peek for the UI lobby — no table scan, no new index
- Registry is built incrementally via push (each auction reports its own state), not recomputed on every read
- Creation is centralized — consistent naming, atomic registry insert, easy to enforce invariants (max concurrent auctions, per-seller limits, etc.)
- Health monitoring lives where the data already does, instead of in a separate `auctionMonitor` actor

**Tradeoff:** the registry is a hot write path — every phase transition on every auction sends a message here. For demo scale that's fine; for production you'd shard by category or use a secondary index pattern.

Patterns: **Supervisor / Registry**, **Self-Scheduled Monitor**, **Push-based State Aggregation**

---

### Stretch Actors (Bonus Patterns)

#### `auctionNotifier`
Fan-out actor. When an auction state changes, notifies all watchers.

```ts
state: { subscriptions: Map<auctionName, Set<accountName>> }
messages:
  subscribe   { account, auctionName }         -> void
  unsubscribe { account, auctionName }         -> void
  notify      { auctionName, event }           -> void
project: { subscriptions }
```

- **`notify`** — called by auction on phase changes / new bids. For each subscriber, could fan out to per-user inbox actors or external push. Demonstrates one event triggering N downstream messages

Patterns: **Pub/Sub Fan-out**

---

## Pattern Checklist

| Pattern | Actor(s) | Priority |
|---|---|---|
| Entity Actor | `account` | Core |
| State Machine | `auction` | Core |
| Timer / Self-Scheduling | `auction.tick` | Core |
| Epoch-based Stale Message Rejection | `auction.tick` | Core |
| Snipe Protection | `auction.bid` | Core |
| Cross-Actor `ask/reply` | `bidSaga`, `settlementSaga` -> `account` | Core |
| Fire-and-forget (`send`) | `auction` -> `releaseHold`, `auction` -> `auctionHouse.reportState` | Core |
| Saga + Compensation (bid flow) | `bidSaga` | Core |
| Saga + Compensation (settlement) | `settlementSaga` | Core |
| Supervisor / Registry | `auctionHouse` | Core |
| Push-based State Aggregation | `auction` -> `auctionHouse` | Core |
| Self-Scheduled Health Check | `auctionHouse.checkHealth` | Core |
| Typed Failures | `account.hold`, `auction.bid` | Core |
| Pub/Sub Fan-out | `auctionNotifier` | Stretch |

---

## Message Flow: Placing a Bid

Touches 3 actors across 2 patterns (saga + ask/reply):

```
User clicks "Bid $50"
        │
        v
   ┌──────────┐   ask: hold { holdId, amount: 50 }    ┌──────────┐
   │ bidSaga   │ ────────────────────────────────────>  │ account  │
   │ "bid-17"  │ <────────────────────────────────────  │ "alice"  │
   └──────────┘   reply: { kind: "success" }            └──────────┘
        │
        │  ask: bid { bidder: "alice", amount: 50, holdId }
        v
   ┌──────────┐   send: releaseHold { holdId: prev }  ┌──────────┐
   │ auction   │ ────────────────────────────────────>  │ account  │
   │ "rare-01" │                                        │ "bob"    │
   └──────────┘         (fire-and-forget)               └──────────┘
        │
        │  reply: { kind: "success" }
        v
   ┌──────────┐
   │ bidSaga   │  ──> done (saga complete)
   │ "bid-17"  │
   └──────────┘
```

**Failure path — outbid:**

```
   bidSaga "bid-17"          auction "rare-01"          account "alice"
        │                          │                          │
   ask: bid ─────────────────>     │                          │
        │              reply: { kind: "fail",                 │
        │ <──────────── reason: "bid_too_low" }               │
        │                                                     │
   compensation kicks in:                                     │
   send: releaseHold { holdId } ─────────────────────────────>│
        │                                                     │
   saga -> failed                                             │
```

---

## Message Flow: Auction Closing (with Snipe Protection + Settlement Saga)

Timer-driven state machine with snipe extension and separated settlement transaction:

```
  auction "rare-01"         settlementSaga      account "alice"     account "seller-1"
                                                    (WINNER)              (SELLER)
        │
   [tick fires at endsAt]
   phase: active -> going_once
   sendSelf(tick, { after: goingOnceMs })
        │
   [bid arrives during going_once!]
   SNIPE PROTECTION: reset to going_once, bump tickEpoch
   sendSelf(tick, { after: goingOnceMs })
        │
   [stale tick fires — epoch mismatch — dropped]
        │
   [fresh tick fires — no new bid]
   phase: going_once -> going_twice
   sendSelf(tick, { after: goingTwiceMs })
        │
   [tick fires]
   has currentBid? YES
   phase: going_twice -> settling
   send: start settlementSaga ─> │
        │                        │
        │     ask alice: settleHold { holdId } ─────>│
        │                        │<── reply: ok ─────│  (winner debited)
        │                        │
        │     ask seller-1: deposit { amount } ──────────────────────>│
        │                        │<── reply: ok ───────────────────────│  (seller credited)
        │                        │
        │<── send: settlementComplete ──│
   phase: settling -> sold
```

**Failure path — seller deposit rejected (e.g. account frozen):**

```
   auction "rare-01"         settlementSaga      account "alice"     account "seller-1"
                                                    (WINNER)              (SELLER)
        │                        │
   phase: settling               │
        │                        │
        │     ask alice: settleHold { holdId } ─────>│
        │                        │<── reply: ok ─────│  (winner debited)
        │                        │
        │     ask seller-1: deposit { amount } ──────────────────────>│
        │                        │<── reply: fail ─────────────────────│  (seller rejected)
        │                        │
        │                 compensation of settleWinnerHold:
        │                        │
        │     send alice: deposit { amount } ────────>│  (refund winner)
        │                        │
        │<── send: settlementFailed { reason } ──│
   phase: settling -> settlement_failed
   (operator intervention needed)
```

---

## App API Layer

**The UI never talks to the actor framework directly.** All client interactions go through regular Convex queries and mutations defined in the app, which wrap actor operations with auth, validation, rate limiting, and whatever else the real app needs. The framework's generic `useActor` / `peek` hooks are fine for exploration and the debug panel, but production code should build its own typed API.

```ts
// convex/auctions.ts — app-owned queries and mutations

export const list = query({
  args: {},
  handler: async (ctx) => {
    // auth check, etc.
    const house = await system.peek(ctx, auctionHouse, "main")
    return house?.listings ?? []
  },
})

export const getAuction = query({
  args: { name: v.string() },
  handler: async (ctx, { name }) => {
    // auth check
    return await system.peek(ctx, auction, name)
  },
})

export const createAuction = mutation({
  args: { item: itemSchema, startingPrice: v.number() },
  handler: async (ctx, { item, startingPrice }) => {
    const user = await requireAuth(ctx)
    // rate limit: max N auctions per user per day
    const messageId = await system.send(
      ctx, execute, auctionHouse, "main", "createAuction",
      { item, seller: user.name, startingPrice },
    )
    return messageId  // caller polls getResponse for the new auction name
  },
})

export const placeBid = mutation({
  args: { auctionName: v.string(), amount: v.number() },
  handler: async (ctx, { auctionName, amount }) => {
    const user = await requireAuth(ctx)
    // validate amount against minimum, reject obvious spam, etc.
    const bidId = `bid-${crypto.randomUUID()}`
    const holdId = `hold-${bidId}`
    return await system.send(
      ctx, execute, bidSaga, bidId, "start",
      { bidder: user.name, auctionName, amount, holdId },
    )
  },
})

export const deposit = mutation({
  args: { amount: v.number() },
  handler: async (ctx, { amount }) => {
    const user = await requireAuth(ctx)
    return await system.send(ctx, execute, account, user.name, "deposit", { amount })
  },
})

export const getAccount = query({
  args: {},
  handler: async (ctx) => {
    const user = await requireAuth(ctx)
    return await system.peek(ctx, account, user.name)
  },
})
```

On the client:

```tsx
// Standard Convex hooks — no framework-specific hooks required
const listings = useQuery(api.auctions.list)
const auction = useQuery(api.auctions.getAuction, { name })
const placeBid = useMutation(api.auctions.placeBid)
```

**Why:** the framework's `useActor` hook is generic — it doesn't know about your app's auth, can't rate-limit, can't reject invalid payloads early. Keeping the actor API private and exposing a curated set of app queries/mutations means the UI is insulated from actor changes, and auth/validation live in one obvious place.

---

## UI Pages

### 1. Auction Lobby (`/`)
- `useQuery(api.auctions.list)` — grid of auction cards
- Each card: item image, title, current bid, time remaining (live countdown)
- Phase badge (active / going once / going twice / settling / sold)
- "Create Auction" button → `useMutation(api.auctions.createAuction)`, navigate to the returned auction name
- Stuck-settlement banner from `list` response

### 2. Auction Detail (`/auction/:name`)
- `useQuery(api.auctions.getAuction, { name })` — item display, current bid, bid history, phase
- Phase indicator with visual urgency (going once = yellow, going twice = red)
- Bid input + "Place Bid" button → `useMutation(api.auctions.placeBid)`
- Live countdown timer (resets on snipe protection)
- "Snipe protection active" indicator when timer extends

### 3. Account Dashboard (`/account`)
- `useQuery(api.auctions.getAccount)` — balance, available balance, active holds
- "Deposit Funds" button → `useMutation(api.auctions.deposit)`

### 4. Admin / Debug Panel (`/debug`)
- The **one** place that uses the framework's generic `useActor` hook directly — lets an operator peek any actor by type + name without needing a typed app query for it
- Raw message send form (bypasses app-level validation — admin only)
- Saga status viewer (phase, completed steps, fail reason)

---

## Implementation Order

### Phase 1: Core actors
1. `account` actor — deposit, hold, release, settle with `ctx.fail()` for errors
2. `auction` actor — init, bid, tick state machine, snipe protection
3. Integration tests: direct account <-> auction bid flow (no saga yet)

### Phase 2: Supervisor + sagas
4. `auctionHouse` supervisor — createAuction, reportState, checkHealth self-schedule
5. Wire `auction` to report state back to `auctionHouse:"main"` on every transition
6. `bidSaga` via `defineSaga` — hold, bid, compensation
7. `settlementSaga` via `defineSaga` — settle winner, payout seller, compensate on failure; add `settling` / `sold` / `settlement_failed` phase transitions to `auction`
8. End-to-end test: create via auctionHouse, bid through saga, auction ticks through settlement to sold, snipe protection triggers, settlement failure triggers compensation

### Phase 3: App API layer
9. `convex/auctions.ts` — app-owned queries and mutations (`list`, `getAuction`, `createAuction`, `placeBid`, `deposit`, `getAccount`) with auth stubs and validation
10. Basic auth helper (`requireAuth`) — can be a no-op for demo but structured so real auth drops in cleanly

### Phase 4: UI
11. Auction lobby — `useQuery(api.auctions.list)`, create button
12. Auction detail with live bidding + snipe protection UX + settling phase indicator
13. Account dashboard

### Phase 5: Stretch patterns
14. `auctionNotifier` — fan-out on bid/phase changes
15. Debug panel — the one place that uses the framework's generic hooks directly

---

## Open Questions

1. **Minimum bid increment** — fixed amount (`currentBid + 1`) or percentage-based? Fixed is simpler for demo. Could make configurable per auction via `config.minIncrement`.

2. **`auctionHouse` hot path** — every phase transition and accepted bid sends a `reportState` message to the single supervisor. At demo scale that's fine, but it's a serialized write path. For production you'd shard supervisors by category, region, or seller. Noted but not fixed for demo.

3. **Snipe protection reset target** — current design resets to `going_once` on any late bid. Alternative: reset to `active` with full duration. Going-once reset is standard (eBay-style) and keeps auctions from running forever.

4. **`settlement_failed` is terminal** — for the demo, if settlement fails we leave the auction in `settlement_failed` and stop. Compensation already refunded the winner, so the bidder keeps their money and the seller doesn't get paid. No retry, no operator recovery path. Production systems would want dead-letter / retry tooling, but that's out of scope here.

5. **Settlement saga name** — `bidSaga` is named by bid ID (unique per attempt). What should `settlementSaga` be named by? Options: (a) auction name (one settlement per auction), (b) a fresh UUID. Auction name is cleaner — there's exactly one settlement per auction — but prevents retry without a suffix. Leaning toward `${auctionName}-settlement` or `${auctionName}-settlement-v${n}` on retry.
