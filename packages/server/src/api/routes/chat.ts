/**
 * Channel reads, the read cursor, reactions and mute.
 *
 * Every route below the channel boundary goes through `authorizeChannel` and none of them
 * re-derives access. One channel-scoped route that decides for itself is how the four
 * hand-written copies of the access join happened (pitfall 9).
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ReactionEmoji } from '@clubchat/shared';
import { readChannelMeta, muteChannel, unmuteChannel } from '../../domain/dm.ts';
import { openChat } from '../../domain/inbox.ts';
import { mentionableMembers } from '../../domain/mentions.ts';
import { readReactions, toggleReaction } from '../../domain/reactions.ts';
import {
  advanceReadCursor,
  listAccessibleChannels,
  readAround,
  readHighlights,
  readHistory,
} from '../../domain/reads.ts';
import { setPinned, softDeleteMessage } from '../../domain/send-message.ts';
import { authorizeChannel, type AppDeps } from '../plumbing.ts';

export function registerChatRoutes(app: FastifyInstance, deps: AppDeps): void {
  app.get('/channels', async (request) => ({
    channels: await listAccessibleChannels(deps.db, request.userId!),
  }));

  /**
   * What to call this channel, and whether the composer is live.
   *
   * One endpoint for all four scopes rather than a DM-specific one, so the chat screen
   * stays a single implementation - PRD/05 rule 1, which DMs must not fork.
   */
  app.get<{ Params: { id: string } }>('/channels/:id', async (request, reply) => {
    const result = await readChannelMeta(deps.db, request.access!, request.params.id);
    if (!result.ok) return reply.code(404).send({ error: 'not_found' });
    return result;
  });

  const HistoryQuery = z.object({
    before: z.coerce.number().int().positive().optional(),
    limit: z.coerce.number().int().positive().max(200).optional(),
  });

  app.get<{ Params: { id: string } }>('/channels/:id/messages', async (request, reply) => {
    const guard = await authorizeChannel(deps, request, request.params.id);
    if (!guard.ok) return reply.code(guard.code).send({ error: 'not_found' });

    const query = HistoryQuery.safeParse(request.query);
    if (!query.success) return reply.code(400).send({ error: 'invalid_query' });

    const page = await readHistory(deps.db, request.params.id, query.data);
    return { messages: page };
  });

  const AroundQuery = z.object({
    around: z.coerce.number().int().positive(),
    radius: z.coerce.number().int().positive().max(100).optional(),
  });

  /**
   * A window centred on one message.
   *
   * Its own route rather than another mode of `/messages`, because the two answer different
   * questions and have different response shapes: paging backward reports one boundary, a
   * window reports two. Folding them together would mean a `hasMore` whose meaning depends on
   * which parameters were sent.
   */
  app.get<{ Params: { id: string } }>('/channels/:id/messages/around', async (request, reply) => {
    const guard = await authorizeChannel(deps, request, request.params.id);
    if (!guard.ok) return reply.code(guard.code).send({ error: 'not_found' });

    const query = AroundQuery.safeParse(request.query);
    if (!query.success) return reply.code(400).send({ error: 'invalid_query' });

    return readAround(deps.db, request.params.id, query.data.around, query.data.radius);
  });

  const HighlightQuery = z.object({
    before: z.coerce.number().int().positive().optional(),
    limit: z.coerce.number().int().positive().max(200).optional(),
  });

  /**
   * The Highlights tabs: Pinned and Announcements.
   *
   * Both read the whole channel rather than a loaded window, which is the point - v1 computed
   * them from a bounded slice, so a pin older than the loaded page silently disappeared from
   * the list that exists to keep it findable.
   *
   * The third tab, Reports, is deliberately elsewhere: it lives with the moderation routes
   * because who may read a report is a different question in a DM than in a club, and grouping
   * it here would invite it to inherit this gate.
   */
  app.get<{ Params: { id: string } }>('/channels/:id/pinned', async (request, reply) => {
    const guard = await authorizeChannel(deps, request, request.params.id);
    if (!guard.ok) return reply.code(guard.code).send({ error: 'not_found' });

    const query = HighlightQuery.safeParse(request.query);
    if (!query.success) return reply.code(400).send({ error: 'invalid_query' });

    return readHighlights(deps.db, request.params.id, 'pinned', query.data);
  });

  /**
   * Who the composer may offer for an `@`.
   *
   * Behind the same channel guard as the history read, so the pool can never be wider than the
   * conversation itself - and it is computed by the very function the send path filters against,
   * so the list cannot offer somebody the send would drop.
   */
  app.get<{ Params: { id: string } }>('/channels/:id/mentionable', async (request, reply) => {
    const guard = await authorizeChannel(deps, request, request.params.id);
    if (!guard.ok) return reply.code(guard.code).send({ error: 'not_found' });

    return {
      members: await mentionableMembers(deps.db, request.params.id, request.userId!),
    };
  });

  app.get<{ Params: { id: string } }>('/channels/:id/announcements', async (request, reply) => {
    const guard = await authorizeChannel(deps, request, request.params.id);
    if (!guard.ok) return reply.code(guard.code).send({ error: 'not_found' });

    const query = HighlightQuery.safeParse(request.query);
    if (!query.success) return reply.code(400).send({ error: 'invalid_query' });

    return readHighlights(deps.db, request.params.id, 'announcements', query.data);
  });

  const ReadBody = z.object({ upToSeq: z.number().int().nonnegative() });

  app.post<{ Params: { id: string } }>('/channels/:id/read', async (request, reply) => {
    const guard = await authorizeChannel(deps, request, request.params.id);
    if (!guard.ok) return reply.code(guard.code).send({ error: 'not_found' });

    const body = ReadBody.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid_body' });

    // Through openChat rather than straight to the cursor: opening a chat with unread
    // messages must also record a "caught up on N messages" row, so the history of
    // having caught up survives once the live count is gone.
    const opened = await openChat(deps.db, request.userId!, request.params.id);
    // An explicit upToSeq below the head still advances only as far as asked, but the
    // common case - the client reporting the head it just rendered - is the same thing.
    if (body.data.upToSeq > opened.lastReadSeq) {
      await advanceReadCursor(deps.db, request.userId!, request.params.id, body.data.upToSeq);
    }
    return {
      channelId: request.params.id,
      lastReadSeq: Math.max(opened.lastReadSeq, body.data.upToSeq),
      caughtUp: opened.caughtUp,
    };
  });

  // ---------------------------------------------------------------------
  // Reactions
  // ---------------------------------------------------------------------

  const ReactionBody = z.object({ emoji: ReactionEmoji });

  /**
   * Toggle a reaction.
   *
   * One endpoint for on and off, because "toggle" is the product behaviour and splitting it
   * into add and remove would put the decision of which to call in the client - where it is a
   * read-then-write across the network, and races with the other device the same member is
   * holding.
   *
   * `ReactionEmoji` here returns a clean 400 for an emoji outside the set. It is not the
   * enforcement: a check constraint on the column is, so no route and no second write path
   * can put arbitrary text in a column that renders directly into every client.
   */
  app.post<{ Params: { id: string; seq: string } }>(
    '/channels/:id/messages/:seq/reactions',
    async (request, reply) => {
      const seq = Number(request.params.seq);
      if (!Number.isInteger(seq) || seq <= 0) {
        return reply.code(400).send({ error: 'invalid_seq' });
      }

      const body = ReactionBody.safeParse(request.body);
      if (!body.success) return reply.code(400).send({ error: 'invalid_emoji' });

      const guard = await authorizeChannel(deps, request, request.params.id);
      if (!guard.ok) return reply.code(guard.code).send({ error: 'not_found' });

      const result = await toggleReaction(
        deps.db,
        request.access!,
        guard.channel,
        seq,
        body.data.emoji,
      );
      if (!result.ok) {
        // 403 for a member who can read but not write here - a blocked DM participant. That
        // is a real distinction rather than a leak: they can already see the message.
        return reply.code(result.code === 'forbidden' ? 403 : 404).send({ error: result.code });
      }
      return result;
    },
  );

  /** Who reacted, for the who-reacted sheet. No gate beyond reading the channel. */
  app.get<{ Params: { id: string; seq: string } }>(
    '/channels/:id/messages/:seq/reactions',
    async (request, reply) => {
      const seq = Number(request.params.seq);
      if (!Number.isInteger(seq) || seq <= 0) {
        return reply.code(400).send({ error: 'invalid_seq' });
      }

      const guard = await authorizeChannel(deps, request, request.params.id);
      if (!guard.ok) return reply.code(guard.code).send({ error: 'not_found' });

      const result = await readReactions(deps.db, guard.channel, seq);
      if (!result.ok) return reply.code(404).send({ error: 'not_found' });
      return result;
    },
  );

  // ---------------------------------------------------------------------
  // Pin, and soft delete: the column-level authority trap
  // ---------------------------------------------------------------------
  //
  // > **These two routes did not exist until Phase 3.75a, and the trap they exist to solve has
  // > therefore been unreachable since Phase 0.** `setPinned` and `softDeleteMessage` are
  // > separate commands with separate predicates precisely because a single row-level rule
  // > covering the whole message let any member pin their own message and then retro-flip it
  // > into an announcement, notifying the entire club. That shipped in v1.
  // >
  // > The remaster split the authority correctly and then routed neither command, so the fix
  // > was carefully built and could not be exercised - and, per PRD/05 rules 7 and 9, neither
  // > could pinning or deleting at all. `msg.update` gained a producer in Phase 3.5, so the
  // > realtime half has been waiting for these.
  //
  // They stay two routes rather than one PATCH over the message, because one route taking a
  // partial body is exactly the shape that reintroduces the trap: a caller who may delete
  // would be sending a payload that could also carry `pinned`.

  const PinnedBody = z.object({ pinned: z.boolean() });

  /** Admin of that space - and either participant in a DM, where pinning is not authority. */
  app.post<{ Params: { id: string; seq: string } }>(
    '/channels/:id/messages/:seq/pinned',
    async (request, reply) => {
      const seq = Number(request.params.seq);
      if (!Number.isInteger(seq) || seq <= 0) {
        return reply.code(400).send({ error: 'invalid_seq' });
      }

      const body = PinnedBody.safeParse(request.body);
      if (!body.success) return reply.code(400).send({ error: 'invalid_body' });

      const guard = await authorizeChannel(deps, request, request.params.id);
      if (!guard.ok) return reply.code(guard.code).send({ error: 'not_found' });

      const result = await setPinned(
        deps.db,
        request.access!,
        guard.channel,
        seq,
        body.data.pinned,
      );
      if (!result.ok) {
        // 403 for a member who can read the channel and may not pin in it. The channel guard
        // above already answered the existence question, so there is nothing left to hide -
        // and PRD/05 rule 7 wants "members cannot pin" to be provable by attempting it.
        return reply.code(result.code === 'forbidden' ? 403 : 404).send({ error: result.code });
      }
      return result;
    },
  );

  /**
   * Soft delete. The sender, or an admin of that space.
   *
   * A tombstone rather than a removal: a message vanishing mid-conversation makes the replies
   * around it unreadable. Reactions and pin state go with it.
   */
  app.delete<{ Params: { id: string; seq: string } }>(
    '/channels/:id/messages/:seq',
    async (request, reply) => {
      const seq = Number(request.params.seq);
      if (!Number.isInteger(seq) || seq <= 0) {
        return reply.code(400).send({ error: 'invalid_seq' });
      }

      const guard = await authorizeChannel(deps, request, request.params.id);
      if (!guard.ok) return reply.code(guard.code).send({ error: 'not_found' });

      const result = await softDeleteMessage(deps.db, request.access!, guard.channel, seq);
      if (!result.ok) {
        return reply.code(result.code === 'forbidden' ? 403 : 404).send({ error: result.code });
      }
      return result;
    },
  );

  // ---------------------------------------------------------------------
  // Mute, which is per-conversation and applies to every scope
  // ---------------------------------------------------------------------

  const MuteBody = z.object({
    /** Absent means indefinitely. The row's existence is the mute. */
    until: z.string().datetime().nullish(),
  });

  app.post<{ Params: { id: string } }>('/channels/:id/mute', async (request, reply) => {
    const body = MuteBody.safeParse(request.body ?? {});
    if (!body.success) return reply.code(400).send({ error: 'invalid_body' });

    const guard = await authorizeChannel(deps, request, request.params.id);
    if (!guard.ok) return reply.code(guard.code).send({ error: 'not_found' });

    const result = await muteChannel(
      deps.db,
      request.access!,
      guard.channel,
      body.data.until ? new Date(body.data.until) : null,
    );
    if (!result.ok) return reply.code(404).send({ error: 'not_found' });
    return result;
  });

  app.delete<{ Params: { id: string } }>('/channels/:id/mute', async (request, reply) => {
    const guard = await authorizeChannel(deps, request, request.params.id);
    if (!guard.ok) return reply.code(guard.code).send({ error: 'not_found' });

    const result = await unmuteChannel(deps.db, request.access!, guard.channel);
    if (!result.ok) return reply.code(404).send({ error: 'not_found' });
    return result;
  });
}
