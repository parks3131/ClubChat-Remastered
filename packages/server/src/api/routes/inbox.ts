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
import { registerDevice } from '../../push/dispatch.ts';
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
    }> = [];

    for (const entry of entries) {
      const separator = entry.lastIndexOf(':');
      if (separator <= 0) continue;
      const channelId = entry.slice(0, separator);
      const since = Number(entry.slice(separator + 1));
      if (!Number.isInteger(since) || since < 0) continue;

      const guard = await authorizeChannel(deps, request, channelId);
      if (!guard.ok) continue;

      const page = await syncSince(deps.db, request.access!, channelId, since);
      results.push({ channelId, messages: page.messages, hasMore: page.hasMore });
    }

    return { channels: results, serverTime: new Date().toISOString() };
  });
}
