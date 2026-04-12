/// <reference types="vite/client" />
import { convexTest } from 'convex-test'
import { createFunctionHandle } from 'convex/server'
import { afterEach, assert, beforeEach, describe, expect, test, vi } from 'vitest'
import { getOrCreateActorRow, getMailboxRow } from './actors.js'
import { api } from './_generated/api.js'
import { kickMailbox } from './kick.js'
import schema from './schema.js'
import { KICK_EPSILON_MS, YEAR } from './shared.js'

const modules = import.meta.glob('./**/*.ts')

// Fixed wall clock so scheduler timestamps are deterministic. Fake
// timers also prevent scheduled functions from actually firing while
// the tests inspect `_scheduled_functions` rows.
const T0 = 1_700_000_000_000

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(T0)
})
afterEach(() => {
  vi.useRealTimers()
})

/**
 * Stand-in `FunctionHandle` the kick tests pass into `kickMailbox`. In
 * production this is the app-level drain's handle; here any valid
 * `function://...` string works because we never advance fake timers,
 * so the scheduled callback never actually runs. We use
 * `createFunctionHandle(api.kick.kickMailbox)` only to get a
 * parseable handle — the target function is irrelevant.
 */
async function makeExecuteHandle() {
  return (await createFunctionHandle(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (api as any).kick.kickMailbox,
  )) as unknown as import("./kick.js").ExecuteFnHandle
}

