import { components } from './_generated/api'
import { account, auction, userBids } from './auctionActors'
import { auctionHouse } from './auctionHouse'
import { bidSaga, settlementSaga } from './auctionSagas'
import { ActorSystem, makeExecute } from './components/actors/client'

// ── Wire-up ─────────────────────────────────────────────────────

const defs = {
  account,
  auction,
  userBids,
  auctionHouse,
  bidSaga,
  settlementSaga,
}

export const execute = makeExecute(defs, components.actors)
export const system = new ActorSystem(components.actors, defs)
