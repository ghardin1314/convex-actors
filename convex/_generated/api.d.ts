/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as actorDefs_account from "../actorDefs/account.js";
import type * as actorDefs_auction from "../actorDefs/auction.js";
import type * as actorDefs_auctionHouse from "../actorDefs/auctionHouse.js";
import type * as actorDefs_bidSaga from "../actorDefs/bidSaga.js";
import type * as actorDefs_index from "../actorDefs/index.js";
import type * as actorDefs_settlementSaga from "../actorDefs/settlementSaga.js";
import type * as actorDefs_userBids from "../actorDefs/userBids.js";
import type * as auctions from "../auctions.js";
import type * as system from "../system.js";
import type * as testHelpers from "../testHelpers.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  "actorDefs/account": typeof actorDefs_account;
  "actorDefs/auction": typeof actorDefs_auction;
  "actorDefs/auctionHouse": typeof actorDefs_auctionHouse;
  "actorDefs/bidSaga": typeof actorDefs_bidSaga;
  "actorDefs/index": typeof actorDefs_index;
  "actorDefs/settlementSaga": typeof actorDefs_settlementSaga;
  "actorDefs/userBids": typeof actorDefs_userBids;
  auctions: typeof auctions;
  system: typeof system;
  testHelpers: typeof testHelpers;
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
