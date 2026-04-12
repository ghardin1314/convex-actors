/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as actors_account from "../actors/account.js";
import type * as actors_auction from "../actors/auction.js";
import type * as actors_auctionHouse from "../actors/auctionHouse.js";
import type * as actors_bidSaga from "../actors/bidSaga.js";
import type * as actors_index from "../actors/index.js";
import type * as actors_settlementSaga from "../actors/settlementSaga.js";
import type * as actors_userBids from "../actors/userBids.js";
import type * as auctions from "../auctions.js";
import type * as system from "../system.js";
import type * as testHelpers from "../testHelpers.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  "actors/account": typeof actors_account;
  "actors/auction": typeof actors_auction;
  "actors/auctionHouse": typeof actors_auctionHouse;
  "actors/bidSaga": typeof actors_bidSaga;
  "actors/index": typeof actors_index;
  "actors/settlementSaga": typeof actors_settlementSaga;
  "actors/userBids": typeof actors_userBids;
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
