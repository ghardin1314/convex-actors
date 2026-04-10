import { v } from 'convex/values'
import { query } from './_generated/server.js'
import { vResponse } from './shared.js'

/**
 * Registered query so the app-level `getResponse` factory can look up
 * a response by its associated `messageId`. Returns the full response
 * object (`{ kind, ... }`) or `null` if the drain hasn't committed a
 * result yet. The app-level wrapper passes the result through as-is.
 */
export const getResponseRow = query({
  args: { messageId: v.id('messages') },
  returns: v.union(
    v.object({ messageId: v.id('messages'), response: vResponse }),
    v.null(),
  ),
  handler: async (ctx, { messageId }) => {
    const row = await ctx.db
      .query('responses')
      .withIndex('by_message', (q) =>
        q.eq('messageId', messageId),
      )
      .unique()
    if (row === null) return null
    return { messageId: row.messageId, response: row.response }
  },
})
