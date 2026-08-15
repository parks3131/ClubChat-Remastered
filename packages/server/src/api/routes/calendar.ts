/**
 * The merged calendar.
 *
 * Two views over one read, which is the design: a month grid and an Upcoming/Past list. There
 * is no calendar table for anything to write into, so these routes cannot serve a stale copy -
 * see the domain module for why that was chosen over a denormalised feed.
 *
 * Omitting `club` gives the cross-club view, which tags every row with its club and offers no
 * create action. That is a product rule rather than an authorization one, and it is why the
 * parameter is optional rather than two separate routes.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { readCalendarFeed, readMonthMarkers } from '../../domain/calendar.ts';
import type { AppDeps } from '../plumbing.ts';

export function registerCalendarRoutes(app: FastifyInstance, deps: AppDeps): void {
  const FeedQuery = z.object({
    club: z.string().uuid().optional(),
    /** Upcoming and Past come from one read, split by the caller or by this filter. */
    when: z.enum(['upcoming', 'past', 'all']).default('all'),
  });

  /**
   * The merged feed.
   *
   * No refusal branch, and that is not an omission: every access rule is inside the query, so
   * a club the caller does not belong to contributes no rows rather than producing an error.
   * A caller passing somebody else's club id gets an empty list, which is the same answer as a
   * club with nothing in it - and deliberately so.
   */
  app.get('/calendar', async (request, reply) => {
    const query = FeedQuery.safeParse(request.query);
    if (!query.success) return reply.code(400).send({ error: 'invalid_query' });

    const items = await readCalendarFeed(deps.db, request.access!, {
      clubId: query.data.club,
    });

    const filtered =
      query.data.when === 'all'
        ? items
        : items.filter((item) => item.upcoming === (query.data.when === 'upcoming'));

    // Upcoming ascending and Past descending: both put the row the reader opened the tab for
    // at the top. Every row is dated, so there is no undated tail to sort last - that branch
    // existed for a deadline-less poll and went with polls on 2026-08-15.
    const sorted = [...filtered].sort((a, b) =>
      query.data.when === 'past' ? b.at.localeCompare(a.at) : a.at.localeCompare(b.at),
    );

    return { items: sorted };
  });

  const MarkerQuery = z.object({
    club: z.string().uuid().optional(),
    year: z.coerce.number().int().min(1970).max(2999),
    month: z.coerce.number().int().min(1).max(12),
  });

  /**
   * Which days of a month carry something.
   *
   * Only days inside the requested month are returned, so a filler day borrowed from an
   * adjacent month cannot be marked by accident.
   */
  app.get('/calendar/markers', async (request, reply) => {
    const query = MarkerQuery.safeParse(request.query);
    if (!query.success) return reply.code(400).send({ error: 'invalid_query' });

    return {
      days: await readMonthMarkers(deps.db, request.access!, {
        clubId: query.data.club,
        year: query.data.year,
        month: query.data.month,
      }),
    };
  });
}
