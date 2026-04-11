import { createFileRoute, Link } from '@tanstack/react-router'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { FunctionReturnType } from 'convex/server'
import { api } from '../../../convex/_generated/api'
import {
  useAccount,
  useAuction,
  useDeposit,
  usePlaceBid,
} from '../../lib/auctionsHooks'
import { BIDDERS, type Bidder } from '../../lib/demoUsers'
import { PhaseBadge, formatRemaining, useNowTick } from './-ui'

export const Route = createFileRoute('/auctions/$name')({
  component: AuctionDetail,
})

function AuctionDetail() {
  const { name } = Route.useParams()
  const { data: auction } = useAuction(name)

  return (
    <main className="min-h-screen bg-gray-950 text-gray-100 p-8">
      <div className="max-w-4xl mx-auto flex flex-col gap-6">
        <header>
          <Link
            to="/auctions"
            className="text-sm text-gray-400 hover:text-gray-100"
          >
            ← Lobby
          </Link>
        </header>

        {auction === undefined ? (
          <p className="text-gray-500">Loading…</p>
        ) : auction === null ? (
          <div className="text-center py-20 text-gray-500 border border-gray-800 rounded-lg">
            <p>No auction named </p>
            <p className="font-mono text-gray-300 mt-2">{name}</p>
          </div>
        ) : (
          <AuctionDetailInner name={name} auction={auction} />
        )}
      </div>
    </main>
  )
}

type AuctionProjection = NonNullable<
  FunctionReturnType<typeof api.auctions.getAuction>
>

function AuctionDetailInner({
  name,
  auction,
}: {
  name: string
  auction: AuctionProjection
}) {
  return (
    <>
      <PhaseHeader auction={auction} />
      <div className="grid grid-cols-1 md:grid-cols-[2fr_1fr] gap-6">
        <ItemPanel auction={auction} />
        <CurrentBidPanel auction={auction} />
      </div>
      <BiddersPanel name={name} auction={auction} />
      <BidHistory auction={auction} />
    </>
  )
}

function PhaseHeader({ auction }: { auction: AuctionProjection }) {
  const now = useNowTick()
  const {
    phase,
    phaseStartedAt,
    phaseEndsAt,
    expectedEndAt,
    settlementFailureReason,
  } = auction
  const phaseRemaining =
    phaseEndsAt !== null ? Math.max(0, phaseEndsAt - now) : null

  // Flash "timer extended" only on real snipe events: a late bid
  // during going_once/going_twice resets the auction to going_once
  // with a fresh `phaseStartedAt`. The ordinary `active → going_once`
  // transition *also* advances `phaseStartedAt`, so keying off the
  // previous phase is what distinguishes the two.
  const prev = useRef<{ phase: AuctionProjection['phase']; startedAt: number }>(
    { phase, startedAt: phaseStartedAt },
  )
  const [sniped, setSniped] = useState(false)
  useEffect(() => {
    const wasInGoing =
      prev.current.phase === 'going_once' ||
      prev.current.phase === 'going_twice'
    const isSnipe =
      phase === 'going_once' &&
      wasInGoing &&
      phaseStartedAt > prev.current.startedAt
    prev.current = { phase, startedAt: phaseStartedAt }
    if (isSnipe) {
      setSniped(true)
      const id = setTimeout(() => setSniped(false), 3500)
      return () => clearTimeout(id)
    }
  }, [phase, phaseStartedAt])

  return (
    <section className="border border-gray-800 rounded-lg bg-gray-900 p-5">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-3">
            <PhaseBadge phase={phase} />
            {sniped && (
              <span className="text-xs px-2 py-0.5 rounded bg-amber-900/80 text-amber-200 border border-amber-700 font-mono animate-pulse">
                ⚡ snipe protection — timer extended
              </span>
            )}
          </div>
          {phase === 'settling' && (
            <p className="text-sm text-violet-300">
              Winning bid is being settled by{' '}
              <span className="font-mono">settlementSaga</span>…
            </p>
          )}
          {phase === 'sold' && (
            <p className="text-sm text-blue-300">
              Sold to{' '}
              <span className="font-mono">
                {auction.currentBid?.bidder ?? '—'}
              </span>{' '}
              for ${auction.currentBid?.amount}
            </p>
          )}
          {phase === 'expired' && (
            <p className="text-sm text-gray-400">
              Expired — no bids placed.
            </p>
          )}
          {phase === 'settlement_failed' && (
            <p className="text-sm text-red-300">
              Settlement failed: {settlementFailureReason ?? 'unknown reason'}.
              The winner has been refunded.
            </p>
          )}
        </div>
        {phaseRemaining !== null && (
          <div className="text-right">
            <p className="text-xs text-gray-500 uppercase tracking-wide">
              This phase ends in
            </p>
            <p
              className={`text-4xl font-bold tabular-nums ${
                phase === 'going_twice'
                  ? 'text-red-300'
                  : phase === 'going_once'
                  ? 'text-amber-300'
                  : 'text-gray-100'
              }`}
            >
              {formatRemaining(phaseRemaining)}
            </p>
            {expectedEndAt !== null && expectedEndAt !== phaseEndsAt && (
              <p className="text-[11px] text-gray-500 mt-1">
                projected close{' '}
                {new Date(expectedEndAt).toLocaleTimeString()}
              </p>
            )}
          </div>
        )}
      </div>
    </section>
  )
}

