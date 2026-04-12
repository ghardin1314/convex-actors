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
import type * as client_ctx from "../client/ctx.js";
import type * as client_defineActor from "../client/defineActor.js";
import type * as client_defineProcess from "../client/defineProcess.js";
import type * as client_defineSaga from "../client/defineSaga.js";
import type * as client_execute from "../client/execute.js";
import type * as client_index from "../client/index.js";
import type * as client_react from "../client/react.js";
import type * as client_system from "../client/system.js";
import type * as client_testing from "../client/testing.js";
import type * as crons from "../crons.js";
import type * as drain from "../drain.js";
import type * as enqueue from "../enqueue.js";
import type * as kick from "../kick.js";
import type * as recovery from "../recovery.js";
import type * as responses from "../responses.js";
import type * as shared from "../shared.js";
import type * as testHelpers from "../testHelpers.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";
import { anyApi, componentsGeneric } from "convex/server";

const fullApi: ApiFromModules<{
  actors: typeof actors;
  "client/ctx": typeof client_ctx;
  "client/defineActor": typeof client_defineActor;
  "client/defineProcess": typeof client_defineProcess;
  "client/defineSaga": typeof client_defineSaga;
  "client/execute": typeof client_execute;
  "client/index": typeof client_index;
  "client/react": typeof client_react;
  "client/system": typeof client_system;
  "client/testing": typeof client_testing;
  crons: typeof crons;
  drain: typeof drain;
  enqueue: typeof enqueue;
  kick: typeof kick;
  recovery: typeof recovery;
  responses: typeof responses;
  shared: typeof shared;
  testHelpers: typeof testHelpers;
}> = anyApi as any;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
> = anyApi as any;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
> = anyApi as any;

export const components = componentsGeneric() as unknown as {};
