/**
 * The notification inbox, the badge, device registration, and sync.
 *
 * The clearing rules are the interesting part and they live in the domain, not here: opening
 * the inbox clears the badge but neither the chat-unread rows nor the pending join requests.
 * See `markInboxRead`.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { Platform } from '@clubchat/shared';
import { badgeCount, markInboxRead, readInbox } from '../../domain/inbox.ts';
import { syncSince } from '../../domain/reads.ts';
import { registerDevice, unregisterDevice } from '../../push/dispatch.ts';
import { authorizeChannel, type AppDeps } from '../plumbing.ts';

export function registerInboxRoutes(app: FastifyInstance, deps: AppDeps): void {
  const InboxQuery = z.object({
    cursor: z.string().optional(),
    limit: z.coerce.number().int().positive().max(100).optional(),
  });

  app.get('/notifications', async (request, reply) => {
    const query = InboxQuery.safeParse(request.query);
    if (!query.success) return reply.code(400).send({ error: 'invalid_query' });
    return readInbox(deps.db, request.userId!, query.data);
  });

  app.get('/notifications/badge', async (request) => ({
    count: await badgeCount(deps.db, request.userId!),
  }));

  /**
   * Opening the inbox.
   *
   * Clears the badge, but NOT chat-unread rows (only opening that chat does) and NOT
   * pending join requests (only opening the relevant roster does). See markInboxRead.
   */
  app.post('/notifications/read', async (request) => ({
    ...(await markInboxRead(deps.db, request.userId!)),
    badge: await badgeCount(deps.db, request.userId!),
  }));

  const DeviceBody = z.object({
    pushToken: z.string().min(1).max(400),
    platform: Platform,
  });

  app.post('/devices', async (request, reply) => {
    const body = DeviceBody.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid_body' });
    const device = await registerDevice(deps.db, {
      userId: request.userId!,
      ...body.data,
    });
    return reply.code(201).send(device);
  });

  /**
   * Signing out: stop this phone ringing for the account that just left it.
   *
   * **204 whether or not a row was there.** The client calls this on the way out and cannot
   * usefully do anything with "no such device" - the token may never have registered, or another
   * sign-out may have won the race. Answering identically also declines to tell a caller whether
   * a token they supplied exists, which is the same non-disclosure the block and report paths
   * keep.
   */
  app.delete('/devices', async (request, reply) => {
    const body = z.object({ pushToken: z.string().min(1).max(400) }).safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid_body' });
    await unregisterDevice(deps.db, {
      userId: request.userId!,
      pushToken: body.data.pushToken,
    });
    return reply.code(204).send();
  });

  /**
   * The reconnect and foreground path.
   *
   * `?channels[]={id}:{since_seq}`, repeated per channel. Each entry is authorized
   * independently and an unauthorized id is omitted from the response rather than
   * failing the whole call - a client holding a stale channel list (it was removed
   * from a club while offline) must still be able to sync the rest.
   */
  app.get('/sync', async (request, reply) => {
    const raw = (request.query as Record<string, unknown>)['channels[]'] ?? [];
    const entries = (Array.isArray(raw) ? raw : [raw]).map(String).filter(Boolean);
    if (entries.length === 0) return reply.code(400).send({ error: 'no_channels' });
    if (entries.length > 200) return reply.code(400).send({ error: 'too_many_channels' });

    const results: Array<{
      channelId: string;
      messages: unknown[];
      hasMore: boolean;
      maxRev: number;
    }> = [];

    for (const entry of entries) {
      /*
       * `{id}:{since_seq}` or `{id}:{since_seq}:{since_rev}`.
       *
       * Parsed from the LEFT rather than by splitting on the last colon, because a channel id is
       * a uuid and contains none - and the previous `lastIndexOf` would read the rev as the seq
       * the moment a third field appeared. The rev is optional so a client that has not been
       * updated keeps the old behaviour exactly rather than being refused.
       *
       * > **An entry that does not parse is a 400, and that is a correction rather than a
       * > preference.** It used to `continue`, so a malformed entry was answered with `200` and a
       * > response that simply did not mention that channel - indistinguishable from a channel the
       * > caller may not read. The iOS client spent months in exactly that hole: its URL arrived
       * > double-encoded, every entry failed this parse, and every sync reported success while
       * > reconciling nothing. **Skipping an unauthorized channel is deliberate; skipping a
       * > malformed one hides a client bug behind a success.**
       */
      const parts = entry.split(':');
      const malformed = () =>
        reply.code(400).send({ error: 'bad_channel_entry', entry: entry.slice(0, 120) });
      if (parts.length < 2 || parts.length > 3) return malformed();
      const [channelId, sinceRaw, revRaw] = parts;
      if (!channelId) return malformed();

      const since = Number(sinceRaw);
      if (!Number.isInteger(since) || since < 0) return malformed();

      let sinceRev: number | undefined;
      if (revRaw !== undefined) {
        const parsed = Number(revRaw);
        if (!Number.isInteger(parsed) || parsed < 0) return malformed();
        sinceRev = parsed;
      }

      // Omitted rather than refused, and this one IS deliberate: a client holding a stale channel
      // list - it was removed from a club while offline - must still sync everything else.
      const guard = await authorizeChannel(deps, request, channelId);
      if (!guard.ok) continue;

      const page = await syncSince(
        deps.db,
        request.access!,
        channelId,
        since,
        undefined,
        sinceRev,
      );
      results.push({
        channelId,
        messages: page.messages,
        hasMore: page.hasMore,
        maxRev: page.maxRev,
      });
    }

    return { channels: results, serverTime: new Date().toISOString() };
  });
}
