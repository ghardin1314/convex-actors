/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { test } from "vitest";
import schema from "./schema.js";

const modules = import.meta.glob("./**/*.ts");

test("component boots", async () => {
  const t = convexTest(schema, modules);
  await t.run(async (ctx) => {
    // Empty schema — just prove the harness wires up without error.
    void ctx;
  });
});
