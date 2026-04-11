import { z } from 'zod'
import { components } from './_generated/api'
import { account, auction } from './auctionActors'
import { auctionHouse } from './auctionHouse'
import { bidSaga, settlementSaga } from './auctionSagas'
import { defineActor, reply } from './components/actors/client/defineActor'
import { defineSaga } from './components/actors/client/defineSaga'
import { makeExecute } from './components/actors/client/execute'
import { ActorSystem } from './components/actors/client/system'

// ── Actor definitions ───────────────────────────────────────────

export const counter = defineActor({
  type: 'counter',
  state: z.object({ count: z.number() }),
  messages: {
    inc: { payload: z.object({ by: z.number() }) },
    dec: { payload: z.object({ by: z.number() }) },
    reset: { payload: z.object({}) },
  },
  initialState: () => ({ count: 0 }),
  project: (state) => ({ count: state.count }),
  handle: {
    inc: async (state, { by }) => {
      state.count += by
    },
    dec: async (state, { by }) => {
      state.count -= by
    },
    reset: async (state) => {
      state.count = 0
    },
  },
})

// Extracted so wallet can self-reference its own return type in reply()
const walletBalanceReturn = z.object({ newBalance: z.number() })

export const wallet = defineActor({
  type: 'wallet',
  state: z.object({
    balance: z.number(),
    log: z.array(z.string()),
  }),
  messages: {
    deposit: {
      payload: z.object({ amount: z.number() }),
      response: walletBalanceReturn,
    },
    withdraw: {
      payload: z.object({ amount: z.number() }),
      response: walletBalanceReturn,
    },
    transfer: {
      payload: z.object({ to: z.string(), amount: z.number() }),
      response: walletBalanceReturn,
    },
    // Reply handler: receives deposit confirmation from the target wallet.
    // Uses reply(schema, opts) overload since wallet references itself.
    transferDepositResult: {
      payload: reply(walletBalanceReturn, {
        context: z.object({ to: z.string(), amount: z.number() }),
      }),
    },
  },
  initialState: () => ({ balance: 0, log: [] }),
  project: (state) => ({ balance: state.balance, log: state.log }),
  handle: {
    deposit: async (state, { amount }) => {
      state.balance += amount
      state.log = [
        ...state.log.slice(-9),
        `+$${amount} (balance: $${state.balance})`,
      ]
      return { newBalance: state.balance }
    },
    withdraw: async (state, { amount }, ctx) => {
      if (amount > state.balance) {
        ctx.fail('insufficient_funds', {
          requested: amount,
          available: state.balance,
        })
      }
      state.balance -= amount
      state.log = [
        ...state.log.slice(-9),
        `-$${amount} (balance: $${state.balance})`,
      ]
      return { newBalance: state.balance }
    },
    transfer: async (state, { to, amount }, ctx) => {
      if (amount > state.balance) {
        state.log = [
          ...state.log.slice(-9),
          `REJECTED transfer $${amount} -> ${to} (balance: $${state.balance})`,
        ]
        ctx.fail('insufficient_funds', {
          requested: amount,
          available: state.balance,
        })
      }
      state.balance -= amount
      // Ask the target wallet to deposit — the response routes back to
      // transferDepositResult on *this* wallet instance.
      ctx.ask(
        wallet,
        to,
        'deposit',
        { amount },
        {
          handler: 'transferDepositResult',
          context: { to, amount },
        },
      )
      state.log = [
        ...state.log.slice(-9),
        `transfer $${amount} -> ${to} pending (balance: $${state.balance})`,
      ]
      return { newBalance: state.balance }
    },
    transferDepositResult: async (state, { result, context }) => {
      if (result.kind === 'success') {
        state.log = [
          ...state.log.slice(-9),
          `transfer $${context.amount} -> ${context.to} confirmed (recipient balance: $${result.value.newBalance})`,
        ]
      } else {
        // Compensate: re-credit the amount since the deposit failed
        state.balance += context.amount
        const reason = result.kind === 'fail' ? result.reason : result.error
        state.log = [
          ...state.log.slice(-9),
          `transfer $${context.amount} -> ${context.to} FAILED: ${reason} (refunded, balance: $${state.balance})`,
        ]
      }
    },
  },
})