function ItemPanel({ auction }: { auction: AuctionProjection }) {
  return (
    <section className="border border-gray-800 rounded-lg bg-gray-900 overflow-hidden">
      <div className="aspect-[16/9] bg-gray-950">
        {auction.item.imageUrl && (
          <img
            src={auction.item.imageUrl}
            alt={auction.item.title}
            className="w-full h-full object-cover"
          />
        )}
      </div>
      <div className="p-5 flex flex-col gap-2">
        <h1 className="text-2xl font-bold">{auction.item.title}</h1>
        <p className="text-sm text-gray-400">{auction.item.description}</p>
      </div>
    </section>
  )
}

function CurrentBidPanel({ auction }: { auction: AuctionProjection }) {
  // Terminal phases replace the live "current bid + min next bid" view
  // with a final outcome summary — a live min-next-bid is meaningless
  // once the auction has closed.
  if (auction.phase === 'sold' && auction.currentBid) {
    return (
      <section className="border border-blue-800 rounded-lg bg-blue-950/30 p-5 flex flex-col gap-2">
        <p className="text-xs text-blue-300 uppercase tracking-wide">
          Sold
        </p>
        <p className="text-3xl font-bold tabular-nums">
          ${auction.currentBid.amount}
        </p>
        <p className="text-xs text-gray-400 font-mono">
          winner{' '}
          <span className="text-blue-200">{auction.currentBid.bidder}</span>
        </p>
        <p className="text-[11px] text-gray-500 mt-1">
          Funds settled — {auction.previousBids.length} losing bid
          {auction.previousBids.length === 1 ? '' : 's'} refunded.
        </p>
      </section>
    )
  }

  if (auction.phase === 'expired') {
    return (
      <section className="border border-gray-800 rounded-lg bg-gray-900 p-5 flex flex-col gap-2">
        <p className="text-xs text-gray-500 uppercase tracking-wide">
          Expired
        </p>
        <p className="text-xl text-gray-500">No bids placed</p>
        <p className="text-[11px] text-gray-600 mt-1">
          Starting price was ${auction.startingPrice}.
        </p>
      </section>
    )
  }

  if (auction.phase === 'settlement_failed') {
    return (
      <section className="border border-red-800 rounded-lg bg-red-950/30 p-5 flex flex-col gap-2">
        <p className="text-xs text-red-300 uppercase tracking-wide">
          Settlement failed
        </p>
        {auction.currentBid && (
          <>
            <p className="text-2xl font-bold tabular-nums text-red-200">
              ${auction.currentBid.amount}
            </p>
            <p className="text-xs text-gray-400 font-mono">
              would-be winner{' '}
              <span className="text-red-200">{auction.currentBid.bidder}</span>{' '}
              — refunded
            </p>
          </>
        )}
        {auction.settlementFailureReason && (
          <p className="text-[11px] text-red-300/80 font-mono mt-1">
            {auction.settlementFailureReason}
          </p>
        )}
      </section>
    )
  }

  if (auction.phase === 'settling') {
    return (
      <section className="border border-violet-800 rounded-lg bg-violet-950/30 p-5 flex flex-col gap-2">
        <p className="text-xs text-violet-300 uppercase tracking-wide">
          Settling
        </p>
        {auction.currentBid && (
          <>
            <p className="text-3xl font-bold tabular-nums">
              ${auction.currentBid.amount}
            </p>
            <p className="text-xs text-gray-400 font-mono">
              winning bidder{' '}
              <span className="text-violet-200">
                {auction.currentBid.bidder}
              </span>
            </p>
          </>
        )}
        <p className="text-[11px] text-violet-300/70 font-mono mt-1">
          settlementSaga running…
        </p>
      </section>
    )
  }

  // Live phases: initializing / active / going_once / going_twice.
  return (
    <section className="border border-gray-800 rounded-lg bg-gray-900 p-5 flex flex-col gap-3">
      <div>
        <p className="text-xs text-gray-500 uppercase tracking-wide">
          Current bid
        </p>
        {auction.currentBid ? (
          <>
            <p className="text-3xl font-bold tabular-nums mt-1">
              ${auction.currentBid.amount}
            </p>
            <p className="text-xs text-gray-500 font-mono mt-1">
              by {auction.currentBid.bidder}
            </p>
          </>
        ) : (
          <p className="text-xl text-gray-600 mt-1">No bids yet</p>
        )}
      </div>
      <div className="border-t border-gray-800 pt-3">
        <p className="text-xs text-gray-500 uppercase tracking-wide">
          Min next bid
        </p>
        <p className="text-lg font-bold tabular-nums text-emerald-300">
          ${auction.minNextBid}
        </p>
        <p className="text-[11px] text-gray-600 font-mono mt-0.5">
          {auction.currentBid
            ? `current + $${auction.minIncrement}`
            : `starting price $${auction.startingPrice}`}
        </p>
      </div>
    </section>
  )
}

