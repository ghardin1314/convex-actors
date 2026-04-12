import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { useState } from 'react'
import { useAuctionsList, useCreateAuction } from '../lib/auctionsHooks'
import { SELLER } from '../lib/demoUsers'
import { PhaseBadge, CountdownDisplay } from './auctions/-ui'

export const Route = createFileRoute('/')({
  component: AuctionLobby,
})

function AuctionLobby() {
  const { data } = useAuctionsList()
  const listings = data?.listings ?? []
  const stuckAlerts = data?.stuckAlerts ?? []

  return (
    <main className="min-h-screen bg-gray-950 text-gray-100 p-8">
      <div className="max-w-5xl mx-auto flex flex-col gap-8">
        <header>
          <h1 className="text-3xl font-bold">Auction Lobby</h1>
          <p className="text-gray-400 mt-1">
            {data?.count ?? 0} auction{(data?.count ?? 0) === 1 ? '' : 's'}{' '}
            tracked by the supervisor — all listed by{' '}
            <span className="font-mono text-gray-300">{SELLER}</span>
          </p>
        </header>

        {stuckAlerts.length > 0 && (
          <div className="border border-amber-700 bg-amber-950/40 rounded-lg p-4">
            <p className="text-amber-300 font-semibold text-sm mb-1">
              ⚠ Stuck settlements
            </p>
            <ul className="text-xs text-amber-200/80 font-mono flex flex-col gap-0.5">
              {stuckAlerts.map((a, i) => (
                <li key={`${a.auctionName}-${i}`}>
                  {a.auctionName} — {a.reason} (
                  {new Date(a.ts).toLocaleTimeString()})
                </li>
              ))}
            </ul>
          </div>
        )}

        <CreateAuctionForm />

        {listings.length === 0 ? (
          <div className="text-center text-gray-500 py-20 border border-gray-800 rounded-lg">
            No auctions yet. Create one above.
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {listings.map((l) => (
              <AuctionCard key={l.name} listing={l} />
            ))}
          </div>
        )}
      </div>
    </main>
  )
}

function CreateAuctionForm() {
  const create = useCreateAuction()
  const navigate = useNavigate()
  const [title, setTitle] = useState('Rare Coin')
  const [description, setDescription] = useState(
    'A one-of-a-kind collectible from 1892.',
  )
  const [imageUrl, setImageUrl] = useState(
    'https://placehold.co/400x300/1e293b/e2e8f0?text=Item',
  )
  const [startingPrice, setStartingPrice] = useState(10)

  const onCreate = () =>
    create.mutate(
      {
        user: SELLER,
        item: { title, description, imageUrl },
        startingPrice,
        config: {
          durationMs: 30_000,
          goingOnceMs: 10_000,
          goingTwiceMs: 5_000,
          minIncrement: 1,
        },
      },
      {
        onSuccess: (data) => {
          if (data.ok) {
            void navigate({
              to: '/auctions/$name',
              params: { name: data.name },
            })
          }
        },
      },
    )

  const busy = create.isPending
  const errorMessage = create.isError
    ? create.error.message
    : create.data && !create.data.ok
      ? create.data.reason
      : null

  return (
    <details className="border border-gray-800 rounded-lg bg-gray-900">
      <summary className="px-4 py-3 cursor-pointer font-semibold text-emerald-400 hover:text-emerald-300">
        + Create auction
      </summary>
      <div className="p-4 pt-0 flex flex-col gap-3">
        <div className="flex flex-col gap-1">
          <label className="text-xs uppercase tracking-wide text-gray-500">
            Title
          </label>
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            className="bg-gray-950 border border-gray-700 rounded px-3 py-2 text-sm"
          />
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-xs uppercase tracking-wide text-gray-500">
            Description
          </label>
          <input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            className="bg-gray-950 border border-gray-700 rounded px-3 py-2 text-sm"
          />
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-xs uppercase tracking-wide text-gray-500">
            Image URL
          </label>
          <input
            value={imageUrl}
            onChange={(e) => setImageUrl(e.target.value)}
            className="bg-gray-950 border border-gray-700 rounded px-3 py-2 text-sm font-mono"
          />
        </div>
        <div className="flex items-end gap-3">
          <div className="flex flex-col gap-1">
            <label className="text-xs uppercase tracking-wide text-gray-500">
              Starting price
            </label>
            <input
              type="number"
              value={startingPrice}
              onChange={(e) =>
                setStartingPrice(Math.max(0, Number(e.target.value) || 0))
              }
              className="bg-gray-950 border border-gray-700 rounded px-3 py-2 text-sm w-28"
              min={0}
            />
          </div>
          <button
            disabled={busy}
            onClick={onCreate}
            className="px-4 py-2 bg-emerald-700 hover:bg-emerald-600 disabled:opacity-50 rounded text-sm font-medium transition-colors"
          >
            {busy ? 'Creating…' : `List as ${SELLER}`}
          </button>
          {errorMessage && (
            <span className="text-xs text-red-400">{errorMessage}</span>
          )}
        </div>
        <p className="text-xs text-gray-500">
          Durations are compressed: 30s active, 10s going once, 10s going
          twice. Bids during the going-phases trigger snipe protection.
        </p>
      </div>
    </details>
  )
}

type Listing = {
  name: string
  item: { title: string; imageUrl: string }
  seller: string
  phase:
    | 'initializing'
    | 'active'
    | 'going_once'
    | 'going_twice'
    | 'settling'
    | 'sold'
    | 'expired'
    | 'settlement_failed'
  currentBid: { bidder: string; amount: number } | null
  endsAt: number
}

function AuctionCard({ listing }: { listing: Listing }) {
  return (
    <Link
      to="/auctions/$name"
      params={{ name: listing.name }}
      className="border border-gray-800 rounded-lg bg-gray-900 overflow-hidden hover:border-emerald-700 transition-colors flex flex-col"
    >
      <div className="aspect-[4/3] bg-gray-950 overflow-hidden">
        {listing.item.imageUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          (<img
            src={listing.item.imageUrl}
            alt={listing.item.title}
            className="w-full h-full object-cover"
          />)
        ) : (
          <div className="w-full h-full flex items-center justify-center text-gray-600 text-xs">
            no image
          </div>
        )}
      </div>
      <div className="p-4 flex-1 flex flex-col gap-2">
        <div className="flex items-start justify-between gap-2">
          <h3 className="font-semibold text-gray-100 truncate">
            {listing.item.title || listing.name}
          </h3>
          <PhaseBadge phase={listing.phase} />
        </div>
        <p className="text-xs text-gray-500 font-mono">
          seller: {listing.seller}
        </p>
        <div className="flex items-baseline justify-between mt-auto pt-2">
          <div>
            <p className="text-xs text-gray-500 uppercase tracking-wide">
              Current bid
            </p>
            {listing.currentBid ? (
              <p className="text-lg font-bold tabular-nums">
                ${listing.currentBid.amount}
                <span className="text-xs text-gray-500 font-normal ml-2">
                  {listing.currentBid.bidder}
                </span>
              </p>
            ) : (
              <p className="text-gray-600 text-sm">—</p>
            )}
          </div>
          <CountdownDisplay endsAt={listing.endsAt} phase={listing.phase} />
        </div>
      </div>
    </Link>
  )
}
