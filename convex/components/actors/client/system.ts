import {
  createFunctionHandle,
  type FunctionReference,
  type FunctionReturnType,
  type OptionalRestArgs,
} from "convex/server";
import type { ComponentApi } from "../_generated/component";
import type { AnyActorDefinition } from "./defineActor";

export type RunQueryCtx = {
  runQuery: <Query extends FunctionReference<"query", "public" | "internal">>(
    query: Query,
    ...args: OptionalRestArgs<Query>
  ) => Promise<FunctionReturnType<Query>>;
};

export type RunMutationCtx = {
  runMutation: <
    Mutation extends FunctionReference<"mutation", "public" | "internal">,
  >(
    mutation: Mutation,
    ...args: OptionalRestArgs<Mutation>
  ) => Promise<FunctionReturnType<Mutation>>;
};

/**
 * Type alias for the `components.actors` reference that an `ActorSystem`
 * is constructed against.
 */
export type ActorsComponent = ComponentApi;

/**
 * Shape of the app-level `execute` internalMutation that `ActorSystem`
 * passes to the component via function handle.
 */
export type ExecuteRef = FunctionReference<
  "mutation",
  "internal",
  {
    actorType: string;
    actorName: string;
    msgType: string;
    payload: unknown;
  }
>;

export type RegisteredActorType<
  Defs extends Record<string, AnyActorDefinition>,
> = Defs[keyof Defs]["type"];

export type DefinitionByType<
  Defs extends Record<string, AnyActorDefinition>,
  T extends RegisteredActorType<Defs>,
> = Extract<Defs[keyof Defs], { type: T }>;

/**
 * Container that ties actor definitions to a component reference and
 * provides methods for interacting with actors. Follows the workpool
 * pattern: methods take `ctx` (RunMutationCtx/RunQueryCtx) and call
 * component mutations/queries directly.
 */
export class ActorSystem<
  Defs extends Record<string, AnyActorDefinition>,
> {
  readonly component: ActorsComponent;
  readonly definitions: Defs;
  private readonly byType: Map<string, AnyActorDefinition>;

  constructor(
    component: ActorsComponent,
    definitions: Defs,
  ) {
    this.component = component;
    this.definitions = definitions;

    this.byType = new Map();
    for (const def of Object.values(definitions)) {
      if (this.byType.has(def.type)) {
        throw new Error(
          `ActorSystem: duplicate actor type "${def.type}"`,
        );
      }
      this.byType.set(def.type, def);
    }
  }

  getDefinition<T extends RegisteredActorType<Defs>>(
    actorType: T,
  ): DefinitionByType<Defs, T> {
    const def = this.byType.get(actorType);
    if (!def) {
      throw new Error(
        `ActorSystem: unknown actor type "${actorType}" (registered: ${[...this.byType.keys()].map((k) => `"${k}"`).join(", ") || "<none>"})`,
      );
    }
    return def as DefinitionByType<Defs, T>;
  }

  hasDefinition(
    actorType: string,
  ): actorType is RegisteredActorType<Defs> & string {
    return this.byType.has(actorType);
  }

  allDefinitions(): Iterable<AnyActorDefinition> {
    return this.byType.values();
  }

  /**
   * Send a message to an actor. Validates actorType and msgType against
   * registered definitions, then enqueues via the component.
   */
  async send(
    ctx: RunMutationCtx,
    executeRef: ExecuteRef,
    args: {
      actorType: string;
      name: string;
      msgType: string;
      payload: unknown;
      opts?: { at?: number; after?: number };
    },
  ): Promise<string> {
    if (!this.hasDefinition(args.actorType)) {
      throw new Error(
        `send: unknown actor type "${args.actorType}" (registered: ${[
          ...this.allDefinitions(),
        ]
          .map((d) => `"${d.type}"`)
          .join(", ") || "<none>"})`,
      );
    }
    const def = this.getDefinition(args.actorType);

    if (!(args.msgType in def.messages)) {
      throw new Error(
        `send: unknown msgType "${args.msgType}" for actor type "${args.actorType}" (valid: ${Object.keys(
          def.messages,
        )
          .map((k) => `"${k}"`)
          .join(", ") || "<none>"})`,
      );
    }

    const now = Date.now();
    let deliverAt: number;
    if (args.opts?.at !== undefined) {
      deliverAt = args.opts.at;
    } else if (args.opts?.after !== undefined) {
      deliverAt = now + args.opts.after;
    } else {
      deliverAt = now;
    }
    if (deliverAt < now) deliverAt = now;

    const executeFn = await createFunctionHandle(executeRef);

    const ids = await ctx.runMutation(
      this.component.enqueue.enqueueMessage,
      {
        effects: [
          {
            actorType: args.actorType,
            name: args.name,
            msgType: args.msgType,
            payload: args.payload,
            deliverAt,
          },
        ],
        executeFn,
      },
    );

    return ids[0];
  }

  /**
   * Read an actor's projected public view. Returns `null` when the
   * actor doesn't exist, has no state yet, or has no `project` function.
   */
  async peek(
    ctx: RunQueryCtx,
    args: { actorType: string; name: string },
  ): Promise<unknown> {
    if (!this.hasDefinition(args.actorType)) {
      throw new Error(
        `peek: unknown actor type "${args.actorType}" (registered: ${[
          ...this.allDefinitions(),
        ]
          .map((d) => `"${d.type}"`)
          .join(", ") || "<none>"})`,
      );
    }
    const def = this.getDefinition(args.actorType);
    if (!def.project) return null;

    const state = await ctx.runQuery(
      this.component.actors.getActorState,
      { actorType: args.actorType, name: args.name },
    );
    if (state === null || state === undefined) return null;
    return def.project(state);
  }

  /**
   * Look up the response for a given messageId. Returns `null` before
   * the drain has committed a result.
   */
  async getResponse(
    ctx: RunQueryCtx,
    args: { messageId: string },
  ): Promise<{
    messageId: string;
    response:
      | { kind: "success"; value: unknown }
      | { kind: "fail"; reason: string; details?: unknown }
      | { kind: "defect"; error: string; attempts: number };
  } | null> {
    return await ctx.runQuery(
      this.component.responses.getResponseRow,
      { messageId: args.messageId },
    );
  }
}
