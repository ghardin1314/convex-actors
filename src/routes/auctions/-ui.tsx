/**
 * Shared UI bits for the auction routes. File is prefixed with `-` so
 * TanStack Router excludes it from the route tree.
 */
import { useEffect, useState } from 'react'

export type AuctionPhase =
  | 'initializing'
  | 'active'
  | 'going_once'
  | 'going_twice'
  | 'settling'
  | 'sold'
  | 'expired'
  | 'settlement_failed'

const PHASE_STYLES: Record<AuctionPhase, { label: string; className: string }> =
  {
    initializing: {
      label: 'init',
      className: 'bg-gray-800 text-gray-400 border-gray-700',
    },
    active: {
      label: 'active',
      className: 'bg-emerald-950 text-emerald-300 border-emerald-800',
    },
    going_once: {
      label: 'going once',
      className: 'bg-amber-950 text-amber-300 border-amber-700 animate-pulse',
    },
    going_twice: {
      label: 'going twice',
      className: 'bg-red-950 text-red-300 border-red-700 animate-pulse',
    },
    settling: {
      label: 'settling',
      className: 'bg-violet-950 text-violet-300 border-violet-700',
    },
    sold: {
      label: 'sold',
      className: 'bg-blue-950 text-blue-300 border-blue-700',
    },
    expired: {
      label: 'expired',
      className: 'bg-gray-900 text-gray-500 border-gray-700',
    },
    settlement_failed: {
      label: 'settlement failed',
      className: 'bg-red-950 text-red-300 border-red-700',
    },
  }

export function PhaseBadge({ phase }: { phase: AuctionPhase }) {
  const { label, className } = PHASE_STYLES[phase]
  return (
    <span
      className={`text-[10px] uppercase tracking-wider px-2 py-0.5 rounded border ${className} font-mono whitespace-nowrap`}
    >
      {label}
    </span>
  )
}

/**
 * Clock that re-renders every 500ms so countdowns look live without
 * hammering Convex. Returns the current millisecond time.
 */
export function useNowTick(intervalMs = 500): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(id)
  }, [intervalMs])
  return now
}

export function formatRemaining(ms: number): string {
  if (ms <= 0) return '00:00'
  const totalSec = Math.ceil(ms / 1000)
  const m = Math.floor(totalSec / 60)
  const s = totalSec % 60
  return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`
}

export function CountdownDisplay({
  endsAt,
  phase,
}: {
  endsAt: number
  phase: AuctionPhase
}) {
  const now = useNowTick()
  if (
    phase === 'sold' ||
    phase === 'expired' ||
    phase === 'settlement_failed' ||
    phase === 'settling' ||
    endsAt === 0
  ) {
    return <span className="text-gray-600 text-xs">—</span>
  }
  const remaining = endsAt - now
  const urgent = phase === 'going_once' || phase === 'going_twice'
  return (
    <div className="text-right">
      <p className="text-xs text-gray-500 uppercase tracking-wide">
        Ends in
      </p>
      <p
        className={`text-lg font-bold tabular-nums ${
          urgent ? 'text-amber-300' : 'text-gray-100'
        }`}
      >
        {formatRemaining(remaining)}
      </p>
    </div>
  )
}

