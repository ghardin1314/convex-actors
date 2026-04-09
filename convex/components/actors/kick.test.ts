/// <reference types="vite/client" />
import { convexTest } from 'convex-test'
import { createFunctionHandle } from 'convex/server'
import { afterEach, assert, beforeEach, describe, expect, test, vi } from 'vitest'
import { getOrCreateActorRow, getMailboxRow } from './actors.js'
import { api } from './_generated/api.js'
import { kickMailbox, type DrainFnHandle } from './kick.js'
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
async function makeDrainHandle(): Promise<DrainFnHandle> {
  // Cast: api.kick.kickMailbox is not really a registered mutation,
  // but convex-test's scheduler only parses the handle string — it
  // never looks up the target unless the scheduled callback fires.
  return (await createFunctionHandle(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (api as any).kick.kickMailbox,
  )) as unknown as DrainFnHandle
}

describe('kickMailbox', () => {
  test('idle → scheduled: schedules at deliverAt, generation untouched', async () => {
    const t = convexTest(schema, modules)
    await t.run(async (ctx) => {
      const drainFn = await makeDrainHandle()
      const { actor, mailbox } = await getOrCreateActorRow(ctx, {
        actorType: 'counter',
        name: 'a',
      })
      expect(mailbox.generation).toBe(0)
      expect(mailbox.drain).toEqual({ kind: 'idle' })

      const deliverAt = T0 + 1000
      await kickMailbox(ctx, { actorId: actor._id, deliverAt, drainFn })

      const after = (await getMailboxRow(ctx, actor._id))!
      // Kick is not allowed to touch generation — that's the drain's
      // job. See SPEC §Drain generation and recovery.
      expect(after.generation).toBe(0)
      assert(after.drain.kind === 'scheduled')
      expect(after.drain.at).toBe(deliverAt)

      const scheduled = await ctx.db.system.get(after.drain.scheduledId)
      expect(scheduled).not.toBeNull()
      assert(scheduled)
      expect(scheduled.state.kind).toBe('pending')
      expect(scheduled.scheduledTime).toBe(deliverAt)
      // The scheduled drain carries the current generation value, not
      // a bumped one — fencing happens on the drain side.
      expect(scheduled.args[0]).toEqual({
        actorId: actor._id,
        generation: 0,
      })
    })
  })

  test('scheduled with later kick is a no-op', async () => {
    const t = convexTest(schema, modules)
    await t.run(async (ctx) => {
      const drainFn = await makeDrainHandle()
      const { actor } = await getOrCreateActorRow(ctx, {
        actorType: 'counter',
        name: 'a',
      })
      // First kick schedules at T0 + 1000.
      await kickMailbox(ctx, {
        actorId: actor._id,
        deliverAt: T0 + 1000,
        drainFn,
      })
      const before = (await getMailboxRow(ctx, actor._id))!
      assert(before.drain.kind === 'scheduled')
      const originalScheduledId = before.drain.scheduledId

      // Second kick asks for a later delivery — existing schedule
      // already covers it, so nothing should change.
      await kickMailbox(ctx, {
        actorId: actor._id,
        deliverAt: T0 + 5000,
        drainFn,
      })
      const after = (await getMailboxRow(ctx, actor._id))!
      expect(after.generation).toBe(before.generation)
      assert(after.drain.kind === 'scheduled')
      expect(after.drain.scheduledId).toBe(originalScheduledId)
      expect(after.drain.at).toBe(T0 + 1000)

      // Still exactly one pending scheduled function row.
      const allScheduled = await ctx.db.system
        .query('_scheduled_functions')
        .collect()
      expect(allScheduled).toHaveLength(1)
    })
  })

  test('bring-forward within KICK_EPSILON_MS is a no-op', async () => {
    // Mirrors workpool's "scheduled to run soon enough" guard,
    // generalized to "close to requested deliverAt". An improvement
    // delta strictly smaller than the epsilon is not worth the
    // cancel churn. We derive all timing from KICK_EPSILON_MS so this
    // test tracks the constant instead of baking in "800ms".
    const t = convexTest(schema, modules)
    await t.run(async (ctx) => {
      const drainFn = await makeDrainHandle()
      const { actor } = await getOrCreateActorRow(ctx, {
        actorType: 'counter',
        name: 'a',
      })
      // Original schedule fires at (epsilon - 1ms) past T0; a kick to
      // T0 would only save (epsilon - 1)ms, just inside the no-op window.
      const originalAt = T0 + KICK_EPSILON_MS - 1
      await kickMailbox(ctx, {
        actorId: actor._id,
        deliverAt: originalAt,
        drainFn,
      })
      const before = (await getMailboxRow(ctx, actor._id))!
      assert(before.drain.kind === 'scheduled')
      const originalScheduledId = before.drain.scheduledId

      await kickMailbox(ctx, {
        actorId: actor._id,
        deliverAt: T0,
        drainFn,
      })

      const after = (await getMailboxRow(ctx, actor._id))!
      assert(after.drain.kind === 'scheduled')
      expect(after.drain.scheduledId).toBe(originalScheduledId)
      expect(after.drain.at).toBe(originalAt)

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
      const drainFn = await makeDrainHandle()
      const { actor } = await getOrCreateActorRow(ctx, {
        actorType: 'counter',
        name: 'a',
      })
      const originalAt = T0 + KICK_EPSILON_MS + 1
      await kickMailbox(ctx, {
        actorId: actor._id,
        deliverAt: originalAt,
        drainFn,
      })
      const before = (await getMailboxRow(ctx, actor._id))!
      assert(before.drain.kind === 'scheduled')
      const originalScheduledId = before.drain.scheduledId

      await kickMailbox(ctx, {
        actorId: actor._id,
        deliverAt: T0,
        drainFn,
      })

      const after = (await getMailboxRow(ctx, actor._id))!
      assert(after.drain.kind === 'scheduled')
      expect(after.drain.scheduledId).not.toBe(originalScheduledId)
      expect(after.drain.at).toBe(T0)
    })
  })

  test('deliverAt far in the past is clamped to now', async () => {
    // boundScheduledTime mirror of workpool's clamp: anything
    // absurdly old becomes "run ASAP". We don't want a kick with a
    // bogus timestamp to confuse follow-up no-op comparisons.
    const t = convexTest(schema, modules)
    await t.run(async (ctx) => {
      const drainFn = await makeDrainHandle()
      const { actor } = await getOrCreateActorRow(ctx, {
        actorType: 'counter',
        name: 'a',
      })

      await kickMailbox(ctx, {
        actorId: actor._id,
        deliverAt: T0 - 2 * YEAR, // wildly in the past
        drainFn,
      })

      const after = (await getMailboxRow(ctx, actor._id))!
      assert(after.drain.kind === 'scheduled')
      expect(after.drain.at).toBe(T0) // clamped to now
      const scheduled = await ctx.db.system.get(after.drain.scheduledId)
      assert(scheduled)
      expect(scheduled.scheduledTime).toBe(T0)
    })
  })

  test('deliverAt far in the future is clamped to one year out', async () => {
    const t = convexTest(schema, modules)
    await t.run(async (ctx) => {
      const drainFn = await makeDrainHandle()
      const { actor } = await getOrCreateActorRow(ctx, {
        actorType: 'counter',
        name: 'a',
      })

      await kickMailbox(ctx, {
        actorId: actor._id,
        deliverAt: T0 + 10 * YEAR, // absurdly far future
        drainFn,
      })

      const after = (await getMailboxRow(ctx, actor._id))!
      assert(after.drain.kind === 'scheduled')
      expect(after.drain.at).toBe(T0 + YEAR)
    })
  })

  test('scheduled with earlier kick cancels and reschedules', async () => {
    const t = convexTest(schema, modules)
    await t.run(async (ctx) => {
      const drainFn = await makeDrainHandle()
      const { actor } = await getOrCreateActorRow(ctx, {
        actorType: 'counter',
        name: 'a',
      })
      await kickMailbox(ctx, {
        actorId: actor._id,
        deliverAt: T0 + 5000,
        drainFn,
      })
      const before = (await getMailboxRow(ctx, actor._id))!
      assert(before.drain.kind === 'scheduled')
      const originalScheduledId = before.drain.scheduledId
      expect(before.generation).toBe(0)

      await kickMailbox(ctx, {
        actorId: actor._id,
        deliverAt: T0 + 1000,
        drainFn,
      })

      const after = (await getMailboxRow(ctx, actor._id))!
      // Still 0 — kick never writes generation, even on reschedule.
      // The race between the canceled-but-maybe-fired old drain and
      // the new one is resolved on the drain side: both carry gen=0,
      // whichever commits first bumps state to 1, the other retries
      // under OCC and fails its fence.
      expect(after.generation).toBe(0)
      assert(after.drain.kind === 'scheduled')
      expect(after.drain.at).toBe(T0 + 1000)
      expect(after.drain.scheduledId).not.toBe(originalScheduledId)

      // Old scheduled row was canceled, new one is pending.
      const oldJob = await ctx.db.system.get(originalScheduledId)
      assert(oldJob)
      expect(oldJob.state.kind).toBe('canceled')
      const newJob = await ctx.db.system.get(after.drain.scheduledId)
      assert(newJob)
      expect(newJob.state.kind).toBe('pending')
      expect(newJob.scheduledTime).toBe(T0 + 1000)
      expect(newJob.args[0]).toEqual({ actorId: actor._id, generation: 0 })
    })
  })

  test('running mailbox is untouched', async () => {
    const t = convexTest(schema, modules)
    await t.run(async (ctx) => {
      const drainFn = await makeDrainHandle()
      const { actor, mailbox } = await getOrCreateActorRow(ctx, {
        actorType: 'counter',
        name: 'a',
      })
      // Force the mailbox into running state and bump generation to 42
      // so we can detect any accidental writes.
      await ctx.db.patch(mailbox._id, {
        generation: 42,
        drain: { kind: 'running', startedAt: T0 },
      })
      const before = (await getMailboxRow(ctx, actor._id))!

      await kickMailbox(ctx, {
        actorId: actor._id,
        deliverAt: T0 + 1000,
        drainFn,
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
      const drainFn = await makeDrainHandle()
      const { actor, mailbox } = await getOrCreateActorRow(ctx, {
        actorType: 'counter',
        name: 'a',
      })

      // Simulate a stale schedule: the previous scheduled drain has
      // already completed (state=success) but the mailbox still points
      // at it. Kick with an earlier deliverAt should skip the cancel
      // (system.get shows non-pending) and still schedule a new one.
      const staleScheduledId = await ctx.scheduler.runAt(
        T0 + 10_000,
        drainFn,
        { actorId: actor._id, generation: 1 },
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
        drain: {
          kind: 'scheduled',
          scheduledId: staleScheduledId,
          at: T0 + 10_000,
        },
      })

      await kickMailbox(ctx, {
        actorId: actor._id,
        deliverAt: T0 + 1000,
        drainFn,
      })

      const after = (await getMailboxRow(ctx, actor._id))!
      expect(after.generation).toBe(1)
      assert(after.drain.kind === 'scheduled')
      expect(after.drain.at).toBe(T0 + 1000)
      expect(after.drain.scheduledId).not.toBe(staleScheduledId)

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
      const { actor } = await getOrCreateActorRow(ctx, {
        actorType: 'counter',
        name: 'a',
      })
      return { actorId: actor._id }
    })

    // Fan out 10 concurrent kicks with varying deliverAts.
    await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        t.run(async (ctx) => {
          const drainFn = await makeDrainHandle()
          await kickMailbox(ctx, {
            actorId,
            deliverAt: T0 + 1000 + i * 100,
            drainFn,
          })
        }),
      ),
    )

    await t.run(async (ctx) => {
      const mailbox = (await getMailboxRow(ctx, actorId))!
      assert(mailbox.drain.kind === 'scheduled')
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
      expect(pending[0]._id).toBe(mailbox.drain.scheduledId)
    })
  })
})
