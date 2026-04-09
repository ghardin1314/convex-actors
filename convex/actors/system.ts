import type { ComponentApi } from "../components/actors/_generated/component";
import type { AnyActorDefinition } from "./defineActor";

/**
 * Type alias for the `components.actors` reference that an `ActorSystem`
 * is constructed against. Re-exported so consumers don't have to reach
 * into `_generated/`.
 */
export type ActorsComponent = ComponentApi;

/**
 * Container that ties a set of `ActorDefinition`s to the generated
 * `components.actors` reference. Holds no runtime state beyond the
 * definition map — lookup by `actorType` is O(1) and throws on miss so
 * `peek` / `send` / `drain` can assume a definition exists once the
 * system resolves it.
 *
 * The factory methods `peek` / `send` / `getResponse` / `drain` will be
 * attached in Steps 3.3–3.5 and Step 4.2 respectively. Each returns a
 * registered Convex function bound to this system.
 *
 * Per SPEC §Container and drain, app code is expected to instantiate one
 * system per component and re-export the factory-built functions once:
 *
 * ```ts
 * export const system = new ActorSystem(components.actors, { counter, chatRoom });
 * export const peek = system.peek;
 * export const send = system.send;
 * export const getResponse = system.getResponse;
 * export const drain = system.drain;
 * ```
 */
/**
 * Union of every `.type` literal registered in a given `Defs` record.
 * Drives the compile-time check on `getDefinition` / `hasDefinition`
 * so `system.getDefinition("typo")` fails `tsc` before it reaches the
 * runtime throw.
 */
export type RegisteredActorType<
  Defs extends Record<string, AnyActorDefinition>,
> = Defs[keyof Defs]["type"];

/**
 * Pick the specific definition whose `.type` field matches `T`. Used to
 * narrow `getDefinition`'s return so a call with a literal type string
 * gets back that exact definition shape (state / messages / projection),
 * not the lowest-common-denominator `AnyActorDefinition`.
 */
export type DefinitionByType<
  Defs extends Record<string, AnyActorDefinition>,
  T extends RegisteredActorType<Defs>,
> = Extract<Defs[keyof Defs], { type: T }>;

export class ActorSystem<
  Defs extends Record<string, AnyActorDefinition>,
> {
  readonly component: ActorsComponent;
  readonly definitions: Defs;

  /**
   * Definitions indexed by their `type` field. The input record's keys
   * are JS identifiers for ergonomic `{ counter, chatRoom }` shorthand;
   * the authoritative lookup key used on the wire and in the schema is
   * `definition.type`.
   */
  private readonly byType: Map<string, AnyActorDefinition>;

  constructor(component: ActorsComponent, definitions: Defs) {
    this.component = component;
    this.definitions = definitions;

    this.byType = new Map();
    for (const def of Object.values(definitions)) {
      if (this.byType.has(def.type)) {
        throw new Error(
          `ActorSystem: duplicate actor type "${def.type}" — each definition's \`type\` field must be unique within a system`,
        );
      }
      this.byType.set(def.type, def);
    }
  }

  /**
   * Resolve an `actorType` to its definition. `actorType` is constrained
   * at compile time to the union of registered `.type` literals, so an
   * unknown name fails `tsc` — the runtime throw below is a belt on top
   * of the suspenders for call sites that reach this with a dynamically
   * typed string (e.g. `send` decoding an over-the-wire argument).
   *
   * Return type is narrowed via `DefinitionByType` so a caller that
   * passes a literal (`"counter"`) gets the specific definition shape
   * back, not the lowest-common-denominator `AnyActorDefinition`.
   */
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

  /**
   * True if `actorType` is registered. Accepts any string so callers
   * can use it as a guard before calling `getDefinition` with an
   * untrusted value; narrows the argument to a registered literal on
   * the true branch.
   */
  hasDefinition(
    actorType: string,
  ): actorType is RegisteredActorType<Defs> & string {
    return this.byType.has(actorType);
  }

  /** Iterable over every registered definition, in insertion order. */
  allDefinitions(): Iterable<AnyActorDefinition> {
    return this.byType.values();
  }
}
