/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { z } from "zod";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { components } from "../../../_generated/api.js";
import { api as componentApi } from "../_generated/api.js";
import componentSchema from "../schema.js";
import schema from "../../../schema.js";
import { defineActor } from "./defineActor.js";
import { ActorSystem } from "./system.js";

const appModules = import.meta.glob("../../../**/*.ts");
const componentModules = import.meta.glob("../**/*.ts");

const T0 = 1_700_000_000_000;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
});
afterEach(() => {
  vi.useRealTimers();
});

const counter = defineActor({
  type: "counter",
  state: z.object({ n: z.number() }),
  messages: { inc: { payload: z.object({ by: z.number() }) } },
  initialState: () => ({ n: 0 }),
  handle: {
    inc: async (state, { by }) => {
      state.n += by;
    },
  },
});

function makeExecuteRef() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (componentApi as any).kick.kickMailbox;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function setup(defs: Record<string, any>) {
  const t = convexTest(schema, appModules);
  t.registerComponent("actors", componentSchema, componentModules);
  const system = new ActorSystem(components.actors, defs);
  const ref = makeExecuteRef();
  return { t, system, ref };
}

describe("system.getResponse", () => {
  test("returns null before any drain has committed", async () => {
    const { t, system, ref } = setup({ counter });
    await t.run(async (ctx) => {
      const messageId = await system.send(
        ctx, ref, counter, "a", "inc", { by: 1 },
      );
      const result = await system.getResponse(ctx, { messageId });
      expect(result).toBeNull();
    });
  });

  test("rejects an invalid messageId", async () => {
    const { t, system, ref } = setup({ counter });
    await t.run(async (ctx) => {
      await expect(
        system.getResponse(ctx, { messageId: "nonexistent" }),
      ).rejects.toThrow(/Expected ID/);
    });
  });

  // "returns success/fail/defect response after drain" — deferred to
  // drain e2e tests. Can't commit a response row from app-space without
  // the full drain loop; the response shapes are already covered by the
  // component-level drain tests.
});
