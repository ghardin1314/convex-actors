/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as actorFunctions from "../actorFunctions.js";
import type * as actors from "../actors.js";
import type * as auctionActors from "../auctionActors.js";
import type * as auctionHouse from "../auctionHouse.js";
import type * as auctionSagas from "../auctionSagas.js";
import type * as auctions from "../auctions.js";
import type * as myFunctions from "../myFunctions.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  actorFunctions: typeof actorFunctions;
  actors: typeof actors;
  auctionActors: typeof auctionActors;
  auctionHouse: typeof auctionHouse;
  auctionSagas: typeof auctionSagas;
  auctions: typeof auctions;
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
            replyTo?: {
              actorType: string;
              context: any;
              handler: string;
              name: string;
            };
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
