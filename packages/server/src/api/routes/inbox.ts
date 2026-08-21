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
import { syncManySince, type SyncRequest } from '../../domain/reads.ts';
import { registerDevice, unregisterDevice } from '../../push/dispatch.ts';
import { authorizeChannels, type AppDeps } from '../plumbing.ts';

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

    /*
     * Three passes, and the split is what removed the per-channel cost.
     *
     * This was one loop doing all three per entry until 2026-08-21: parse, authorize with its own
     * round trip, then page with another. That cost `5 + 2n` statements for empty channels and
     * `5 + 4n` for populated ones, against a contract that admits 200 entries. `TECH/18` 2.1 had
     * already removed the CLIENT's request-per-chat and left the server paying per chat inside
     * one request.
     *
     * Parsing first also makes the refusal below cheaper and more honest: a malformed entry now
     * refuses before ANY database work happens, rather than after however many channels preceded
     * it in the list have already been read.
     */
    const wanted: SyncRequest[] = [];
    const seen = new Set<string>();

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
      const [rawChannelId, sinceRaw, revRaw] = parts;
      if (!rawChannelId) return malformed();
      /*
       * Canonicalized here, at the parse boundary, the way `parseIdList` does for a batch read.
       *
       * A uuid has two spellings and Postgres accepts both, but every per-channel `Map` below is
       * keyed by the lower case one the database returns - including `clearedFloors` in the
       * access context, which means an upper case entry would read a cleared channel's floor as
       * zero and hand back messages the member had cleared. Cost was the reason for touching this
       * loop; that was the more serious thing sitting in it.
       */
      const channelId = rawChannelId.toLowerCase();

      const since = Number(sinceRaw);
      if (!Number.isInteger(since) || since < 0) return malformed();

      let sinceRev: number | undefined;
      if (revRaw !== undefined) {
        const parsed = Number(revRaw);
        if (!Number.isInteger(parsed) || parsed < 0) return malformed();
        sinceRev = parsed;
      }

      /*
       * Duplicates collapse, keeping the first, which is `parseIdList` rule 3 applied to the
       * other list-taking surface in this API. The old loop synced a repeated channel twice and
       * answered for it twice; no client sends one, and answering the same channel two different
       * ways in one response was never a defensible thing to do.
       */
      if (seen.has(channelId)) continue;
      seen.add(channelId);
      wanted.push({ channelId, sinceSeq: since, sinceRev });
    }

    /*
     * One round trip for every channel's authorization.
     *
     * Omitted rather than refused, and this one IS deliberate: a client holding a stale channel
     * list - it was removed from a club while offline - must still sync everything else. Absent
     * from `allowed` covers both "no such channel" and "not yours", exactly as the single guard's
     * 404 conflated them, and for the same reason.
     */
    const allowed = await authorizeChannels(deps, request, wanted.map((w) => w.channelId));
    const readable = wanted.filter((w) => allowed.has(w.channelId));

    // And one set of side loads for every message in the whole response.
    const pages = await syncManySince(deps.db, request.access!, readable);

    const results = readable.map((w) => {
      const page = pages.get(w.channelId) ?? { messages: [], hasMore: false, maxRev: 0 };
      return {
        channelId: w.channelId,
        messages: page.messages,
        hasMore: page.hasMore,
        maxRev: page.maxRev,
      };
    });

    return { channels: results, serverTime: new Date().toISOString() };
  });
}
