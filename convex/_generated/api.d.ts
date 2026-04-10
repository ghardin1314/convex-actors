/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as actors from "../actors.js";
import type * as myFunctions from "../myFunctions.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  actors: typeof actors;
  myFunctions: typeof myFunctions;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {
  actors: {
    actors: {
      getActorState: FunctionReference<
        "query",
        "internal",
        { actorType: string; name: string },
        any
      >;
      getMailboxInfo: FunctionReference<
        "query",
        "internal",
        { actorType: string; name: string },
        any
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
          }>;
          executeFn: string;
        },
        Array<string>
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
        } | null
      >;
    };
  };
};
