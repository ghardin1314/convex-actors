import { components } from './_generated/api'
import { ActorsDefs } from './actorDefs'
import { ActorSystem, makeExecute } from './components/actors/client'

// ── Wire-up ─────────────────────────────────────────────────────

export const execute = makeExecute(ActorsDefs, components.actors)
export const system = new ActorSystem(components.actors, ActorsDefs)
