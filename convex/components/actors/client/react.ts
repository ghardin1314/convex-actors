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
import { useMutation } from "convex/react";
import { useSuspenseQuery, useQuery } from "@tanstack/react-query";
import { convexQuery } from "@convex-dev/react-query";
import type { FunctionReference } from "convex/server";
import type {
  AnyActorDefinition,
  MessageNamesOf,
  ProjectionOf,
} from "./defineActor";
import type { Infer } from "convex/values";

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

export type ActorResponse =
  | { kind: "success"; value: unknown }
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
      payload: Infer<D["messages"][M]>,
      opts?: { at?: number; after?: number },
    ) => Promise<string>;
    peek: ProjectionOf<D>;
  } {
    const sendMut = useMutation(actorApi.send);

    const { data: projection } = useSuspenseQuery(
      convexQuery(actorApi.peek, { actorType: def.type, name }),
    );

    const send = useCallback(
      <M extends MessageNamesOf<D>>(
        msgType: M,
        payload: Infer<D["messages"][M]>,
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
