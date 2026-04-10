/* eslint-disable */
/**
 * Generated `ComponentApi` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type { FunctionReference } from "convex/server";

/**
 * A utility for referencing a Convex component's exposed API.
 *
 * Useful when expecting a parameter like `components.myComponent`.
 * Usage:
 * ```ts
 * async function myFunction(ctx: QueryCtx, component: ComponentApi) {
 *   return ctx.runQuery(component.someFile.someQuery, { ...args });
 * }
 * ```
 */
export type ComponentApi<Name extends string | undefined = string | undefined> =
  {
    actors: {
      getActorState: FunctionReference<
        "query",
        "internal",
        { actorType: string; name: string },
        any,
        Name
      >;
      getMailboxInfo: FunctionReference<
        "query",
        "internal",
        { actorType: string; name: string },
        any,
        Name
      >;
    };
    enqueue: {
      enqueueMessage: FunctionReference<
        "mutation",
        "internal",
        {
          effects: Array<{
            actorType: string;
            deliverAt: number;
            msgType: string;
            name: string;
            payload: any;
            replyTo?: {
              actorType: string;
              context: any;
              handler: string;
              name: string;
            };
          }>;
          executeFn: string;
        },
        Array<string>,
        Name
      >;
    };
    responses: {
      getResponseRow: FunctionReference<
        "query",
        "internal",
        { messageId: string },
        {
          messageId: string;
          response:
            | { kind: "success"; value: any }
            | { details?: any; kind: "fail"; reason: string }
            | { attempts: number; error: string; kind: "defect" };
        } | null,
        Name
      >;
    };
  };
