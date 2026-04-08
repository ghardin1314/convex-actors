/// <reference types="vite/client" />
import type { TestConvex } from "convex-test";
import type { GenericSchema, SchemaDefinition } from "convex/server";
import schema from "./schema.js";

// Component-internal modules. Mirrors the workpool convention so that
// `convexTest` and the app-level tests can both mount the component.
const modules = import.meta.glob("./**/*.ts");

/**
 * Register the actors component with a `convexTest` instance.
 */
export function register<
  Schema extends SchemaDefinition<GenericSchema, boolean>,
>(t: TestConvex<Schema>, name: string = "actors") {
  t.registerComponent(name, schema, modules);
}

export default { register, schema, modules };
