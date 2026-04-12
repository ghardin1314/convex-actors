import { z } from 'zod'
import { defineActor } from '../components/actors/client'

export const account = defineActor({
  type: 'account',
  state: z.object({
    balance: z.number(),
    /** holdId -> amount reserved (uncommitted). */
    holds: z.record(z.string(), z.number()),
  }),
  messages: {
    deposit: { payload: z.object({ amount: z.number() }) },
    hold: { payload: z.object({ holdId: z.string(), amount: z.number() }) },
    releaseHold: { payload: z.object({ holdId: z.string() }) },
    settleHold: { payload: z.object({ holdId: z.string() }) },
  },
  initialState: () => ({ balance: 0, holds: {} }),
  project: (state) => {
    const heldTotal = Object.values(state.holds).reduce((s, n) => s + n, 0)
    return {
      balance: state.balance,
      availableBalance: state.balance - heldTotal,
    }
  },
  handle: {
    deposit: async (state, { amount }) => {
      state.balance += amount
    },

    hold: async (state, { holdId, amount }, ctx) => {
      if (state.holds[holdId] !== undefined) {
        ctx.fail('hold_exists', { holdId })
      }
      const heldTotal = Object.values(state.holds).reduce((s, n) => s + n, 0)
      const available = state.balance - heldTotal
      if (amount > available) {
        ctx.fail('insufficient_funds', { requested: amount, available })
      }
      state.holds[holdId] = amount
    },

    releaseHold: async (state, { holdId }) => {
      // Idempotent: releasing an unknown hold is a no-op so duplicate
      // release messages (e.g. a displaced bidder releasing twice) don't
      // blow up the account.
      delete state.holds[holdId]
    },

    settleHold: async (state, { holdId }, ctx) => {
      const amount = state.holds[holdId]
      if (amount === undefined) {
        ctx.fail('hold_not_found', { holdId })
      }
      state.balance -= amount
      delete state.holds[holdId]
    },
  },
})
