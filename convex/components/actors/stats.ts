import type { Id } from './_generated/dataModel.js'
import type { Logger } from './logging.js'

export function recordEnqueued(
  logger: Logger,
  data: {
    actorType: string
    name: string
    msgType: string
    messageId: Id<'messages'>
    deliverAt: number
  },
) {
  logger.event('enqueued', {
    ...data,
    enqueuedAt: Date.now(),
  })
}

export function recordStarted(
  logger: Logger,
  data: {
    actorType: string
    name: string
    msgType: string
    messageId: Id<'messages'>
    attempts: number
    lagMs: number
  },
) {
  logger.event('started', {
    ...data,
    startedAt: Date.now(),
  })
}

export function recordCompleted(
  logger: Logger,
  data: {
    actorType: string
    name: string
    msgType: string
    messageId: Id<'messages'>
    outcome: 'success' | 'fail' | 'defect'
    attempts: number
  },
) {
  logger.event('completed', {
    ...data,
    completedAt: Date.now(),
  })
}

export function recordRecovered(
  logger: Logger,
  data: {
    actorId: Id<'actor'>
    stuckDurationMs: number
  },
) {
  logger.event('recovered', {
    ...data,
    recoveredAt: Date.now(),
  })
}
