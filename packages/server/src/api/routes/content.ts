/**
 * Meetings, calendar events, meetups and news.
 *
 * Four features that look alike and notify deliberately differently. The table lives in the
 * domain module; what matters at this layer is that none of these routes accepts a `clubId`.
 * `createMeeting` and `deleteMeeting` take one - used only to route their effects - and a wrong
 * one would send a notification and a chat card into the wrong club. It is resolved from the
 * space instead, by `clubIdOfEboard`.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ReactionEmoji } from '@clubchat/shared';
import {
  createEvent,
  createMeeting,
  createNewsPost,
  createMeetup,
  deleteEvent,
  updateEvent,
  deleteMeeting,
  deleteNewsPost,
  deleteMeetup,
  listMeetings,
  MAX_NEWS_PHOTOS,
  NEWS_ASPECTS,
  readEvent,
  readEvents,
  readMeeting,
  readNewsFeed,
  readNewsPost,
  nudgeMeetup,
  readMeetup,
  readMeetupWeek,
  updateMeetup,
  toggleNewsReaction,
  updateMeeting,
  updateNewsPost,
} from '../../domain/content.ts';
import { searchMemberCandidates } from '../../domain/member-candidates.ts';
import { clubIdOfEboard } from '../../domain/scopes.ts';
import { parseIdList, refusalStatus, type AppDeps } from '../plumbing.ts';

/** A calendar day, never a timestamp - see the `raceDate` note on the race routes. */
const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD');

