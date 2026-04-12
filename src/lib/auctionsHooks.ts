/**
 * App-specific hooks over `api.auctions.*`. Mutations are *single*
 * tanstack-query mutations that cover the full fire-then-wait-for-outcome
 * flow: the inner `mutationFn` awaits the response row (or the saga's
 * terminal phase), so `isPending` stays true until the whole chain
 * resolves.
 *
 * Domain outcomes (placeBid fail, createAuction fail) are returned as
 * `{ ok: false, reason }` in `data`, so tanstack's `isSuccess` means
 * "the server answered" and `isError` is reserved for infra failures
 * (transport, actor defect). Callers pattern-match on `data.ok`.
 */
import { convexQuery } from '@convex-dev/react-query'
import { useQuery, useMutation as useTQMutation } from '@tanstack/react-query'
import { useConvex } from 'convex/react'
import type { FunctionArgs } from 'convex/server'
import { api } from '../../convex/_generated/api'
import {
  createResponseAwaiter,
  createSagaAwaiter,
} from '../../convex/components/actors/client/react'
// Actor definitions are imported type-only — `createResponseAwaiter`'s
// generics only need their inferred types, so handler code (which may
// transitively reference server-only modules) never bundles into the
// client.
import type { account, auctionHouse } from '../../convex/actors'

// Module-level awaiter bound to this app's public getResponse query.
// Call per message as `awaitMessageResponse<typeof actor, 'msgName'>(convex, id)`.
const awaitMessageResponse = createResponseAwaiter(api.auctions.getResponse)

// Module-level saga awaiter for bidSaga. Used inside `usePlaceBid`'s
// mutationFn to block on the saga's terminal phase; step-level progress
// for already-placed bids comes from `useBidStatus` below, which is a
// plain `useQuery` wrapper (no factory needed — the saga's step-name
// narrowing already flows through `system.peek` → query return type).
const awaitBidSagaTerminal = createSagaAwaiter(api.auctions.getBidStatus)

// ── Tier 1: query wrappers ─────────────────────────────────────────

/** Lobby listing + stuck-settlement alerts. */
export function useAuctionsList() {
  return useQuery(convexQuery(api.auctions.list, {}))
}

/** A single auction's projection. `undefined` while loading, `null` if missing. */
export function useAuction(name: string) {
  return useQuery(convexQuery(api.auctions.getAuction, { name }))
}

/** An account's projection. `null` if the account hasn't been touched yet. */
export function useAccount(user: string) {
  return useQuery(convexQuery(api.auctions.getAccount, { user }))
}

/** A user's bid index. */
export function useUserBids(user: string) {
  return useQuery(convexQuery(api.auctions.listUserBids, { user }))
}

/**
 * Peek a bidSaga by idempotency key. Pass `null` to disable. Mostly
 * useful for the account page's bid-history rows — the write hooks
 * await saga terminals internally.
 */
export function useBidStatus(idempotencyKey: string | null) {
  return useQuery({
    ...convexQuery(api.auctions.getBidStatus, {
      idempotencyKey: idempotencyKey ?? '',
    }),
    enabled: idempotencyKey !== null,
  })
}

// ── Tier 2: mutation hooks ─────────────────────────────────────────

/**
 * Place a bid. The mutationFn RPCs `auctions.placeBid` then awaits
 * the bidSaga's terminal phase, so `isPending` stays true for the
 * whole lifecycle. `data.ok === false` carries the server fail reason;
 * `isError` is reserved for transport/infra blow-ups.
 */
export function usePlaceBid() {
  const convex = useConvex()
  return useTQMutation({
    mutationFn: async (args: {
      user: string
      auctionName: string
      amount: number
    }) => {
      const idempotencyKey = makeKey('bid', args.user)
      await convex.mutation(api.auctions.placeBid, { ...args, idempotencyKey })
      const saga = await awaitBidSagaTerminal(convex, { idempotencyKey })
      return saga.phase === 'completed'
        ? ({ ok: true } as const)
        : ({ ok: false, reason: saga.failReason ?? 'unknown' } as const)
    },
  })
}

/**
 * Create an auction. Awaits the response row and unwraps the
 * supervisor-allocated name. `data.ok === true` carries the name;
 * actor defects are thrown (infra-level from the caller's view).
 */
export function useCreateAuction() {
  const convex = useConvex()
  return useTQMutation({
    mutationFn: async (
      args: FunctionArgs<typeof api.auctions.createAuction>,
    ) => {
      const messageId = await convex.mutation(api.auctions.createAuction, args)
      const row = await awaitMessageResponse<
        typeof auctionHouse,
        'createAuction'
      >(convex, messageId)
      if (row.response.kind === 'success') {
        return { ok: true, name: row.response.value.auctionName } as const
      }
      if (row.response.kind === 'fail') {
        return { ok: false, reason: row.response.reason } as const
      }
      throw new Error(
        `createAuction defected after ${row.response.attempts} attempts: ${row.response.error}`,
      )
    },
  })
}

/**
 * Deposit funds. Awaits the account actor's response row so
 * `isPending` stays true until the balance has actually been applied.
 */
export function useDeposit() {
  const convex = useConvex()
  return useTQMutation({
    mutationFn: async (args: { user: string; amount: number }) => {
      const messageId = await convex.mutation(api.auctions.deposit, args)
      const row = await awaitMessageResponse<typeof account, 'deposit'>(
        convex,
        messageId,
      )
      if (row.response.kind === 'success') return
      if (row.response.kind === 'fail') {
        throw new Error(`deposit failed: ${row.response.reason}`)
      }
      throw new Error(
        `deposit defected after ${row.response.attempts} attempts: ${row.response.error}`,
      )
    },
  })
}

// ── internals ──────────────────────────────────────────────────────

function makeKey(prefix: string, user: string): string {
  const rand = Math.random().toString(36).slice(2, 8)
  return `${prefix}-${user}-${Date.now()}-${rand}`
}