export const fragile = defineActor({
  type: 'fragile',
  state: z.object({ processed: z.number() }),
  messages: {
    work: {
      payload: z.object({ value: z.string() }),
      response: z.object({ echo: z.string() }),
    },
    crash: { payload: z.object({}) },
  },
  initialState: () => ({ processed: 0 }),
  project: (state) => ({ processed: state.processed }),
  handle: {
    work: async (state, { value }) => {
      state.processed++
      return { echo: value }
    },
    crash: async () => {
      throw new Error('unexpected internal failure')
    },
  },
})

/**
 * Dispatches jobs to fragile workers via ask/reply. Demonstrates:
 * - ask from a regular actor (not a saga)
 * - handling success replies (work completed)
 * - handling defect replies (worker crashed after max retries)
 * - context carry-through to correlate replies with jobs
 */
export const jobRunner = defineActor({
  type: 'jobRunner',
  state: z.object({
    pending: z.number(),
    completed: z.array(z.object({ job: z.string(), echo: z.string() })),
    failed: z.array(z.object({ job: z.string(), error: z.string() })),
  }),
  messages: {
    dispatch: { payload: z.object({ worker: z.string(), value: z.string() }) },
    dispatchCrash: { payload: z.object({ worker: z.string() }) },
    workResult: {
      payload: reply(fragile, 'work', {
        context: z.object({ job: z.string() }),
      }),
    },
    crashResult: {
      payload: reply(z.unknown(), {
        context: z.object({ job: z.string() }),
      }),
    },
  },
  initialState: () => ({ pending: 0, completed: [], failed: [] }),
  project: (state) => ({
    pending: state.pending,
    completed: state.completed,
    failed: state.failed,
  }),
  handle: {
    dispatch: async (state, { worker, value }, ctx) => {
      state.pending++
      ctx.ask(
        fragile,
        worker,
        'work',
        { value },
        {
          handler: 'workResult',
          context: { job: value },
        },
      )
    },
    dispatchCrash: async (state, { worker }, ctx) => {
      state.pending++
      ctx.ask(
        fragile,
        worker,
        'crash',
        {},
        {
          handler: 'crashResult',
          context: { job: `crash-${worker}` },
        },
      )
    },
    workResult: async (state, { result, context }) => {
      state.pending--
      if (result.kind === 'success') {
        state.completed = [
          ...state.completed,
          { job: context.job, echo: result.value.echo },
        ]
      } else {
        const error = result.kind === 'fail' ? result.reason : result.error
        state.failed = [...state.failed, { job: context.job, error }]
      }
    },
    crashResult: async (state, { result, context }) => {
      state.pending--
      const error =
        result.kind === 'success'
          ? 'unexpected success'
          : result.kind === 'fail'
            ? result.reason
            : result.error
      state.failed = [...state.failed, { job: context.job, error }]
    },
  },
})

export const pingPong = defineActor({
  type: 'pingPong',
  state: z.object({ hits: z.number(), log: z.array(z.string()) }),
  messages: {
    serve: { payload: z.object({ to: z.string(), rallies: z.number() }) },
    reset: { payload: z.object({}) },
    hit: { payload: z.object({ from: z.string(), ralliesLeft: z.number() }) },
  },
  initialState: () => ({ hits: 0, log: [] }),
  project: (state) => ({ hits: state.hits, log: state.log }),
  handle: {
    serve: async (state, { to, rallies }, ctx) => {
      const self = ctx.self()
      state.hits = 0
      state.log = [`serving to ${to} (${rallies} rallies)`]
      ctx.stub(pingPong, to).send('reset', {})
      ctx.stub(pingPong, to).send('hit', {
        from: self.name,
        ralliesLeft: rallies - 1,
      })
    },
    reset: async (state) => {
      state.hits = 0
      state.log = []
    },
    hit: async (state, { from, ralliesLeft }, ctx) => {
      const self = ctx.self()
      state.hits++
      const action =
        ralliesLeft > 0
          ? `${from} -> ${self.name} -> ${from}`
          : `${from} -> ${self.name} (end)`
      state.log = [...state.log.slice(-9), `#${state.hits} ${action}`]

      if (ralliesLeft > 0) {
        ctx.stub(pingPong, from).send('hit', {
          from: self.name,
          ralliesLeft: ralliesLeft - 1,
        })
      }
    },
  },
})

