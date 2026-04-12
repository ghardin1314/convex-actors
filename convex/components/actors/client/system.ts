/**
 * `ActorSystem` — typed registry + dispatch facade for a set of actor
 * definitions. Methods take `ctx` and call component mutations/queries
 * directly.
 */
import {
  createFunctionHandle,
  type FunctionReference,
  type FunctionReturnType,
  type OptionalRestArgs,
} from 'convex/server'
import type { z } from 'zod'
import type { ComponentApi } from '../_generated/component'
import type { LogLevel } from '../logging.js'
import type {
  AnyProcess,
  MessageNamesOf,
  ProjectionOf,
  ResponseEnvelope,
  ReturnOf,
} from './defineProcess'
import { resolveDeliverAt, type ScheduleOpts } from './ctx'

export type RunQueryCtx = {
  runQuery: <Query extends FunctionReference<'query', 'public' | 'internal'>>(
    query: Query,
    ...args: OptionalRestArgs<Query>
  ) => Promise<FunctionReturnType<Query>>
}

export type RunMutationCtx = {
  runMutation: <
    Mutation extends FunctionReference<'mutation', 'public' | 'internal'>,
  >(
    mutation: Mutation,
    ...args: OptionalRestArgs<Mutation>
  ) => Promise<FunctionReturnType<Mutation>>
}

export type ActorsComponent = ComponentApi

export type ExecuteRef = FunctionReference<
  'mutation',
  'internal',
  {
    actorType: string
    actorName: string
    msgType: string
    payload: unknown
  }
>

export interface ActorSystemOptions {
  logLevel?: LogLevel
}

export type RegisteredActorType<Defs extends Record<string, AnyProcess>> =
  Defs[keyof Defs]['type']

export type DefinitionByType<
  Defs extends Record<string, AnyProcess>,
  T extends RegisteredActorType<Defs>,
> = Extract<Defs[keyof Defs], { type: T }>

export class ActorSystem<Defs extends Record<string, AnyProcess>> {
  readonly component: ActorsComponent
  readonly definitions: Defs
  readonly options: ActorSystemOptions
  private readonly byType: Map<string, AnyProcess>

  constructor(
    component: ActorsComponent,
    definitions: Defs,
    options?: ActorSystemOptions,
  ) {
    this.component = component
    this.definitions = definitions
    this.options = options ?? {}

    this.byType = new Map()
    for (const def of Object.values(definitions)) {
      if (this.byType.has(def.type)) {
        throw new Error(`ActorSystem: duplicate actor type "${def.type}"`)
      }
      this.byType.set(def.type, def)
    }
  }

  getDefinition<T extends RegisteredActorType<Defs>>(
    actorType: T,
  ): DefinitionByType<Defs, T> {
    const def = this.byType.get(actorType)
    if (!def) {
      throw new Error(
        `ActorSystem: unknown actor type "${actorType}" (registered: ${[...this.byType.keys()].map((k) => `"${k}"`).join(', ') || '<none>'})`,
      )
    }
    return def as DefinitionByType<Defs, T>
  }

  hasDefinition(
    actorType: string,
  ): actorType is RegisteredActorType<Defs> & string {
    return this.byType.has(actorType)
  }

  allDefinitions(): Iterable<AnyProcess> {
    return this.byType.values()
  }

  async send<D extends AnyProcess, M extends MessageNamesOf<D>>(
    ctx: RunMutationCtx,
    executeRef: ExecuteRef,
    def: D,
    name: string,
    msgType: M,
    payload: z.infer<D['messages'][M]['payload']>,
    opts?: ScheduleOpts,
  ): Promise<string> {
    return this.sendRaw(ctx, executeRef, def.type, name, msgType, payload, opts)
  }

  async peek<D extends AnyProcess>(
    ctx: RunQueryCtx,
    def: D,
    name: string,
  ): Promise<ProjectionOf<D> | null> {
    return this.peekRaw(ctx, def.type, name) as Promise<ProjectionOf<D> | null>
  }

  async sendRaw(
    ctx: RunMutationCtx,
    executeRef: ExecuteRef,
    actorType: string,
    name: string,
    msgType: string,
    payload: unknown,
    opts?: ScheduleOpts,
  ): Promise<string> {
    if (!this.hasDefinition(actorType)) {
      throw new Error(
        `send: unknown actor type "${actorType}" (registered: ${
          [...this.allDefinitions()].map((d) => `"${d.type}"`).join(', ') ||
          '<none>'
        })`,
      )
    }
    const def = this.getDefinition(actorType)
    if (!(msgType in def.messages)) {
      throw new Error(
        `send: unknown msgType "${msgType}" for actor type "${actorType}" (valid: ${
          Object.keys(def.messages)
            .map((k) => `"${k}"`)
            .join(', ') || '<none>'
        })`,
      )
    }

    const schema = def.messages[msgType].payload
    const parsed = schema.safeParse(payload)
    if (!parsed.success) {
      throw new Error(
        `send: invalid payload for "${actorType}.${msgType}": ${parsed.error.message}`,
      )
    }
    payload = parsed.data

    const deliverAt = resolveDeliverAt(Date.now(), opts)

    const executeFn = await createFunctionHandle(executeRef)

    const ids = await ctx.runMutation(this.component.enqueue.enqueueMessage, {
      effects: [{ actorType: actorType, name, msgType, payload, deliverAt }],
      executeFn,
      logLevel: this.options.logLevel,
    })

    return ids[0]
  }

  async peekRaw(
    ctx: RunQueryCtx,
    actorType: string,
    name: string,
  ): Promise<unknown> {
    if (!this.hasDefinition(actorType)) {
      throw new Error(
        `peek: unknown actor type "${actorType}" (registered: ${
          [...this.allDefinitions()].map((d) => `"${d.type}"`).join(', ') ||
          '<none>'
        })`,
      )
    }
    const def = this.getDefinition(actorType)
    if (!def.project) return null

    const state = await ctx.runQuery(this.component.actors.getActorState, {
      actorType: actorType,
      name,
    })
    if (state === null || state === undefined) return null
    return def.project(state)
  }

  async getResponse<
    D extends AnyProcess = AnyProcess,
    M extends MessageNamesOf<D> = MessageNamesOf<D>,
  >(
    ctx: RunQueryCtx,
    args: { messageId: string },
  ): Promise<ResponseEnvelope<ReturnOf<D, M>> | null> {
    return await ctx.runQuery(this.component.responses.getResponseRow, {
      messageId: args.messageId,
    }) as ResponseEnvelope<ReturnOf<D, M>> | null
  }
}
