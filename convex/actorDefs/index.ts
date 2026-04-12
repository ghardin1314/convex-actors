import { account } from './account'
import { auction } from './auction'
import { auctionHouse } from './auctionHouse'
import { bidSaga } from './bidSaga'
import { settlementSaga } from './settlementSaga'
import { userBids } from './userBids'

export { account } from './account'
export { auction } from './auction'
export { auctionHouse } from './auctionHouse'
export { bidSaga } from './bidSaga'
export { settlementSaga } from './settlementSaga'
export { userBids } from './userBids'

export const ActorsDefs = {
  account,
  auction,
  userBids,
  auctionHouse,
  bidSaga,
  settlementSaga,
}
export type ActorsDefsType = typeof ActorsDefs
