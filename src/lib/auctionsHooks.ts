/**
 * App-specific hooks over `api.auctions.*`. The routes never call
 * `convexQuery` or `useMutation` directly — they go through these so
 * that:
 *
 *   - The `{ data }` → `data ?? fallback` boilerplate lives in one
 *     place.
 *   - Mutations are *single* tanstack-query mutations that cover the
 *     full fire-then-wait-for-outcome flow. The inner `mutationFn`
 *     awaits the response row (or the saga's terminal phase) via a
 *     one-shot subscription, so `isPending` stays true until the
 *     whole chain resolves and `data` / `error` reflect the final
 *     answer. Callers never think about "which query do I poll?".
 *
 * The saga-vs-response distinction matters for *how* the mutationFn
 * waits (peek the saga's phase vs. read the response row), but from
 * the caller's perspective the three write hooks all have identical
 * shape.
 */
import { convexQuery } from '@convex-dev/react-query'
import { useQuery, useMutation as useTQMutation } from '@tanstack/react-query'
import type { ConvexReactClient } from 'convex/react'
import { useConvex } from 'convex/react'
import type {
  FunctionArgs,
  FunctionReference,
  FunctionReturnType,
} from 'convex/server'
import { useMemo } from 'react'
import { api } from '../../convex/_generated/api'
import { createResponseAwaiter } from '../../convex/components/actors/client/react'
// Actor definitions are imported type-only — `createResponseAwaiter`'s
// generics only need their inferred types, so handler code (which may
// transitively reference server-only modules) never bundles into the
// client.
import type { auctionHouse } from '../../convex/auctionHouse'

// Module-level awaiter bound to this app's public getResponse query.
// Call per message as `awaitMessageResponse<typeof actor, 'msgName'>(convex, id)`.
const awaitMessageResponse = createResponseAwaiter(api.auctions.getResponse)

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

// ── Mutation primitive: "await until predicate" on a reactive query ──

/**
 * Subscribe to a Convex query and resolve once its result matches
 * `predicate`. Used inside mutationFns to let a single
 * tanstack-query mutation span "fire the convex mutation + wait for
 * the response row to commit".
 *
 * Cleans up the underlying watch on both success and error paths so
 * the convex client doesn't keep a live subscription after the
 * caller has moved on.
 */
function awaitQueryResult<Query extends FunctionReference<'query'>>(
  convex: ConvexReactClient,
  query: Query,
  args: FunctionArgs<Query>,
  predicate: (value: FunctionReturnType<Query> | undefined) => boolean,
): Promise<FunctionReturnType<Query>> {
  return new Promise((resolve, reject) => {
    const watch = convex.watchQuery(query, args)
    let unsubscribe: (() => void) | null = null
    const check = () => {
      try {
        const value = watch.localQueryResult()
        if (predicate(value)) {
          unsubscribe?.()
          resolve(value as FunctionReturnType<Query>)
        }
      } catch (err) {
        unsubscribe?.()
        reject(err instanceof Error ? err : new Error(String(err)))
      }
    }
    unsubscribe = watch.onUpdate(check)
    // The watch might already have a cached result from an earlier
    // subscription — check immediately so we don't wait for a fresh
    // update that may never come.
    check()
  })
}

// ── Domain error types ────────────────────────────────────────────

/**
 * Domain failure thrown by the mutation hooks when the server
 * reports a business-level "nope" (e.g. `insufficient_funds`,
 * `bid_too_low`). Distinguished from plain `Error` so the UI can
 * tell a user-actionable fail apart from an infra blow-up.
 */
class AuctionFailError extends Error {
  constructor(
    message: string,
    readonly reason: string,
  ) {
    super(message)
    this.name = 'AuctionFailError'
  }
}

