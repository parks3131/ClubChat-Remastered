/**
 * Channel reads, the read cursor, reactions and mute.
 *
 * Every route below the channel boundary goes through `authorizeChannel` and none of them
 * re-derives access. One channel-scoped route that decides for itself is how the four
 * hand-written copies of the access join happened (pitfall 9).
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ReactionEmoji, Uuid } from '@clubchat/shared';
import {
  clearChannel,
  muteChannel,
  pinChannel,
  readChannelMeta,
  unmuteChannel,
} from '../../domain/dm.ts';
import { openChat } from '../../domain/inbox.ts';
import { mentionableMembers } from '../../domain/mentions.ts';
import { readReactions, toggleReaction } from '../../domain/reactions.ts';
import {
  advanceReadCursor,
  listAccessibleChannels,
  listConversations,
  readAround,
  readHighlights,
  readHistory,
} from '../../domain/reads.ts';
import { editMessage, setPinned, softDeleteMessage } from '../../domain/send-message.ts';
import { authorizeChannel, type AppDeps } from '../plumbing.ts';

export function registerChatRoutes(app: FastifyInstance, deps: AppDeps): void {
  const ChannelStatesQuery = z.object({ clubId: Uuid.optional() });

  /**
   * Per-channel sync state: ids, scopes, and the two numbers unread is computed from.
   *
   * `?clubId=` narrows to one club. The club hub is the only caller and badges one club's
   * rows, so unfiltered it was sent every club's channels plus every DM and discarded them:
   * 23 rows to draw 5, measured on the trace 2026-08-19. The cost grows with how many clubs
   * somebody joins and how many people they talk to, which is the wrong way round.
   *
   * **Narrowing adds no authorization surface, and that is why it is a query rather than a
   * club-scoped route.** `accessibleChannelPredicate` has already decided what this caller may
   * see; a `club_id` filter can only ever return a subset of that, never a row outside it. So
   * there is nothing here to re-check, and no second copy of the access join to drift - which
   * is the failure this file's header names.
   *
   * A malformed `clubId` is a 400 rather than an ignored parameter, for the reason the batch
   * routes give: silently dropping it would answer with every channel the caller has and look
   * like a success, hiding a client bug behind the fullest possible response.
   */
  app.get('/channels', async (request, reply) => {
    const query = ChannelStatesQuery.safeParse(request.query);
    if (!query.success) return reply.code(400).send({ error: 'invalid_query' });

    return {
      channels: await listAccessibleChannels(deps.db, request.userId!, query.data.clubId),
    };
  });

  /**
   * The unified chat list: every club chat and every DM, newest activity first.
   *
   * Distinct from `/channels` above, which is sync state - ids and sequence numbers for the
   * client's gap arithmetic, and deliberately nothing a person reads. This one is the landing
   * screen's read, carrying names, pictures, unread counts and the last thing said.
   *
   * Unpaginated, like the roster and the news feed, and bounded by the same thing: how many
   * clubs somebody belongs to plus how many people they talk to. If that ever stops being small
   * the cursor goes on `COALESCE(last.created_at, c.created_at)`, which is already the sort key.
   */
  app.get('/conversations', async (request) => ({
    conversations: await listConversations(deps.db, request.access!),
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

    const page = await readHistory(deps.db, request.access!, request.params.id, query.data);
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

    return readAround(deps.db, request.access!, request.params.id, query.data.around, query.data.radius);
  });

  const HighlightQuery = z.object({
    before: z.coerce.number().int().positive().optional(),
    limit: z.coerce.number().int().positive().max(200).optional(),
  });

  /**
   * The Pinned tab's cursor, which is a pin TIME rather than a `seq`.
   *
   * That list is ordered by when each message was pinned, and a cursor has to be in the same
   * currency as the ordering it pages: handed a `seq`, the query would filter on one axis and
   * sort on another, returning a page from the middle of nowhere with no error. Naming the
   * parameter differently is what stops a caller reaching for the wrong one by habit.
   */
  const PinnedQuery = z
    .object({
      beforePinnedAt: z.string().datetime().optional(),
      limit: z.coerce.number().int().positive().max(200).optional(),
    })
    /*
     * **Strict, so `before=<seq>` is a 400 rather than a silent no-op.**
     *
     * Zod strips unknown keys by default, so simply not declaring `before` here would accept it,
     * discard it, and return the FIRST page every time - a caller paging through pins would loop
     * on the same rows forever with a 200 on every request. Ignoring a cursor is worse than
     * rejecting one: the failure is invisible at the call site and looks like the data repeating.
     *
     * This is the same silent-strip that lost `replyToSeq` for a day (AGENTS.md 5.3), reached
     * from the other direction - there a field was sent and dropped, here one is sent and needs
     * to be refused.
     */
    .strict();

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

    const query = PinnedQuery.safeParse(request.query);
    if (!query.success) return reply.code(400).send({ error: 'invalid_query' });

    return readHighlights(deps.db, request.access!, request.params.id, 'pinned', query.data);
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

    return readHighlights(deps.db, request.access!, request.params.id, 'announcements', query.data);
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
   * Correct what you just said. The sender alone, inside five minutes.
   *
   * `/body` rather than a `PATCH` on the message, and that is the same choice the two routes
   * above make for the same reason: a partial update over the whole message is the shape that
   * lets a caller who may change one column send a payload carrying another. Here the stakes are
   * the highest of the three - a body edit that could carry `type` would let a member rewrite
   * their own text into an announcement and notify the entire club.
   *
   * `.strict()` on the body is the second half of that. Zod strips unknown keys by default, so a
   * payload carrying `type` or `pinned` alongside `body` would be quietly accepted and quietly
   * dropped; strict refuses it out loud, which is what makes "this route changes exactly one
   * column" provable by attempting the other rather than by reading the handler.
   */
  const EditBody = z
    .object({
      body: z.string().min(1).max(8000),
      /** Who the composer thinks is named, exactly as on the send path. Re-checked server-side. */
      mentions: z.array(Uuid).max(64).optional(),
    })
    .strict();

  app.post<{ Params: { id: string; seq: string } }>(
    '/channels/:id/messages/:seq/body',
    async (request, reply) => {
      const seq = Number(request.params.seq);
      if (!Number.isInteger(seq) || seq <= 0) {
        return reply.code(400).send({ error: 'invalid_seq' });
      }

      const body = EditBody.safeParse(request.body);
      if (!body.success) return reply.code(400).send({ error: 'invalid_body' });

      const guard = await authorizeChannel(deps, request, request.params.id);
      if (!guard.ok) return reply.code(guard.code).send({ error: 'not_found' });

      const result = await editMessage(
        deps.db,
        request.access!,
        guard.channel,
        seq,
        body.data.body,
        body.data.mentions,
      );
      if (!result.ok) {
        /*
         * 403 for a refusal the channel guard has already let past, so there is nothing left to
         * hide - and PRD/05 rule 9a wants "you cannot edit somebody else's message, and you
         * cannot edit your own after five minutes" to be provable by attempting it.
         *
         * 422 for the content filter, matching the send path: the request was well-formed and
         * the caller is allowed, and it is the CONTENT that is refused. A 400 would say they
         * built the request wrong, and a retry of the identical body can only fail again.
         */
        const status =
          result.code === 'forbidden'
            ? 403
            : result.code === 'not_found'
              ? 404
              : result.code === 'content_refused'
                ? 422
                : 400;
        return reply.code(status).send({ error: result.code });
      }
      return { message: result.message };
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

  /**
   * Keep a conversation at the top of your own chat list, or stop.
   *
   * POST and DELETE rather than a body carrying a boolean, matching mute above: the two are
   * separate intents and neither can be got wrong by sending the wrong payload.
   *
   * Nothing here is admin-gated, because this is a **conversation** pin and not a message one -
   * it changes nobody's view but the caller's, and is invisible to the other participants.
   */
  app.post<{ Params: { id: string } }>('/channels/:id/pin', async (request, reply) => {
    const guard = await authorizeChannel(deps, request, request.params.id);
    if (!guard.ok) return reply.code(guard.code).send({ error: 'not_found' });

    const result = await pinChannel(deps.db, request.access!, guard.channel, true);
    if (!result.ok) return reply.code(404).send({ error: 'not_found' });
    return result;
  });

  app.delete<{ Params: { id: string } }>('/channels/:id/pin', async (request, reply) => {
    const guard = await authorizeChannel(deps, request, request.params.id);
    if (!guard.ok) return reply.code(guard.code).send({ error: 'not_found' });

    const result = await pinChannel(deps.db, request.access!, guard.channel, false);
    if (!result.ok) return reply.code(404).send({ error: 'not_found' });
    return result;
  });

  /**
   * "Delete chat": hide everything said so far, for the caller only.
   *
   * A POST rather than a DELETE on the channel, deliberately - `DELETE /channels/:id` would say
   * the channel is being destroyed, and nothing here destroys anything. Everybody else keeps
   * every message and is never told.
   *
   * Available in every scope since 2026-08-06, which `canClearChannel` decides rather than this
   * route: who may clear what is a policy question, and a route that remembered the rule itself
   * is how the two drift.
   */
  app.post<{ Params: { id: string } }>('/channels/:id/clear', async (request, reply) => {
    const guard = await authorizeChannel(deps, request, request.params.id);
    if (!guard.ok) return reply.code(guard.code).send({ error: 'not_found' });

    const result = await clearChannel(deps.db, request.access!, guard.channel);
    if (!result.ok) return reply.code(404).send({ error: 'not_found' });
    return result;
  });
}
