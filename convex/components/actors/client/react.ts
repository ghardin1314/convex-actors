/**
 * Typed React hooks for interacting with actors.
 *
 * Usage:
 *   // once, at app level
 *   export const { useActor, useActorResponse } =
 *     createActorHooks(api.actorFunctions);
 *
 *   // in components
 *   const { send, peek } = useActor(counterDef, "alice");
 *   peek.count          // typed projection
 *   send("inc", { by: 1 })  // typechecked msg + payload
 */
import { useCallback } from "react";
import type { ConvexReactClient } from "convex/react";
import { useMutation } from "convex/react";
import { useQuery } from "@tanstack/react-query";
import { convexQuery } from "@convex-dev/react-query";
import type {
  FunctionArgs,
  FunctionReference,
  FunctionReturnType,
} from "convex/server";
import type {
  AnyActorDefinition,
  MessageNamesOf,
  ProjectionOf,
  ReturnOf,
} from "./defineActor";
import type { SagaProjection } from "./defineSaga";
import type { z } from "zod";

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

/**
 * Shape of the `api.actorFunctions` module — the three public Convex
 * functions that the hooks call under the hood.
 */
export interface ActorApi {
  send: FunctionReference<
    "mutation",
    "public",
    {
      actorType: string;
      name: string;
      msgType: string;
      payload: unknown;
      opts?: { at?: number; after?: number };
    },
    string
  >;
  peek: FunctionReference<
    "query",
    "public",
    { actorType: string; name: string },
    unknown
  >;
  getResponse: FunctionReference<
    "query",
    "public",
    { messageId: string },
    unknown
  >;
}

/**
 * Shape of the `response` field in a committed message-response row.
 * Generic over the success `value` so a typed awaiter can narrow it
 * to the handler's declared return type; defaults to `unknown` for
 * the generic `useActorResponse` hook, which is keyed only by a bare
 * `messageId` and has no static handle on the source handler.
 */
export type ActorResponse<T = unknown> =
  | { kind: "success"; value: T }
  | { kind: "fail"; reason: string; details?: unknown }
  | { kind: "defect"; error: string; attempts: number };

/**
 * Create typed React hooks bound to your actor API functions.
 * Call once at app level, then use the returned hooks in components.
 */
export function createActorHooks(actorApi: ActorApi) {
  /**
   * Typed actor hook. Returns `send` and `peek` narrowed to the actor
   * definition's types.
   */
  function useActor<D extends AnyActorDefinition>(
    def: D,
    name: string,
  ): {
    send: <M extends MessageNamesOf<D>>(
      msgType: M,
      payload: z.infer<D["messages"][M]["payload"]>,
      opts?: { at?: number; after?: number },
    ) => Promise<string>;
    peek: ProjectionOf<D> | undefined;
  } {
    const sendMut = useMutation(actorApi.send);

    const { data: projection } = useQuery(
      convexQuery(actorApi.peek, { actorType: def.type, name }),
    );

    const send = useCallback(
      <M extends MessageNamesOf<D>>(
        msgType: M,
        payload: z.infer<D["messages"][M]["payload"]>,
        opts?: { at?: number; after?: number },
      ) => {
        return sendMut({
          actorType: def.type,
          name,
          msgType: msgType as string,
          payload,
          opts,
        });
      },
      [sendMut, def.type, name],
    );

    return {
      send,
      peek: projection as ProjectionOf<D>,
    };
  }

  /**
   * Poll for a message response by ID. Returns `null` while the
   * message is still pending, or the response once committed.
   * Pass `null` as messageId to skip the query.
   */
  function useActorResponse(
    messageId: string | null,
  ): {
    messageId: string;
    response: ActorResponse;
  } | null | undefined {
    const { data } = useQuery(
      convexQuery(
        actorApi.getResponse,
        messageId ? { messageId } : "skip",
      ),
    );
    return data as {
      messageId: string;
      response: ActorResponse;
    } | null | undefined;
  }

  return { useActor, useActorResponse };
}

// ── Typed response awaiter ─────────────────────────────────────────

/**
 * Shape of a public `getResponse` query wrapper. Each app exposes its
 * own wrapper around `system.getResponse`:
 *
 *   export const getResponse = query({
 *     args: { messageId: v.string() },
 *     handler: async (ctx, { messageId }) =>
 *       await system.getResponse(ctx, { messageId }),
 *   });
 *
 * Pass that reference to `createResponseAwaiter` to get a typed
 * awaiter bound to it.
 */
export type GetResponseQueryRef = FunctionReference<
  "query",
  "public",
  { messageId: string },
  { messageId: string; response: ActorResponse } | null
>;

/** Envelope returned by an awaiter, with the success value narrowed. */
export type TypedResponseEnvelope<T> = {
  messageId: string;
  response: ActorResponse<T>;
};

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
    D extends AnyActorDefinition,
    M extends MessageNamesOf<D>,
  >(
    convex: ConvexReactClient,
    messageId: string,
  ): Promise<TypedResponseEnvelope<ReturnOf<D, M>>> => {
    return new Promise((resolve, reject) => {
      const watch = convex.watchQuery(getResponseQuery, { messageId });
      let unsubscribe: (() => void) | null = null;
      const check = () => {
        try {
          const value = watch.localQueryResult();
          if (value !== null && value !== undefined) {
            unsubscribe?.();
            resolve(value as TypedResponseEnvelope<ReturnOf<D, M>>);
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
type SagaStatusQueryRef = FunctionReference<"query", "public", any, SagaProjection | null>;

/**
 * Bind an app-owned saga-status query into an imperative awaiter that
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
export function createSagaAwaiter<Q extends SagaStatusQueryRef>(
  statusQuery: Q,
) {
  return (
    convex: ConvexReactClient,
    args: FunctionArgs<Q>,
  ): Promise<NonNullable<FunctionReturnType<Q>>> => {
    return new Promise((resolve, reject) => {
      const watch = convex.watchQuery(statusQuery, args);
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