function isFailReason(err: unknown): err is AuctionFailError {
  return err instanceof AuctionFailError
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * Canonical outcome shape shared by every write hook. The three
 * "happy-path" states (`idle` / `pending` / `done`) come straight
 * off `tanstack-query`'s mutation status; `failed` surfaces a
 * server-reported domain reason; `error` is anything else.
 */
export type WriteOutcome<Done = void> =
  | { kind: 'idle' }
  | { kind: 'pending' }
  | ({ kind: 'done' } & (Done extends void ? {} : { value: Done }))
  | { kind: 'failed'; reason: string }
  | { kind: 'error'; message: string }

function deriveOutcome<TData, TResult>(
  status: 'idle' | 'pending' | 'success' | 'error',
  data: TData | undefined,
  error: Error | null,
  mapSuccess: (data: TData) => TResult,
): WriteOutcome<TResult> {
  if (status === 'idle') return { kind: 'idle' }
  if (status === 'pending') return { kind: 'pending' }
  if (status === 'error') {
    if (isFailReason(error)) return { kind: 'failed', reason: error.reason }
    return { kind: 'error', message: errorMessage(error) }
  }
  // status === 'success'
  const value = mapSuccess(data as TData)
  return value === undefined
    ? ({ kind: 'done' } as WriteOutcome<TResult>)
    : ({ kind: 'done', value } as WriteOutcome<TResult>)
}

// ── Tier 2: mutation + outcome hooks ───────────────────────────────

/**
 * Place a bid. The mutationFn owns the whole lifecycle: RPC to
 * `auctions.placeBid`, then await the bidSaga's terminal phase via
 * a one-shot subscription. Returns the idempotency key on success;
 * throws `AuctionFailError` if the saga ends in `failed`.
 *
 * `outcome.kind === 'pending'` is true for the full duration of the
 * saga, not just the initial RPC — this is the whole point of doing
 * it inside one tanstack mutation.
 */
export function usePlaceBid() {
  const convex = useConvex()
  const mutation = useTQMutation({
    mutationFn: async (args: {
      user: string
      auctionName: string
      amount: number
    }): Promise<string> => {
      const idempotencyKey = makeKey('bid', args.user)
      await convex.mutation(api.auctions.placeBid, {
        ...args,
        idempotencyKey,
      })
      const saga = await awaitQueryResult(
        convex,
        api.auctions.getBidStatus,
        { idempotencyKey },
        (v) =>
          v !== null &&
          v !== undefined &&
          (v.phase === 'completed' || v.phase === 'failed'),
      )
      if (!saga || saga.phase !== 'completed') {
        const reason = saga?.failReason ?? 'unknown'
        throw new AuctionFailError(`bid failed: ${reason}`, reason)
      }
      return idempotencyKey
    },
  })

  const outcome = useMemo<WriteOutcome>(
    () =>
      deriveOutcome<string, void>(
        mutation.status,
        mutation.data,
        mutation.error,
        () => undefined,
      ),
    [mutation],
  )

  return {
    placeBid: mutation.mutate,
    outcome,
    reset: mutation.reset,
  }
}

/**
 * Create an auction. The mutationFn forwards to
 * `auctions.createAuction`, then awaits the response row for the
 * returned messageId and unwraps the supervisor's allocated
 * `{ auctionName }`. `outcome.kind === 'done'` carries the name.
 */
export function useCreateAuction() {
  const convex = useConvex()
  const mutation = useTQMutation({
    mutationFn: async (
      args: FunctionArgs<typeof api.auctions.createAuction>,
    ): Promise<string> => {
      const messageId = await convex.mutation(api.auctions.createAuction, args)
      const row = await awaitMessageResponse<
        typeof auctionHouse,
        'createAuction'
      >(convex, messageId)
      if (row.response.kind === 'success') {
        return row.response.value.auctionName
      }
      if (row.response.kind === 'fail') {
        throw new AuctionFailError(
          `createAuction failed: ${row.response.reason}`,
          row.response.reason,
        )
      }
      throw new Error(
        `createAuction defected after ${row.response.attempts} attempts: ${row.response.error}`,
      )
    },
  })

  const outcome = useMemo<WriteOutcome<string>>(
    () =>
      deriveOutcome<string, string>(
        mutation.status,
        mutation.data,
        mutation.error,
        (name) => name,
      ),
    [mutation.status, mutation.data, mutation.error],
  )

  return {
    createAuction: mutation.mutate,
    outcome,
    reset: mutation.reset,
  }
}

/**
 * Deposit funds. Trivial compared to the other two — there's no
 * downstream saga or response row to unwrap, so this is just a
 * thin wrapper around the convex mutation for API consistency.
 */
export function useDeposit() {
  const convex = useConvex()
  const mutation = useTQMutation({
    mutationFn: (args: { user: string; amount: number }) =>
      convex.mutation(api.auctions.deposit, args),
  })

  const outcome = useMemo<WriteOutcome>(
    () =>
      deriveOutcome<string, void>(
        mutation.status,
        mutation.data,
        mutation.error,
        () => undefined,
      ),
    [mutation.status, mutation.data, mutation.error],
  )

  return {
    deposit: mutation.mutate,
    outcome,
    reset: mutation.reset,
  }
}

// ── internals ──────────────────────────────────────────────────────

function makeKey(prefix: string, user: string): string {
  const rand = Math.random().toString(36).slice(2, 8)
  return `${prefix}-${user}-${Date.now()}-${rand}`
}
