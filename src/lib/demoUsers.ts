/**
 * Stable demo identities. No auth — instead of asking the viewer to
 * role-switch, we hard-code one seller that lists every auction and a
 * fixed roster of bidders that the auction detail page exposes as
 * side-by-side controls.
 */
export const SELLER = 'house'

export const BIDDERS = ['bob', 'carol', 'dave'] as const
export type Bidder = (typeof BIDDERS)[number]
