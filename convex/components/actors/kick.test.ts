/// <reference types="vite/client" />
import { convexTest } from 'convex-test'
import { createFunctionHandle } from 'convex/server'
import { afterEach, assert, beforeEach, describe, expect, test, vi } from 'vitest'
import { getOrCreateActorRow, getSignalRow, getBookkeepingRow } from './actors.js'
import { api } from './_generated/api.js'
import { kickMailbox } from './kick.js'
import schema from './schema.js'
import { KICK_EPSILON_MS, YEAR } from './shared.js'

const modules = import.meta.glob('./**/*.ts')

const T0 = 1_700_000_000_000

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(T0)
})
afterEach(() => {
  vi.useRealTimers()
})

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
      const { actor } = await getOrCreateActorRow(ctx, {
        actorType: 'counter',
        name: 'a',
        executeFn,
      })
      const signal = (await getSignalRow(ctx, actor._id))!
      expect(signal.generation).toBe(0)
      expect(signal.drainKind).toBe('idle')

      const deliverAt = T0 + 1000
      await kickMailbox(ctx, { actorId: actor._id, deliverAt, executeFn })

      const afterSignal = (await getSignalRow(ctx, actor._id))!
      expect(afterSignal.generation).toBe(0)
      assert(afterSignal.drainKind === 'scheduled')

      const afterBk = (await getBookkeepingRow(ctx, actor._id))!
      expect(afterBk.drainAt).toBe(deliverAt)
      expect(afterBk.executeFn).toBe(executeFn)

      const scheduled = await ctx.db.system.get(afterBk.drainScheduledId!)
      assert(scheduled)
      assert('state' in scheduled)
      expect(scheduled.state.kind).toBe('pending')
      expect(scheduled.scheduledTime).toBe(deliverAt)
      expect(scheduled.args[0]).toEqual({
        actorId: actor._id,
        generation: 0,
        executeFn,
        cursorTs: deliverAt,
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
      await kickMailbox(ctx, {
        actorId: actor._id,
        deliverAt: T0 + 1000,
        executeFn,
      })
      const beforeSignal = (await getSignalRow(ctx, actor._id))!
      const beforeBk = (await getBookkeepingRow(ctx, actor._id))!
      assert(beforeSignal.drainKind === 'scheduled')
      const originalScheduledId = beforeBk.drainScheduledId

      await kickMailbox(ctx, {
        actorId: actor._id,
        deliverAt: T0 + 5000,
        executeFn,
      })
      const afterSignal = (await getSignalRow(ctx, actor._id))!
      const afterBk = (await getBookkeepingRow(ctx, actor._id))!
      expect(afterSignal.generation).toBe(beforeSignal.generation)
      assert(afterSignal.drainKind === 'scheduled')
      expect(afterBk.drainScheduledId).toBe(originalScheduledId)
      expect(afterBk.drainAt).toBe(T0 + 1000)

      const allScheduled = await ctx.db.system
        .query('_scheduled_functions')
        .collect()
      expect(allScheduled).toHaveLength(1)
    })
  })

  test('bring-forward within KICK_EPSILON_MS is a no-op', async () => {
    const t = convexTest(schema, modules)
    await t.run(async (ctx) => {
      const executeFn = await makeExecuteHandle()
      const { actor } = await getOrCreateActorRow(ctx, {
        actorType: 'counter',
        name: 'a',
        executeFn,
      })
      const originalAt = T0 + KICK_EPSILON_MS - 1
      await kickMailbox(ctx, {
        actorId: actor._id,
        deliverAt: originalAt,
        executeFn,
      })
      const beforeBk = (await getBookkeepingRow(ctx, actor._id))!
      const originalScheduledId = beforeBk.drainScheduledId

      await kickMailbox(ctx, {
        actorId: actor._id,
        deliverAt: T0,
        executeFn,
      })

      const afterSignal = (await getSignalRow(ctx, actor._id))!
      const afterBk = (await getBookkeepingRow(ctx, actor._id))!
      assert(afterSignal.drainKind === 'scheduled')
      expect(afterBk.drainScheduledId).toBe(originalScheduledId)
      expect(afterBk.drainAt).toBe(originalAt)

      const allScheduled = await ctx.db.system
        .query('_scheduled_functions')
        .collect()
      expect(allScheduled).toHaveLength(1)
      expect(allScheduled[0].state.kind).toBe('pending')
    })
  })

  test('bring-forward just past KICK_EPSILON_MS does reschedule', async () => {
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
      const beforeBk = (await getBookkeepingRow(ctx, actor._id))!
      const originalScheduledId = beforeBk.drainScheduledId

      await kickMailbox(ctx, {
        actorId: actor._id,
        deliverAt: T0,
        executeFn,
      })

      const afterSignal = (await getSignalRow(ctx, actor._id))!
      const afterBk = (await getBookkeepingRow(ctx, actor._id))!
      assert(afterSignal.drainKind === 'scheduled')
      expect(afterBk.drainScheduledId).not.toBe(originalScheduledId)
      expect(afterBk.drainAt).toBe(T0)
    })
  })

  test('deliverAt far in the past is clamped to now', async () => {
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
        deliverAt: T0 - 2 * YEAR,
        executeFn,
      })

      const afterSignal = (await getSignalRow(ctx, actor._id))!
      const afterBk = (await getBookkeepingRow(ctx, actor._id))!
      assert(afterSignal.drainKind === 'scheduled')
      expect(afterBk.drainAt).toBe(T0)
      const scheduled = await ctx.db.system.get(afterBk.drainScheduledId!)
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
        deliverAt: T0 + 10 * YEAR,
        executeFn,
      })

      const afterSignal = (await getSignalRow(ctx, actor._id))!
      const afterBk = (await getBookkeepingRow(ctx, actor._id))!
      assert(afterSignal.drainKind === 'scheduled')
      expect(afterBk.drainAt).toBe(T0 + YEAR)
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
      const beforeSignal = (await getSignalRow(ctx, actor._id))!
      const beforeBk = (await getBookkeepingRow(ctx, actor._id))!
      assert(beforeSignal.drainKind === 'scheduled')
      const originalScheduledId = beforeBk.drainScheduledId
      expect(beforeSignal.generation).toBe(0)

      await kickMailbox(ctx, {
        actorId: actor._id,
        deliverAt: T0 + 1000,
        executeFn,
      })

      const afterSignal = (await getSignalRow(ctx, actor._id))!
      const afterBk = (await getBookkeepingRow(ctx, actor._id))!
      expect(afterSignal.generation).toBe(0)
      assert(afterSignal.drainKind === 'scheduled')
      expect(afterBk.drainAt).toBe(T0 + 1000)
      expect(afterBk.drainScheduledId).not.toBe(originalScheduledId)

      const oldJob = await ctx.db.system.get(originalScheduledId!)
      assert(oldJob && 'state' in oldJob)
      expect(oldJob.state.kind).toBe('canceled')
      const newJob = await ctx.db.system.get(afterBk.drainScheduledId!)
      assert(newJob && 'state' in newJob)
      expect(newJob.state.kind).toBe('pending')
      expect(newJob.scheduledTime).toBe(T0 + 1000)
      expect(newJob.args[0]).toEqual({
        actorId: actor._id,
        generation: 0,
        executeFn,
        cursorTs: T0 + 1000,
      })
    })
  })

  test('running drain is untouched', async () => {
    const t = convexTest(schema, modules)
    await t.run(async (ctx) => {
      const executeFn = await makeExecuteHandle()
      const { actor } = await getOrCreateActorRow(ctx, {
        actorType: 'counter',
        name: 'a',
        executeFn,
      })
      const signal = (await getSignalRow(ctx, actor._id))!
      await ctx.db.patch(signal._id, {
        generation: 42,
        drainKind: 'running',
      })
      const beforeSignal = (await getSignalRow(ctx, actor._id))!

      await kickMailbox(ctx, {
        actorId: actor._id,
        deliverAt: T0 + 1000,
        executeFn,
      })

      const afterSignal = (await getSignalRow(ctx, actor._id))!
      expect(afterSignal).toEqual(beforeSignal)

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
      const { actor } = await getOrCreateActorRow(ctx, {
        actorType: 'counter',
        name: 'a',
        executeFn,
      })
      const signal = (await getSignalRow(ctx, actor._id))!
      const bookkeeping = (await getBookkeepingRow(ctx, actor._id))!

      const staleScheduledId = await ctx.scheduler.runAt(
        T0 + 10_000,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        executeFn as any,
        { actorId: actor._id, generation: 1, executeFn },
      )
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (ctx.db as any).patch(staleScheduledId, {
        state: { kind: 'success' },
      })
      await ctx.db.patch(signal._id, {
        generation: 1,
        drainKind: 'scheduled',
      })
      await ctx.db.patch(bookkeeping._id, {
        drainScheduledId: staleScheduledId,
        drainAt: T0 + 10_000,
      })

      await kickMailbox(ctx, {
        actorId: actor._id,
        deliverAt: T0 + 1000,
        executeFn,
      })

      const afterSignal = (await getSignalRow(ctx, actor._id))!
      const afterBk = (await getBookkeepingRow(ctx, actor._id))!
      expect(afterSignal.generation).toBe(1)
      assert(afterSignal.drainKind === 'scheduled')
      expect(afterBk.drainAt).toBe(T0 + 1000)
      expect(afterBk.drainScheduledId).not.toBe(staleScheduledId)

      const staleJob = await ctx.db.system.get(staleScheduledId)
      assert(staleJob)
      expect(staleJob.state.kind).toBe('success')
    })
  })

  test('concurrent kicks converge to a single scheduled state', async () => {
    const t = convexTest(schema, modules)
    const { actorId } = await t.run(async (ctx) => {
      const executeFn = await makeExecuteHandle()
      const { actor } = await getOrCreateActorRow(ctx, {
        actorType: 'counter',
        name: 'a',
        executeFn,
      })
      return { actorId: actor._id }
    })

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
      const signal = (await getSignalRow(ctx, actorId))!
      assert(signal.drainKind === 'scheduled')
      expect(signal.generation).toBe(0)

      const scheduled = await ctx.db.system
        .query('_scheduled_functions')
        .collect()
      const pending = scheduled.filter((s) => s.state.kind === 'pending')
      expect(pending).toHaveLength(1)
      const bk = (await getBookkeepingRow(ctx, actorId))!
      expect(pending[0]._id).toBe(bk.drainScheduledId)
    })
  })
})
