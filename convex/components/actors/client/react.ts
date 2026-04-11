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
import type { FunctionReference } from "convex/server";
import type {
  AnyActorDefinition,
  MessageNamesOf,
  ProjectionOf,
  ReturnOf,
} from "./defineActor";
import type { z } from "zod";

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