const DEPOSIT_INCREMENT = 100

function BiddersPanel({
  name,
  auction,
}: {
  name: string
  auction: AuctionProjection
}) {
  const biddable =
    auction.phase === 'active' ||
    auction.phase === 'going_once' ||
    auction.phase === 'going_twice'

  return (
    <section className="flex flex-col gap-3">
      <div>
        <h2 className="font-semibold text-sm text-gray-300">Bidders</h2>
        <p className="text-xs text-gray-500 mt-0.5">
          Each participant is a separate account actor. Deposit funds, then
          place a bid — all three can run concurrently against this auction.
        </p>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {BIDDERS.map((bidder) => (
          <BidderCard
            key={bidder}
            bidder={bidder}
            auctionName={name}
            auction={auction}
            biddable={biddable}
          />
        ))}
      </div>
    </section>
  )
}

function BidderCard({
  bidder,
  auctionName,
  auction,
  biddable,
}: {
  bidder: Bidder
  auctionName: string
  auction: AuctionProjection
  biddable: boolean
}) {
  const { data: account } = useAccount(bidder)
  const deposit = useDeposit()
  const bid = usePlaceBid()

  const [bidAmount, setBidAmount] = useState<number>(auction.minNextBid)

  // Track the server-side min bid and pull the card's input up to it
  // whenever it advances — unless the viewer has already typed in
  // something higher than the new minimum.
  const lastMin = useRef(auction.minNextBid)
  useEffect(() => {
    if (auction.minNextBid !== lastMin.current) {
      lastMin.current = auction.minNextBid
      setBidAmount((prev) =>
        prev < auction.minNextBid ? auction.minNextBid : prev,
      )
    }
  }, [auction.minNextBid])

  const balance = account?.balance ?? 0
  const available = account?.availableBalance ?? 0
  const onHold = balance - available
  const isWinning = auction.currentBid?.bidder === bidder
  const belowMin = bidAmount < auction.minNextBid

  const bidBusy = bid.isPending
  const depositBusy = deposit.isPending

  const bidMessage = bid.isPending
    ? { tone: 'muted', text: 'placing bid…' }
    : bid.isError
      ? { tone: 'bad', text: bid.error.message }
      : bid.data?.ok
        ? { tone: 'good', text: 'bid accepted ✓' }
        : bid.data
          ? { tone: 'warn', text: `bid failed: ${bid.data.reason}` }
          : null

  return (
    <div
      className={`border rounded-lg bg-gray-900 p-4 flex flex-col gap-3 ${
        isWinning ? 'border-emerald-700' : 'border-gray-800'
      }`}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="font-mono text-base text-gray-100">{bidder}</span>
        {isWinning && (
          <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-emerald-900 text-emerald-300 border border-emerald-800 font-mono">
            leading
          </span>
        )}
      </div>

      <div className="flex items-baseline justify-between gap-2 font-mono text-xs border-y border-gray-800 py-2">
        <div>
          <span className="text-gray-500 uppercase tracking-wider text-[10px] block">
            Avail
          </span>
          <span className="text-emerald-300 tabular-nums text-sm">
            ${available}
          </span>
        </div>
        <div>
          <span className="text-gray-500 uppercase tracking-wider text-[10px] block">
            Held
          </span>
          <span
            className={`tabular-nums text-sm ${
              onHold > 0 ? 'text-amber-300' : 'text-gray-600'
            }`}
          >
            ${onHold}
          </span>
        </div>
        {account === null && (
          <span className="text-gray-600 italic">no account</span>
        )}
      </div>

      <button
        disabled={depositBusy}
        onClick={() =>
          void deposit.mutate({ user: bidder, amount: DEPOSIT_INCREMENT })
        }
        className="px-3 py-1.5 bg-gray-800 hover:bg-gray-700 border border-gray-700 disabled:opacity-50 rounded text-xs font-medium transition-colors"
      >
        {depositBusy ? 'Depositing…' : `+ $${DEPOSIT_INCREMENT} deposit`}
      </button>

      <div className="flex flex-col gap-1.5">
        <label className="text-[10px] uppercase tracking-wider text-gray-500">
          Bid amount{' '}
          <span className="text-gray-600 normal-case">
            (min ${auction.minNextBid})
          </span>
        </label>
        <div className="flex items-center gap-1.5">
          <span className="text-gray-500 text-sm">$</span>
          <input
            type="number"
            value={bidAmount}
            onChange={(e) =>
              setBidAmount(Math.max(0, Number(e.target.value) || 0))
            }
            disabled={!biddable}
            className={`flex-1 bg-gray-950 border rounded px-2 py-1.5 text-sm tabular-nums disabled:opacity-50 min-w-0 ${
              belowMin && biddable ? 'border-amber-700' : 'border-gray-700'
            }`}
            min={0}
          />
        </div>
        <button
          disabled={!biddable || bidBusy || bidAmount <= 0 || belowMin}
          onClick={() =>
            void bid.mutate({ user: bidder, auctionName, amount: bidAmount })
          }
          className="mt-1 px-3 py-2 bg-emerald-700 hover:bg-emerald-600 disabled:opacity-50 rounded text-sm font-medium transition-colors"
        >
          {bidBusy ? 'Bidding…' : `Bid $${bidAmount}`}
        </button>
      </div>

      {bidMessage && (
        <p
          className={`text-xs font-mono ${
            bidMessage.tone === 'good'
              ? 'text-emerald-400'
              : bidMessage.tone === 'warn'
                ? 'text-amber-400'
                : bidMessage.tone === 'bad'
                  ? 'text-red-400'
                  : 'text-gray-500 italic'
          }`}
        >
          {bidMessage.text}
        </p>
      )}
      {deposit.isError && (
        <p className="text-xs font-mono text-red-400">
          deposit: {deposit.error.message}
        </p>
      )}
    </div>
  )
}