export function registerContentRoutes(app: FastifyInstance, deps: AppDeps): void {
  /**
   * 403 where the caller can already see the thing, 404 otherwise.
   *
   * Meetings are the case that needs it: both handlers check membership of the space before
   * checking creatorship, so a `forbidden` reached somebody who can read the meeting and is
   * merely not its creator. PRD/10 puts that distinction on screen - any member creates
   * meetings, only the creator edits one - so the API has to make it expressible.
   */
  const creatorStatus = (code: string): number =>
    code === 'forbidden' ? 403 : refusalStatus(code);

  // ---------------------------------------------------------------------
  // Meetings
  // ---------------------------------------------------------------------

  const MeetingBody = z.object({
    title: z.string().min(1).max(300),
    description: z.string().max(5_000).nullish(),
    startsAt: z.string().datetime(),
    link: z.string().max(2_000).nullish(),
  });

  app.post<{ Params: { id: string } }>('/eboards/:id/meetings', async (request, reply) => {
    const body = MeetingBody.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ error: 'invalid_body', issues: body.error.issues });
    }

    const clubId = await clubIdOfEboard(deps.db, request.params.id);
    if (clubId === null) return reply.code(404).send({ error: 'not_found' });

    const result = await createMeeting(deps.db, request.access!, {
      eboardId: request.params.id,
      clubId,
      ...body.data,
    });
    if (!result.ok) return reply.code(refusalStatus(result.code)).send({ error: result.code });
    return reply.code(201).send(result);
  });

  const WhenQuery = z.object({ when: z.enum(['upcoming', 'past']).default('upcoming') });

  app.get<{ Params: { id: string } }>('/eboards/:id/meetings', async (request, reply) => {
    const query = WhenQuery.safeParse(request.query);
    if (!query.success) return reply.code(400).send({ error: 'invalid_query' });

    const result = await listMeetings(
      deps.db,
      request.access!,
      request.params.id,
      query.data.when,
    );
    if (!result.ok) return reply.code(refusalStatus(result.code)).send({ error: result.code });
    return result;
  });

  app.get<{ Params: { id: string } }>('/meetings/:id', async (request, reply) => {
    const result = await readMeeting(deps.db, request.access!, request.params.id);
    if (!result.ok) return reply.code(refusalStatus(result.code)).send({ error: result.code });
    return result;
  });

  /**
   * Edit a meeting. **Creator only**, unlike creating one.
   *
   * A true partial update, unlike Meet Information: an absent field keeps its value rather than
   * clearing it. The two differ because the products differ - Meet Information is five fields
   * of one form, and a meeting is a record with independently editable parts.
   */
  const MeetingPatch = z.object({
    title: z.string().min(1).max(300).optional(),
    description: z.string().max(5_000).nullish(),
    startsAt: z.string().datetime().optional(),
    link: z.string().max(2_000).nullish(),
  });

  app.patch<{ Params: { id: string } }>('/meetings/:id', async (request, reply) => {
    const body = MeetingPatch.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid_body' });

    const result = await updateMeeting(deps.db, request.access!, request.params.id, body.data);
    if (!result.ok) return reply.code(creatorStatus(result.code)).send({ error: result.code });
    return result;
  });

  app.delete<{ Params: { id: string } }>('/meetings/:id', async (request, reply) => {
    // Read first, so the club the effects route on comes from the meeting's own space rather
    // than from the caller. The read is itself membership-gated, so this also refuses a
    // non-member before the delete is attempted.
    const found = await readMeeting(deps.db, request.access!, request.params.id);
    if (!found.ok) return reply.code(refusalStatus(found.code)).send({ error: found.code });

    const result = await deleteMeeting(
      deps.db,
      request.access!,
      request.params.id,
      found.meeting.clubId,
    );
    if (!result.ok) return reply.code(creatorStatus(result.code)).send({ error: result.code });
    return result;
  });

  // ---------------------------------------------------------------------
  // Calendar events
  // ---------------------------------------------------------------------

  const EventBody = z.object({
    // `race` is a LABEL with no relationship to a real Race. Creating one does not create a
    // race and never has; whether the type should exist at all is an open question in PRD/17.
    type: z.enum(['race', 'practice', 'team_bonding', 'volunteer', 'other']),
    title: z.string().min(1).max(300),
    startsAt: z.string().datetime(),
    endsAt: z.string().datetime().nullish(),
    location: z.string().max(500).nullish(),
    // Same bound the meetup's link uses. Anything that is not a map link is dropped by
    // `createEvent` rather than refused, because a link is optional and a bad one is not an error.
    mapUrl: z.string().trim().max(2_000).nullish(),
    description: z.string().max(5_000).nullish(),
  });

  app.post<{ Params: { id: string } }>('/clubs/:id/events', async (request, reply) => {
    const body = EventBody.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ error: 'invalid_body', issues: body.error.issues });
    }
    const result = await createEvent(deps.db, request.access!, {
      clubId: request.params.id,
      ...body.data,
    });
    if (!result.ok) return reply.code(refusalStatus(result.code)).send({ error: result.code });
    return reply.code(201).send(result);
  });

  /**
   * One event. **Every club member**, not only the admins who create them.
   *
   * Creating an event notifies the whole club and posts a card into club chat, and both of those
   * are links to this. Gating the read at admin would leave every member holding a notification
   * that opens nothing.
   */
  app.get<{ Params: { id: string } }>('/events/:id', async (request, reply) => {
    const result = await readEvent(deps.db, request.access!, request.params.id);
    if (!result.ok) return reply.code(refusalStatus(result.code)).send({ error: result.code });
    return result;
  });

  /**
   * The same read, for several events at once.
   *
   * The twin of `GET /polls`, for the same reason and with the same rules - one club chat drew
   * ten event cards and paid ten requests for them. Authorization is still the same predicate
   * applied once per id rather than a batched query with a predicate of its own; what changed on
   * 2026-08-21 is that the LOOP moved into `readEvents`, so the predicate is applied per id
   * against rows fetched in a single round trip. An event the caller may not read is absent
   * rather than an error, exactly as before.
   */
  app.get('/events', async (request, reply) => {
    const parsed = parseIdList((request.query as { ids?: unknown }).ids);
    if (!parsed.ok) return reply.code(400).send({ error: parsed.error });

    /*
     * One round trip for the whole list, not one per id.
     *
     * This looped `readEvent` until 2026-08-21, which cost `3 + n` statements - 23 for twenty
     * ids, measured against the club-sized fixture. `readEvents` authorizes each id with the
     * same predicate the loop did and returns them in the order asked, so an id that is gone or
     * unreadable is still simply absent from the answer.
     */
    return { events: await readEvents(deps.db, request.access!, parsed.ids) };
  });

  /**
   * Edit an event. Any club admin, any event - not only its author, and notifying nobody.
   *
   * Takes the whole event, like the meetup and news-post PATCHes beside it: the composer holds
   * the entire form, and a field omitted from a partial update cannot be told apart from a field
   * deliberately cleared.
   */
  app.patch<{ Params: { id: string } }>('/events/:id', async (request, reply) => {
    const body = EventBody.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ error: 'invalid_body', issues: body.error.issues });
    }
    const result = await updateEvent(deps.db, request.access!, request.params.id, body.data);
    if (!result.ok) return reply.code(refusalStatus(result.code)).send({ error: result.code });
    return result;
  });

  app.delete<{ Params: { id: string } }>('/events/:id', async (request, reply) => {
    const result = await deleteEvent(deps.db, request.access!, request.params.id);
    if (!result.ok) return reply.code(refusalStatus(result.code)).send({ error: result.code });
    return result;
  });

  // ---------------------------------------------------------------------
  // Weekly Meetups
  // ---------------------------------------------------------------------

  /**
   * Where, when and what. **There is no activity type**, and adding one back is a decision
   * ADR-0029 already made and rejected - the free-text description is where what the club is
   * doing lives, in that club's own words.
   *
   * `title` and `meetupTime` are required rather than nullable, and `location` is not: the form
   * stopped asking for a place on 2026-08-15 (ADR-0037) and the name took its place as the thing
   * that identifies a meetup.
   *
   * **This body is a whole form, so an absent field means empty**, which is the rule `TECH/10`
   * draws for anything saved as one form. Every caller therefore has to send back what it does
   * not edit - see the meetup composer, which passes `location` through untouched for exactly
   * that reason.
   */
  const MeetupBody = z.object({
    meetupDate: IsoDate,
    meetupTime: z
      .string()
      .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'expected HH:MM')
      .describe('Wall-clock in the club own day. Never an instant - see ADR-0029.'),
    /**
     * **Required since 2026-08-15**, when the place stopped being collected. Something has to
     * name a meetup, and with no place this is the only thing that can.
     */
    title: z.string().trim().min(1).max(120),
    description: z.string().max(5_000).nullish(),
    locationNotes: z.string().max(2_000).nullish(),
    /*
     * A LINK, and the only answer to "where" a meetup has. A link on a host that is not a map is
     * dropped rather than stored, because whatever is stored ends up behind a Directions button
     * that every member of the club taps.
     *
     * No coordinates are accepted alongside it. They were, until ADR-0049 removed the columns
     * they fed - an older client that still sends `mapLat`/`mapLng` has them ignored here rather
     * than refused, which is what `nullish()` on everything else already means for a field the
     * server has stopped caring about.
     */
    mapUrl: z.string().trim().max(2_000).nullish(),
  });

  /** Notifies nobody and posts nothing. A meetup is reference material, not an event. */
  app.post<{ Params: { id: string } }>('/clubs/:id/meetups', async (request, reply) => {
    const body = MeetupBody.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ error: 'invalid_body', issues: body.error.issues });
    }
    const result = await createMeetup(deps.db, request.access!, {
      clubId: request.params.id,
      ...body.data,
    });
    if (!result.ok) return reply.code(refusalStatus(result.code)).send({ error: result.code });
    return reply.code(201).send(result);
  });

  /** Any admin edits any meetup, not only its author. */
  app.patch<{ Params: { id: string } }>('/meetups/:id', async (request, reply) => {
    const body = MeetupBody.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ error: 'invalid_body', issues: body.error.issues });
    }
    const result = await updateMeetup(deps.db, request.access!, request.params.id, body.data);
    if (!result.ok) return reply.code(refusalStatus(result.code)).send({ error: result.code });
    return result;
  });

  app.delete<{ Params: { id: string } }>('/meetups/:id', async (request, reply) => {
    const result = await deleteMeetup(deps.db, request.access!, request.params.id);
    if (!result.ok) return reply.code(refusalStatus(result.code)).send({ error: result.code });
    return result;
  });

  /**
   * Nudge: push one meetup at the club, at most once an hour **per meetup** (ADR-0031).
   *
   * 409 rather than 404 when the bell is cooling down, and the body carries `availableAt` - the
   * refusal has to say WHEN, or an admin told only "no" taps it again a minute later. A meetup
   * on any day but today is `not_today`, also 409: it is a conflict with the calendar rather
   * than a permission problem, and saying `not_found` about a meetup plainly on screen would be
   * a lie.
   */
  app.post<{ Params: { id: string } }>('/meetups/:id/nudge', async (request, reply) => {
    const result = await nudgeMeetup(deps.db, request.access!, request.params.id);
    if (!result.ok) {
      return reply.code(refusalStatus(result.code)).send(
        result.code === 'cooling_down'
          ? { error: result.code, availableAt: result.availableAt }
          : { error: result.code },
      );
    }
    return reply.code(202).send(result);
  });

  const WeekQuery = z.object({ monday: IsoDate });

  /**
   * One real calendar week, Monday through Sunday.
   *
   * The Monday is required rather than defaulted, because "this week" is a question about the
   * caller's timezone and the server has no business guessing it.
   */
  // One meetup, for its own screen. Club membership reads it; a club you are not in answers 404
  // rather than 403, so an id cannot be probed for whether it names something real.
  app.get<{ Params: { id: string } }>('/meetups/:id', async (request, reply) => {
    const result = await readMeetup(deps.db, request.access!, request.params.id);
    if (!result.ok) return reply.code(refusalStatus(result.code)).send({ error: result.code });
    return result;
  });

  app.get<{ Params: { id: string } }>('/clubs/:id/meetups', async (request, reply) => {
    const query = WeekQuery.safeParse(request.query);
    if (!query.success) return reply.code(400).send({ error: 'invalid_query' });

    const result = await readMeetupWeek(
      deps.db,
      request.access!,
      request.params.id,
      query.data.monday,
    );
    if (!result.ok) return reply.code(refusalStatus(result.code)).send({ error: result.code });
    return result;
  });

  // ---------------------------------------------------------------------
  // News
  // ---------------------------------------------------------------------

  /**
   * What a post is written from.
   *
   * `mediaIds` is capped here as well as by the check constraint, so a client sending seven
   * photos is told which rule it broke rather than watching a transaction die. The ORDER of the
   * array is the carousel's order - this is the only place it is expressed, since the ordinal
   * is derived from the index rather than sent.
   *
   * Every field is `nullish` in the same sense `PRD/06` rule 7 means: absent leaves it alone on
   * an edit, explicit null clears it.
   */
  const NewsBody = z.object({
    title: z.string().max(200).nullish(),
    body: z.string().max(10_000).nullish(),
    mediaIds: z.array(z.string().uuid()).max(MAX_NEWS_PHOTOS).optional(),
    aspect: z.enum(NEWS_ASPECTS).optional(),
    locationName: z.string().max(200).nullish(),
    locationUrl: z.string().max(2_000).nullish(),
    peopleIds: z.array(z.string().uuid()).max(200).optional(),
  });

  app.post<{ Params: { id: string } }>('/clubs/:id/news', async (request, reply) => {
    const body = NewsBody.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid_body' });

    const result = await createNewsPost(deps.db, request.access!, {
      clubId: request.params.id,
      ...body.data,
    });
    if (!result.ok) {
      // 400 for `invalid`: an entirely empty post is a malformed request rather than a
      // refusal, and the check constraint says the same thing one layer down.
      return reply
        .code(result.code === 'invalid' ? 400 : refusalStatus(result.code))
        .send({ error: result.code });
    }
    return reply.code(201).send(result);
  });

  const FeedQuery = z.object({
    before: z.string().datetime().optional(),
    limit: z.coerce.number().int().positive().max(100).optional(),
    /** PRD/06 rule 17: the feed's search box, over titles and tags, within this club only. */
    q: z.string().max(200).optional(),
  });

  app.get<{ Params: { id: string } }>('/clubs/:id/news', async (request, reply) => {
    const query = FeedQuery.safeParse(request.query);
    if (!query.success) return reply.code(400).send({ error: 'invalid_query' });

    const result = await readNewsFeed(deps.db, request.access!, request.params.id, query.data);
    if (!result.ok) return reply.code(refusalStatus(result.code)).send({ error: result.code });
    return result;
  });

  /**
   * Who a post in this club can name: members of that club (ADR-0040).
   *
   * **Keyed on the club, not on a post**, because the composer is usually open on a post that
   * does not exist yet. The same read backs the roster picker on three other screens, so the
   * interaction the founder asked for - *"it should pop the search like how we will add people
   * to a race"* - is the same component and not a copy of it.
   *
   * Refuses with `not_found` rather than `forbidden` for a caller who may not post, which is the
   * non-disclosing refusal the rest of this surface uses: an empty list would leak the roster by
   * exclusion.
   */
  const CandidateQuery = z.object({
    q: z.string().max(200).optional(),
    limit: z.coerce.number().int().positive().max(200).optional(),
  });

  app.get<{ Params: { id: string } }>(
    '/clubs/:id/news/member-candidates',
    async (request, reply) => {
      const query = CandidateQuery.safeParse(request.query);
      if (!query.success) return reply.code(400).send({ error: 'invalid_query' });

      const result = await searchMemberCandidates(
        deps.db,
        request.access!,
        { kind: 'news', clubId: request.params.id },
        { query: query.data.q, limit: query.data.limit },
      );
      if (!result.ok) return reply.code(refusalStatus(result.code)).send({ error: result.code });
      return result;
    },
  );

  app.get<{ Params: { id: string } }>('/news/:id', async (request, reply) => {
    const result = await readNewsPost(deps.db, request.access!, request.params.id);
    if (!result.ok) return reply.code(refusalStatus(result.code)).send({ error: result.code });
    return result;
  });

  /** Any club admin edits any post, not only its author. Notifies nobody. */
  app.patch<{ Params: { id: string } }>('/news/:id', async (request, reply) => {
    const body = NewsBody.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid_body' });

    const result = await updateNewsPost(deps.db, request.access!, request.params.id, body.data);
    if (!result.ok) {
      return reply
        .code(result.code === 'invalid' ? 400 : refusalStatus(result.code))
        .send({ error: result.code });
    }
    return result;
  });

  app.delete<{ Params: { id: string } }>('/news/:id', async (request, reply) => {
    const result = await deleteNewsPost(deps.db, request.access!, request.params.id);
    if (!result.ok) return reply.code(refusalStatus(result.code)).send({ error: result.code });
    return result;
  });

  const NewsReactionBody = z.object({ emoji: ReactionEmoji });

  /**
   * React to a post, or remove your own reaction. **Every club member**, not only admins.
   *
   * `ReactionEmoji` is the same set chat uses, which PRD/06 rule 4 requires. As with message
   * reactions it is not the enforcement - a check constraint on the column is, added in this
   * phase because until a route existed the rule held only for want of a writer.
   */
  app.post<{ Params: { id: string } }>('/news/:id/reactions', async (request, reply) => {
    const body = NewsReactionBody.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid_emoji' });

    const result = await toggleNewsReaction(
      deps.db,
      request.access!,
      request.params.id,
      body.data.emoji,
    );
    if (!result.ok) return reply.code(refusalStatus(result.code)).send({ error: result.code });
    return result;
  });
}