export const countdown = defineActor({
  type: 'countdown',
  state: z.object({
    remaining: z.number(),
    running: z.boolean(),
    log: z.array(z.string()),
  }),
  messages: {
    start: { payload: z.object({ from: z.number(), intervalMs: z.number() }) },
    tick: { payload: z.object({ intervalMs: z.number() }) },
  },
  initialState: () => ({ remaining: 0, running: false, log: [] }),
  project: (state) => ({
    remaining: state.remaining,
    running: state.running,
    log: state.log,
  }),
  handle: {
    start: async (state, { from, intervalMs }, ctx) => {
      state.remaining = from
      state.running = true
      state.log = [`started at ${from}`]
      ctx.sendSelf('tick', { intervalMs }, { after: intervalMs })
    },
    tick: async (state, { intervalMs }, ctx) => {
      if (!state.running) return
      state.remaining--
      state.log = [...state.log.slice(-9), `tick -> ${state.remaining}`]
      if (state.remaining <= 0) {
        state.running = false
        state.log = [...state.log.slice(-9), 'done!']
      } else {
        ctx.sendSelf('tick', { intervalMs }, { after: intervalMs })
      }
    },
  },
})

const LEADERBOARD_COUNTERS = ['alice', 'bob', 'charlie']

export const leaderboard = defineActor({
  type: 'leaderboard',
  state: z.object({
    rankings: z.array(z.object({ name: z.string(), count: z.number() })),
    lastRefresh: z.number().optional(),
  }),
  messages: {
    refresh: { payload: z.object({}) },
  },
  initialState: () => ({ rankings: [], lastRefresh: undefined }),
  project: (state) => ({
    rankings: state.rankings,
    lastRefresh: state.lastRefresh,
  }),
  handle: {
    refresh: async (state, _payload, ctx) => {
      const entries: { name: string; count: number }[] = []
      for (const name of LEADERBOARD_COUNTERS) {
        const projection = await ctx.stub(counter, name).peek()
        entries.push({ name, count: projection?.count ?? 0 })
      }
      entries.sort((a, b) => b.count - a.count)
      state.rankings = entries
      state.lastRefresh = ctx.now()
    },
  },
})

// ── Saga demo: orchestrated transfer via defineSaga ─────────────

export const transferSaga = defineSaga({
  type: 'transferSaga',
  input: z.object({
    from: z.string(),
    to: z.string(),
    amount: z.number(),
  }),
  context: z.object({}),
  initialContext: () => ({}),
  firstStep: 'withdraw',
  steps: {
    withdraw: {
      run: (input, _context, ctx) => {
        return ctx.ask(wallet, input.from, 'withdraw', {
          amount: input.amount,
        })
      },
      onSuccess: (_value, _input, context) => ({
        context,
        next: 'deposit',
      }),
      compensate: (input, _context, ctx) => {
        ctx.stub(wallet, input.from).send('deposit', {
          amount: input.amount,
        })
      },
    },
    deposit: {
      run: (input, _context, ctx) => {
        return ctx.ask(wallet, input.to, 'deposit', {
          amount: input.amount,
        })
      },
      onSuccess: () => ({ next: null }),
    },
  },
})

// ── Compensation demo: multi-withdraw with rollback ─────────────

export const multiTransfer = defineSaga({
  type: 'multiTransfer',
  input: z.object({
    sources: z.array(z.string()),
    target: z.string(),
    amount: z.number(),
  }),
  context: z.object({ index: z.number() }),
  initialContext: () => ({ index: 0 }),
  firstStep: 'withdraw',
  steps: {
    withdraw: {
      run: (input, context, ctx) =>
        ctx.ask(wallet, input.sources[context.index], 'withdraw', {
          amount: input.amount,
        }),
      onSuccess: (_value, input, context) => {
        const nextIndex = context.index + 1
        if (nextIndex < input.sources.length) {
          return { context: { index: nextIndex }, next: 'withdraw' as const }
        }
        return { context, next: 'deposit' as const }
      },
      compensate: (input, context, ctx) => {
        ctx.stub(wallet, input.sources[context.index]).send('deposit', {
          amount: input.amount,
        })
      },
    },
    deposit: {
      run: (input, _context, ctx) =>
        ctx.ask(wallet, input.target, 'deposit', {
          amount: input.amount * input.sources.length,
        }),
      onSuccess: () => ({ next: null }),
    },
  },
})

// ── Wire-up ─────────────────────────────────────────────────────

const defs = {
  counter,
  wallet,
  fragile,
  jobRunner,
  pingPong,
  countdown,
  leaderboard,
  transferSaga,
  multiTransfer,
  account,
  auction,
  auctionHouse,
  bidSaga,
  settlementSaga,
}

export const execute = makeExecute(defs, components.actors)
export const system = new ActorSystem(components.actors, defs)