function BidHistory({ auction }: { auction: AuctionProjection }) {
  const all = useMemo(() => {
    const rows = auction.previousBids.map((p) => ({ ...p, current: false }))
    if (auction.currentBid) {
      // currentBid projection lacks ts — piggyback on phaseStartedAt as a
      // rough "when" for display purposes.
      rows.push({
        bidder: auction.currentBid.bidder,
        amount: auction.currentBid.amount,
        ts: auction.phaseStartedAt,
        current: true,
      })
    }
    return rows.reverse()
  }, [auction])

  if (all.length === 0) return null

  return (
    <section className="border border-gray-800 rounded-lg bg-gray-900">
      <div className="px-5 py-3 border-b border-gray-800">
        <h2 className="font-semibold text-sm text-gray-300">Bid history</h2>
      </div>
      <ul className="divide-y divide-gray-800">
        {all.map((row, i) => (
          <li
            key={`${row.ts}-${i}`}
            className={`px-5 py-3 flex items-center justify-between ${
              row.current ? 'bg-emerald-950/30' : ''
            }`}
          >
            <div className="flex items-center gap-3">
              <span className="font-mono text-sm text-gray-300">
                {row.bidder}
              </span>
              {row.current && (
                <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-emerald-900 text-emerald-300 border border-emerald-800 font-mono">
                  leading
                </span>
              )}
            </div>
            <div className="flex items-center gap-4">
              <span className="text-xs text-gray-500 font-mono">
                {new Date(row.ts).toLocaleTimeString()}
              </span>
              <span className="font-bold tabular-nums">${row.amount}</span>
            </div>
          </li>
        ))}
      </ul>
    </section>
  )
}
