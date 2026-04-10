import { components } from "./_generated/api";
import { makeExecute } from "./components/actors/client/execute";
import { ActorSystem } from "./components/actors/client/system";

const defs = {
  // counter,
  // chatRoom,
};

export const execute = makeExecute(defs, components.actors);
export const system = new ActorSystem(components.actors, defs);
