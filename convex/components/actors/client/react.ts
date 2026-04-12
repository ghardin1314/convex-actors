/**
 * Client-side helpers for awaiting actor and saga outcomes from a
 * `ConvexReactClient`. Intended for use inside tanstack-query
 * `mutationFn`s so a single mutation can cover "fire + wait for
 * terminal outcome" end-to-end.
 *
 * There are deliberately no generic `useActor` / `useActorResponse`
 * hooks here — the framework can't know how a given app wants to
 * handle auth, validation, or rate-limiting, so every app wraps
 * `system.send` / `system.peek` with its own typed queries and
 * mutations and the UI talks to those.
 */
import type { ConvexReactClient } from "convex/react";
import type {
  FunctionArgs,
  FunctionReference,
  FunctionReturnType,
} from "convex/server";
import type {
  AnyProcess,
  MessageNamesOf,
  ResponseEnvelope,
  ReturnOf,
} from "./defineProcess";
import type { SagaProjection } from "./defineSaga";

// Re-export saga projection types so app code can name them (prop
// types, explicit annotations) without reaching past react.ts. The
// `createSagaAwaiter` helper never uses them at the call site — its
// return type is inferred end-to-end from the query reference — but
// occasionally an app wants to spell the shape out.
export type {
  AnySagaDefinition,
  SagaProjection,
  SagaProjectionOf,
  StepNamesOf,
} from "./defineSaga";
export type { ActorResponse, ResponseEnvelope } from "./defineProcess";

// ── Typed response awaiter ─────────────────────────────────────────

export type GetResponseQueryRef = FunctionReference<
  "query",
  "public",
  { messageId: string },
  ResponseEnvelope | null
>;

/**
 * Bind a public `getResponse` query wrapper into an imperative
 * response awaiter. Intended for use inside a tanstack-query
 * `mutationFn` (or anywhere else that already holds a `ConvexReactClient`)
 * to fire-then-wait for a specific handler's reply.
 *
 * Call once at module scope:
 *
 *   const awaitMessageResponse = createResponseAwaiter(api.auctions.getResponse)
 *
 * Call per message, with both type arguments explicit:
 *
 *   const row = await awaitMessageResponse<typeof auctionHouse, 'createAuction'>(
 *     convex, messageId,
 *   )
 *   if (row.response.kind === 'success') {
 *     row.response.value.auctionName // ← typed, no cast
 *   }
 *
 * Both generics are required because TypeScript does not support
 * partial type-argument inference (microsoft/TypeScript#26242) —
 * specifying only `D` would force `M` to fall back to its constraint
 * and collapse `ReturnOf<D, M>` to the union of every handler on the
 * actor. The actor definition should be imported *type-only* so its
 * handler code never bundles into the client.
 *
 * The single unavoidable cast lives on the resolve line of this
 * function. Narrowing is trust-me, not runtime-validated: running the
 * actor's zod `response` schema would require a value import of the
 * actor module, and handlers may transitively reference server-only
 * code. The drain already produces values matching the handler's
 * signature; a drift there is a server bug, not a UI concern.
 */
export function createResponseAwaiter(getResponseQuery: GetResponseQueryRef) {
  return <
    D extends AnyProcess,
    M extends MessageNamesOf<D>,
  >(
    convex: ConvexReactClient,
    messageId: string,
  ): Promise<ResponseEnvelope<ReturnOf<D, M>>> => {
    return new Promise((resolve, reject) => {
      const watch = convex.watchQuery(getResponseQuery, { messageId });
      let unsubscribe: (() => void) | null = null;
      const check = () => {
        try {
          const value = watch.localQueryResult();
          if (value !== null && value !== undefined) {
            unsubscribe?.();
            resolve(value as ResponseEnvelope<ReturnOf<D, M>>);
          }
        } catch (err) {
          unsubscribe?.();
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      };
      // The watch may already have a cached result from an earlier
      // subscription — check immediately, otherwise we'd wait for a
      // fresh update that may never come.
      unsubscribe = watch.onUpdate(check);
      check();
    });
  };
}

// ── Typed saga awaiter ─────────────────────────────────────────────

/**
 * Structural constraint for an app-owned saga-status query reference.
 * Every saga has its own query (see the docstring on
 * `createSagaAwaiter` for why) so this is an open constraint rather
 * than a fixed `FunctionReference<...>` type alias: `any` on the args
 * slot lets each app declare whatever argument shape its query takes
 * (idempotency key, caller identity, auction id, etc.), and the return
 * slot only requires the query to resolve to a saga projection.
 *
 * The constraint uses the default-generic form of `SagaProjection`
 * (step names = `string`). Concrete queries typed on specific sagas
 * return narrower step unions, which are assignable to the wider
 * default — so `Q` still infers to the concrete, narrowed reference
 * inside `createSagaAwaiter`, and `FunctionReturnType<Q>` recovers the
 * exact projection type the caller's query returns.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SagaProjectionQueryRef = FunctionReference<"query", "public", any, SagaProjection | null>;

/**
 * Bind an app-owned saga query into an imperative awaiter that
 * resolves once the saga reaches a terminal phase (`completed` or
 * `failed`). Intended for use inside a tanstack-query `mutationFn` so a
 * single mutation can cover "fire saga start + wait for terminal".
 *
 * The returned function does NOT throw on `failed` — terminal failure
 * is a legitimate outcome that callers interpret in their own domain
 * (e.g. throw an `AuctionFailError` whose `reason` comes from
 * `projection.failReason`).
 *
 *
 * Usage:
 *
 *   const awaitBidSaga = createSagaAwaiter(api.auctions.getBidStatus)
 *
 *   // inside a mutationFn:
 *   const projection = await awaitBidSaga(convex, { idempotencyKey, user })
 *   if (projection.phase === 'failed') {
 *     projection.failedStep  // ← typed: 'holdFunds' | 'placeBid' | null
 *   }
 */
export function createSagaAwaiter<Q extends SagaProjectionQueryRef>(
  projectionQuery: Q,
) {
  return (
    convex: ConvexReactClient,
    args: FunctionArgs<Q>,
  ): Promise<NonNullable<FunctionReturnType<Q>>> => {
    return new Promise((resolve, reject) => {
      const watch = convex.watchQuery(projectionQuery, args);
      let unsubscribe: (() => void) | null = null;
      const check = () => {
        try {
          const value = watch.localQueryResult() as
            | SagaProjection
            | null
            | undefined;
          if (
            value !== null &&
            value !== undefined &&
            (value.phase === "completed" || value.phase === "failed")
          ) {
            unsubscribe?.();
            resolve(value as NonNullable<FunctionReturnType<Q>>);
          }
        } catch (err) {
          unsubscribe?.();
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      };
      // Cached-result fast path: the watch may already have a value
      // from an earlier subscription, in which case `onUpdate` won't
      // fire until the server pushes a new one. Check synchronously
      // after subscribing so we don't wait forever.
      unsubscribe = watch.onUpdate(check);
      check();
    });
  };
}