describe('kickMailbox', () => {
  test('idle → scheduled: schedules at deliverAt, generation untouched', async () => {
    const t = convexTest(schema, modules)
    await t.run(async (ctx) => {
      const executeFn = await makeExecuteHandle()
      const { actor, mailbox } = await getOrCreateActorRow(ctx, {
        actorType: 'counter',
        name: 'a',
        executeFn,
      })
      expect(mailbox.generation).toBe(0)
      expect(mailbox.drainKind).toBe('idle')

      const deliverAt = T0 + 1000
      await kickMailbox(ctx, { actorId: actor._id, deliverAt, executeFn })

      const after = (await getMailboxRow(ctx, actor._id))!
      // Kick is not allowed to touch generation — that's the drain's job.
      expect(after.generation).toBe(0)
      assert(after.drainKind === 'scheduled')
      expect(after.drainAt).toBe(deliverAt)
      // executeFn persisted for crash recovery
      expect(after.executeFn).toBe(executeFn)

      const scheduled = await ctx.db.system.get(after.drainScheduledId!)
      assert(scheduled)
      assert('state' in scheduled)
      expect(scheduled.state.kind).toBe('pending')
      expect(scheduled.scheduledTime).toBe(deliverAt)
      // The scheduled drain carries the current generation value, not
      // a bumped one — fencing happens on the drain side. It also
      // carries its own `executeFn` so step-8 self-reschedule can forward
      // the handle without re-creating it.
      expect(scheduled.args[0]).toEqual({
        actorId: actor._id,
        generation: 0,
        executeFn,
      })
    })
  })

  test('scheduled with later kick is a no-op', async () => {
    const t = convexTest(schema, modules)
    await t.run(async (ctx) => {
      const executeFn = await makeExecuteHandle()
      const { actor } = await getOrCreateActorRow(ctx, {
        actorType: 'counter',
        name: 'a',
        executeFn,
      })
      // First kick schedules at T0 + 1000.
      await kickMailbox(ctx, {
        actorId: actor._id,
        deliverAt: T0 + 1000,
        executeFn,
      })
      const before = (await getMailboxRow(ctx, actor._id))!
      assert(before.drainKind === 'scheduled')
      const originalScheduledId = before.drainScheduledId

      // Second kick asks for a later delivery — existing schedule
      // already covers it, so nothing should change.
      await kickMailbox(ctx, {
        actorId: actor._id,
        deliverAt: T0 + 5000,
        executeFn,
      })
      const after = (await getMailboxRow(ctx, actor._id))!
      expect(after.generation).toBe(before.generation)
      assert(after.drainKind === 'scheduled')
      expect(after.drainScheduledId).toBe(originalScheduledId)
      expect(after.drainAt).toBe(T0 + 1000)

      // Still exactly one pending scheduled function row.
      const allScheduled = await ctx.db.system
        .query('_scheduled_functions')
        .collect()
      expect(allScheduled).toHaveLength(1)
    })
  })

  test('bring-forward within KICK_EPSILON_MS is a no-op', async () => {
    // An improvement delta smaller than the epsilon is not worth the
    // cancel churn. Timing derived from KICK_EPSILON_MS so this test
    // tracks the constant.
    const t = convexTest(schema, modules)
    await t.run(async (ctx) => {
      const executeFn = await makeExecuteHandle()
      const { actor } = await getOrCreateActorRow(ctx, {
        actorType: 'counter',
        name: 'a',
        executeFn,
      })
      // Original schedule fires at (epsilon - 1ms) past T0; a kick to
      // T0 would only save (epsilon - 1)ms, just inside the no-op window.
      const originalAt = T0 + KICK_EPSILON_MS - 1
      await kickMailbox(ctx, {
        actorId: actor._id,
        deliverAt: originalAt,
        executeFn,
      })
      const before = (await getMailboxRow(ctx, actor._id))!
      assert(before.drainKind === 'scheduled')
      const originalScheduledId = before.drainScheduledId

      await kickMailbox(ctx, {
        actorId: actor._id,
        deliverAt: T0,
        executeFn,
      })

      const after = (await getMailboxRow(ctx, actor._id))!
      assert(after.drainKind === 'scheduled')
      expect(after.drainScheduledId).toBe(originalScheduledId)
      expect(after.drainAt).toBe(originalAt)

      // Still only one scheduled row — the first one, untouched.
      const allScheduled = await ctx.db.system
        .query('_scheduled_functions')
        .collect()
      expect(allScheduled).toHaveLength(1)
      expect(allScheduled[0].state.kind).toBe('pending')
    })
  })

  test('bring-forward just past KICK_EPSILON_MS does reschedule', async () => {
    // Sibling to the no-op test above: one ms the other side of the
    // threshold flips behavior from no-op to cancel-and-reschedule.
    // Pair of tests pins the boundary exactly.
    const t = convexTest(schema, modules)
    await t.run(async (ctx) => {
      const executeFn = await makeExecuteHandle()
      const { actor } = await getOrCreateActorRow(ctx, {
        actorType: 'counter',
        name: 'a',
        executeFn,
      })
      const originalAt = T0 + KICK_EPSILON_MS + 1
      await kickMailbox(ctx, {
        actorId: actor._id,
        deliverAt: originalAt,
        executeFn,
      })
      const before = (await getMailboxRow(ctx, actor._id))!
      assert(before.drainKind === 'scheduled')
      const originalScheduledId = before.drainScheduledId

      await kickMailbox(ctx, {
        actorId: actor._id,
        deliverAt: T0,
        executeFn,
      })

      const after = (await getMailboxRow(ctx, actor._id))!
      assert(after.drainKind === 'scheduled')
      expect(after.drainScheduledId).not.toBe(originalScheduledId)
      expect(after.drainAt).toBe(T0)
    })
  })

  test('deliverAt far in the past is clamped to now', async () => {
    // boundScheduledTime clamps absurdly old timestamps to now so a
    // bogus deliverAt doesn't confuse follow-up no-op comparisons.
    const t = convexTest(schema, modules)
    await t.run(async (ctx) => {
      const executeFn = await makeExecuteHandle()
      const { actor } = await getOrCreateActorRow(ctx, {
        actorType: 'counter',
        name: 'a',
        executeFn,
      })

      await kickMailbox(ctx, {
        actorId: actor._id,
        deliverAt: T0 - 2 * YEAR, // wildly in the past
        executeFn,
      })

      const after = (await getMailboxRow(ctx, actor._id))!
      assert(after.drainKind === 'scheduled')
      expect(after.drainAt).toBe(T0) // clamped to now
      const scheduled = await ctx.db.system.get(after.drainScheduledId!)
      assert(scheduled && 'state' in scheduled)
      expect(scheduled.scheduledTime).toBe(T0)
    })
  })

  test('deliverAt far in the future is clamped to one year out', async () => {
    const t = convexTest(schema, modules)
    await t.run(async (ctx) => {
      const executeFn = await makeExecuteHandle()
      const { actor } = await getOrCreateActorRow(ctx, {
        actorType: 'counter',
        name: 'a',
        executeFn,
      })

      await kickMailbox(ctx, {
        actorId: actor._id,
        deliverAt: T0 + 10 * YEAR, // absurdly far future
        executeFn,
      })

      const after = (await getMailboxRow(ctx, actor._id))!
      assert(after.drainKind === 'scheduled')
      expect(after.drainAt).toBe(T0 + YEAR)
    })
  })

  test('scheduled with earlier kick cancels and reschedules', async () => {
    const t = convexTest(schema, modules)
    await t.run(async (ctx) => {
      const executeFn = await makeExecuteHandle()
      const { actor } = await getOrCreateActorRow(ctx, {
        actorType: 'counter',
        name: 'a',
        executeFn,
      })
      await kickMailbox(ctx, {
        actorId: actor._id,
        deliverAt: T0 + 5000,
        executeFn,
      })
      const before = (await getMailboxRow(ctx, actor._id))!
      assert(before.drainKind === 'scheduled')
      const originalScheduledId = before.drainScheduledId
      expect(before.generation).toBe(0)

      await kickMailbox(ctx, {
        actorId: actor._id,
        deliverAt: T0 + 1000,
        executeFn,
      })

      const after = (await getMailboxRow(ctx, actor._id))!
      // Still 0 — kick never writes generation, even on reschedule.
      // The race between the canceled-but-maybe-fired old drain and
      // the new one is resolved on the drain side: both carry gen=0,
      // whichever commits first bumps state to 1, the other retries
      // under OCC and fails its fence.
      expect(after.generation).toBe(0)
      assert(after.drainKind === 'scheduled')
      expect(after.drainAt).toBe(T0 + 1000)
      expect(after.drainScheduledId).not.toBe(originalScheduledId)

      // Old scheduled row was canceled, new one is pending.
      const oldJob = await ctx.db.system.get(originalScheduledId!)
      assert(oldJob && 'state' in oldJob)
      expect(oldJob.state.kind).toBe('canceled')
      const newJob = await ctx.db.system.get(after.drainScheduledId!)
      assert(newJob && 'state' in newJob)
      expect(newJob.state.kind).toBe('pending')
      expect(newJob.scheduledTime).toBe(T0 + 1000)
      expect(newJob.args[0]).toEqual({
        actorId: actor._id,
        generation: 0,
        executeFn,
      })
    })
  })

  test('running mailbox is untouched', async () => {
    const t = convexTest(schema, modules)
    await t.run(async (ctx) => {
      const executeFn = await makeExecuteHandle()
      const { actor, mailbox } = await getOrCreateActorRow(ctx, {
        actorType: 'counter',
        name: 'a',
        executeFn,
      })
      // Force the mailbox into running state and bump generation to 42
      // so we can detect any accidental writes.
      await ctx.db.patch(mailbox._id, {
        generation: 42,
        drainKind: 'running',
        drainStartedAt: T0,
      })
      const before = (await getMailboxRow(ctx, actor._id))!

      await kickMailbox(ctx, {
        actorId: actor._id,
        deliverAt: T0 + 1000,
        executeFn,
      })

      const after = (await getMailboxRow(ctx, actor._id))!
      // Byte-for-byte identical: no patch should have fired.
      expect(after).toEqual(before)

      // And no new scheduled function row was created.
      const allScheduled = await ctx.db.system
        .query('_scheduled_functions')
        .collect()
      expect(allScheduled).toHaveLength(0)
    })
  })

  test('stale scheduledId skips cancel but still reschedules', async () => {
    const t = convexTest(schema, modules)
    await t.run(async (ctx) => {
      const executeFn = await makeExecuteHandle()
      const { actor, mailbox } = await getOrCreateActorRow(ctx, {
        actorType: 'counter',
        name: 'a',
        executeFn,
      })

      // Simulate a stale schedule: the previous scheduled drain has
      // already completed (state=success) but the mailbox still points
      // at it. Kick with an earlier deliverAt should skip the cancel
      // (system.get shows non-pending) and still schedule a new one.
      const staleScheduledId = await ctx.scheduler.runAt(
        T0 + 10_000,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        executeFn as any,
        { actorId: actor._id, generation: 1, executeFn },
      )
      // Manually mark it as success — convex-test lets us patch the
      // system table directly, which matches the post-run state of a
      // drain that has already completed.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (ctx.db as any).patch(staleScheduledId, {
        state: { kind: 'success' },
      })
      await ctx.db.patch(mailbox._id, {
        generation: 1,
        drainKind: 'scheduled',
        drainScheduledId: staleScheduledId,
        drainAt: T0 + 10_000,
      })

      await kickMailbox(ctx, {
        actorId: actor._id,
        deliverAt: T0 + 1000,
        executeFn,
      })

      const after = (await getMailboxRow(ctx, actor._id))!
      expect(after.generation).toBe(1)
      assert(after.drainKind === 'scheduled')
      expect(after.drainAt).toBe(T0 + 1000)
      expect(after.drainScheduledId).not.toBe(staleScheduledId)

      // Stale row was left alone (still 'success', not 'canceled').
      const staleJob = await ctx.db.system.get(staleScheduledId)
      assert(staleJob)
      expect(staleJob.state.kind).toBe('success')
    })
  })

  test('concurrent kicks converge to a single scheduled state', async () => {
    const t = convexTest(schema, modules)
    // Bootstrap the actor in a first transaction so the concurrent
    // kicks below all operate on the same address.
    const { actorId } = await t.run(async (ctx) => {
      const executeFn = await makeExecuteHandle()
      const { actor } = await getOrCreateActorRow(ctx, {
        actorType: 'counter',
        name: 'a',
        executeFn,
      })
      return { actorId: actor._id }
    })

    // Fan out 10 concurrent kicks with varying deliverAts.
    await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        t.run(async (ctx) => {
          const executeFn = await makeExecuteHandle()
          await kickMailbox(ctx, {
            actorId,
            deliverAt: T0 + 1000 + i * 100,
            executeFn,
          })
        }),
      ),
    )

    await t.run(async (ctx) => {
      const mailbox = (await getMailboxRow(ctx, actorId))!
      assert(mailbox.drainKind === 'scheduled')
      // Kick never writes generation, so it stays at the initial 0
      // regardless of how many kicks landed. The drain will bump it
      // once it actually runs.
      expect(mailbox.generation).toBe(0)

      // Exactly one scheduled function is still pending — any
      // earlier-scheduled ones were canceled on rekick.
      const scheduled = await ctx.db.system
        .query('_scheduled_functions')
        .collect()
      const pending = scheduled.filter((s) => s.state.kind === 'pending')
      expect(pending).toHaveLength(1)
      expect(pending[0]._id).toBe(mailbox.drainScheduledId)
    })
  })
})
