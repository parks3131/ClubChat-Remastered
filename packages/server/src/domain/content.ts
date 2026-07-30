/**
 * Meetings, calendar events, routines and news.
 *
 * Four features that look alike and have deliberately different notification behaviour. The
 * differences are the interesting part, so they are stated at each command rather than left
 * to be inferred:
 *
 * | Created | Notifies | Posts a chat card |
 * |---|---|---|
 * | Meeting | Other Eboard members | Yes, into Eboard chat |
 * | Calendar event | Every other club member | Yes, into club chat |
 * | News post | Every other club member | No |
 * | Routine workout | **Nobody** | **No** |
 *
 * The routine row is not an oversight. A routine is reference material, not an event - and a
 * week of workouts authored in one sitting would otherwise fire seven notifications.
 */

import { and, eq, sql } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import { isoUtc } from '../db/sql-helpers.ts';
import {
  calendarEvents,
  meetings,
  newsPosts,
  newsReactions,
  outbox,
  routineWorkouts,
} from '../db/schema.ts';
import type { AccessContext } from '../policy/context.ts';
import {
  canCreateMeeting,
  canManageClubContent,
  canManageMeeting,
  canReadClubContent,
  isEboardMember,
} from '../policy/predicates.ts';

export type Refusal = { ok: false; code: 'forbidden' | 'not_found' | 'invalid' };
export type Result<T> = ({ ok: true } & T) | Refusal;

// ---------------------------------------------------------------------------
// Meetings
// ---------------------------------------------------------------------------

/**
 * Create a meeting. Any Eboard member - there is no further role distinction inside.
 *
 * Notifies the OTHER members and posts a card into Eboard chat. Appears on the calendar of
 * Eboard members only, which is a read-side concern handled in the calendar feed.
 */
export async function createMeeting(
  db: Db,
  ctx: AccessContext,
  input: {
    eboardId: string;
    clubId: string;
    title: string;
    description?: string | null | undefined;
    startsAt: string;
    link?: string | null | undefined;
  },
): Promise<Result<{ meetingId: string }>> {
  if (!canCreateMeeting(ctx, input.eboardId)) return { ok: false, code: 'forbidden' };

  return db.transaction(async (tx) => {
    const rows = await tx
      .insert(meetings)
      .values({
        eboardId: input.eboardId,
        creatorId: ctx.userId,
        title: input.title,
        description: input.description ?? null,
        startsAt: new Date(input.startsAt),
        link: input.link ?? null,
      })
      .returning();
    const meeting = rows[0];
    if (!meeting) throw new Error('meeting insert returned no row');

    await tx.insert(outbox).values({
      partitionKey: input.clubId,
      eventType: 'meeting.created',
      payload: {
        clubId: input.clubId,
        eboardId: input.eboardId,
        meetingId: meeting.id,
        title: meeting.title,
        actorId: ctx.userId,
      },
    });

    return { ok: true as const, meetingId: meeting.id };
  });
}

/**
 * Edit or delete a meeting. **Creator only.**
 *
 * Two explicit founder follow-ups landed on this after meetings first shipped as any-member
 * editable, which is why `creatorId` here is the authorization subject rather than audit
 * metadata. Everyone else is view-only and the detail view shows "Added by <name>".
 */
export async function updateMeeting(
  db: Db,
  ctx: AccessContext,
  meetingId: string,
  // Optional AND explicitly `undefined`-able, which `exactOptionalPropertyTypes` treats as two
  // different things: a validated body hands over the key holding undefined rather than omitting
  // it. The body below reads `!== undefined`, so both mean "leave this field alone".
  fields: {
    title?: string | undefined;
    description?: string | null | undefined;
    startsAt?: string | undefined;
    link?: string | null | undefined;
  },
): Promise<Result<{ updated: true }>> {
  const rows = await db.select().from(meetings).where(eq(meetings.id, meetingId)).limit(1);
  const meeting = rows[0];
  if (!meeting) return { ok: false, code: 'not_found' };
  // Membership of the space is required to see it at all; creatorship to change it.
  if (!isEboardMember(ctx, meeting.eboardId)) return { ok: false, code: 'not_found' };
  if (!canManageMeeting(ctx, meeting)) return { ok: false, code: 'forbidden' };

  await db
    .update(meetings)
    .set({
      ...(fields.title !== undefined ? { title: fields.title } : {}),
      ...(fields.description !== undefined ? { description: fields.description } : {}),
      ...(fields.startsAt !== undefined ? { startsAt: new Date(fields.startsAt) } : {}),
      ...(fields.link !== undefined ? { link: fields.link } : {}),
    })
    .where(eq(meetings.id, meetingId));

  return { ok: true, updated: true };
}

export async function deleteMeeting(
  db: Db,
  ctx: AccessContext,
  meetingId: string,
  clubId: string,
): Promise<Result<{ deleted: true }>> {
  const rows = await db.select().from(meetings).where(eq(meetings.id, meetingId)).limit(1);
  const meeting = rows[0];
  if (!meeting) return { ok: false, code: 'not_found' };
  if (!isEboardMember(ctx, meeting.eboardId)) return { ok: false, code: 'not_found' };
  if (!canManageMeeting(ctx, meeting)) return { ok: false, code: 'forbidden' };

  await db.transaction(async (tx) => {
    // Deleting the meeting removes its chat card rather than leaving a dead link.
    await tx.insert(outbox).values({
      partitionKey: clubId,
      eventType: 'meeting.deleted',
      payload: { clubId, meetingId, eboardId: meeting.eboardId, actorId: ctx.userId },
    });
    await tx.delete(meetings).where(eq(meetings.id, meetingId));
  });

  return { ok: true, deleted: true };
}

// ---------------------------------------------------------------------------
// Calendar events
// ---------------------------------------------------------------------------

export type EventType = 'race' | 'practice' | 'team_bonding' | 'volunteer' | 'other';

/**
 * Create a calendar event. Admin only.
 *
 * Notifies every other club member and posts a card into club chat carrying its title, date
 * and location.
 *
 * The `race` type is a **label only** with no relationship to a real Race. Creating one does
 * not create a race and never has; an open question asks whether the type should be removed
 * for reading as though it did.
 */
export async function createEvent(
  db: Db,
  ctx: AccessContext,
  input: {
    clubId: string;
    type: EventType;
    title: string;
    startsAt: string;
    endsAt?: string | null | undefined;
    location?: string | null | undefined;
    description?: string | null | undefined;
  },
): Promise<Result<{ eventId: string }>> {
  if (!canManageClubContent(ctx, input.clubId)) return { ok: false, code: 'forbidden' };

  return db.transaction(async (tx) => {
    const rows = await tx
      .insert(calendarEvents)
      .values({
        clubId: input.clubId,
        type: input.type,
        title: input.title,
        startsAt: new Date(input.startsAt),
        endsAt: input.endsAt ? new Date(input.endsAt) : null,
        location: input.location ?? null,
        description: input.description ?? null,
        createdBy: ctx.userId,
      })
      .returning();
    const event = rows[0];
    if (!event) throw new Error('event insert returned no row');

    await tx.insert(outbox).values({
      partitionKey: input.clubId,
      eventType: 'event.created',
      payload: {
        clubId: input.clubId,
        eventId: event.id,
        title: event.title,
        actorId: ctx.userId,
      },
    });

    return { ok: true as const, eventId: event.id };
  });
}

/** Edit or delete an event. Any admin, any event - not only its author. */
export async function deleteEvent(
  db: Db,
  ctx: AccessContext,
  eventId: string,
): Promise<Result<{ deleted: true }>> {
  const rows = await db
    .select()
    .from(calendarEvents)
    .where(eq(calendarEvents.id, eventId))
    .limit(1);
  const event = rows[0];
  if (!event) return { ok: false, code: 'not_found' };
  if (!canManageClubContent(ctx, event.clubId)) return { ok: false, code: 'forbidden' };

  await db.transaction(async (tx) => {
    await tx.insert(outbox).values({
      partitionKey: event.clubId,
      eventType: 'event.deleted',
      payload: { clubId: event.clubId, eventId, actorId: ctx.userId },
    });
    await tx.delete(calendarEvents).where(eq(calendarEvents.id, eventId));
  });

  return { ok: true, deleted: true };
}

// ---------------------------------------------------------------------------
// Routines
// ---------------------------------------------------------------------------

export type ActivityType =
  | 'run'
  | 'trail_run'
  | 'bike'
  | 'swim'
  | 'strength'
  | 'hybrid_fitness'
  | 'indoor_climb'
  | 'bouldering'
  | 'xc_ski'
  | 'other';

/**
 * Create a routine workout. Any club admin, and **it notifies nobody and posts nothing**.
 *
 * That silence is deliberate and is the one thing to preserve here. A routine is reference
 * material rather than an event, and an admin authoring a week of them in one sitting would
 * otherwise fire seven notifications at every member. Note the absence of an outbox write
 * below - there is no event because there is no effect.
 */
export async function createWorkout(
  db: Db,
  ctx: AccessContext,
  input: {
    clubId: string;
    workoutDate: string;
    activityType: ActivityType;
    title: string;
    description?: string | null | undefined;
  },
): Promise<Result<{ workoutId: string }>> {
  if (!canManageClubContent(ctx, input.clubId)) return { ok: false, code: 'forbidden' };

  const rows = await db
    .insert(routineWorkouts)
    .values({
      clubId: input.clubId,
      workoutDate: input.workoutDate,
      activityType: input.activityType,
      title: input.title,
      description: input.description ?? null,
      createdBy: ctx.userId,
    })
    .returning();
  const workout = rows[0];
  if (!workout) throw new Error('workout insert returned no row');

  // No outbox event, on purpose. See above.
  return { ok: true, workoutId: workout.id };
}

/** Any admin can edit or delete any workout, not only its author. */
export async function deleteWorkout(
  db: Db,
  ctx: AccessContext,
  workoutId: string,
): Promise<Result<{ deleted: true }>> {
  const rows = await db
    .select()
    .from(routineWorkouts)
    .where(eq(routineWorkouts.id, workoutId))
    .limit(1);
  const workout = rows[0];
  if (!workout) return { ok: false, code: 'not_found' };
  if (!canManageClubContent(ctx, workout.clubId)) return { ok: false, code: 'forbidden' };

  await db.delete(routineWorkouts).where(eq(routineWorkouts.id, workoutId));
  return { ok: true, deleted: true };
}

export type WeekDay = {
  date: string;
  workouts: Array<{
    id: string;
    activityType: ActivityType;
    title: string;
    description: string | null;
  }>;
  /** True when nothing is scheduled. Rendered explicitly as "Rest day", never omitted. */
  restDay: boolean;
};

/**
 * One real calendar week, Monday through Sunday.
 *
 * Not a repeating template - the week is a plan for specific dates. Two rules live here:
 *
 *  - **A day with no workout is a rest day, explicitly.** An empty day is otherwise ambiguous
 *    between "rest" and "not posted yet", so the flag is returned rather than left for the
 *    client to infer from an absence.
 *  - **On the current week, only today and future days are shown.** The week is a plan, not a
 *    record. Paging back shows all seven days.
 */
export async function readRoutineWeek(
  db: Db,
  ctx: AccessContext,
  clubId: string,
  mondayIso: string,
): Promise<Result<{ days: WeekDay[] }>> {
  if (!canReadClubContent(ctx, clubId)) return { ok: false, code: 'not_found' };

  const rows = await db.execute<{
    id: string;
    workout_date: string;
    activity_type: string;
    title: string;
    description: string | null;
  }>(sql`
    SELECT id, workout_date, activity_type, title, description
      FROM routine_workouts
     WHERE club_id = ${clubId}
       AND workout_date >= ${mondayIso}::date
       AND workout_date < ${mondayIso}::date + interval '7 days'
     ORDER BY workout_date, created_at
  `);

  const byDate = new Map<string, WeekDay['workouts']>();
  for (const row of rows.rows) {
    // Split components, never a parsed ISO string: a date-only value parsed as ISO is UTC
    // midnight and renders a day early in negative-offset timezones.
    const key = String(row.workout_date).slice(0, 10);
    const list = byDate.get(key) ?? [];
    list.push({
      id: row.id,
      activityType: row.activity_type as ActivityType,
      title: row.title,
      description: row.description,
    });
    byDate.set(key, list);
  }

  const monday = new Date(`${mondayIso}T00:00:00Z`);
  const todayIso = new Date().toISOString().slice(0, 10);
  const days: WeekDay[] = [];

  for (let offset = 0; offset < 7; offset += 1) {
    const day = new Date(monday);
    day.setUTCDate(monday.getUTCDate() + offset);
    const iso = day.toISOString().slice(0, 10);

    // Hide past days of the CURRENT week only. A past week shows all seven.
    const isCurrentWeek = todayIso >= mondayIso && todayIso < isoPlusDays(mondayIso, 7);
    if (isCurrentWeek && iso < todayIso) continue;

    const workouts = byDate.get(iso) ?? [];
    days.push({ date: iso, workouts, restDay: workouts.length === 0 });
  }

  return { ok: true, days };
}

function isoPlusDays(iso: string, days: number): string {
  const date = new Date(`${iso}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// News
// ---------------------------------------------------------------------------

/**
 * Create a news post. Any club admin.
 *
 * **Must have body text, a photo, or both.** The check constraint enforces it too, so this
 * refusal is about a clear error rather than about safety.
 *
 * **Creating notifies every other club member. Editing and deleting notify nobody.**
 */
export async function createNewsPost(
  db: Db,
  ctx: AccessContext,
  input: { clubId: string; body?: string | null | undefined; mediaId?: string | null | undefined },
): Promise<Result<{ postId: string }>> {
  if (!canManageClubContent(ctx, input.clubId)) return { ok: false, code: 'forbidden' };
  const hasBody = (input.body ?? '').trim().length > 0;
  if (!hasBody && !input.mediaId) return { ok: false, code: 'invalid' };

  return db.transaction(async (tx) => {
    const rows = await tx
      .insert(newsPosts)
      .values({
        clubId: input.clubId,
        authorId: ctx.userId,
        body: hasBody ? (input.body ?? null) : null,
        mediaId: input.mediaId ?? null,
      })
      .returning();
    const post = rows[0];
    if (!post) throw new Error('news post insert returned no row');

    await tx.insert(outbox).values({
      partitionKey: input.clubId,
      eventType: 'news.created',
      payload: { clubId: input.clubId, postId: post.id, actorId: ctx.userId },
    });

    return { ok: true as const, postId: post.id };
  });
}

/**
 * Edit a post. **Any club admin can edit any post**, not only its author.
 *
 * Notifies nobody - editing is a correction, not an announcement. Note there is no outbox
 * write here, which is the mechanism of that silence rather than a comment claiming it.
 */
export async function updateNewsPost(
  db: Db,
  ctx: AccessContext,
  postId: string,
  fields: { body?: string | null | undefined; mediaId?: string | null | undefined },
): Promise<Result<{ updated: true }>> {
  const rows = await db.select().from(newsPosts).where(eq(newsPosts.id, postId)).limit(1);
  const post = rows[0];
  if (!post) return { ok: false, code: 'not_found' };
  if (!canManageClubContent(ctx, post.clubId)) return { ok: false, code: 'forbidden' };

  const nextBody = fields.body !== undefined ? fields.body : post.body;
  const nextMedia = fields.mediaId !== undefined ? fields.mediaId : post.mediaId;
  // Still cannot end up empty, whichever field the edit touched.
  if (!(nextBody ?? '').trim() && !nextMedia) return { ok: false, code: 'invalid' };

  await db
    .update(newsPosts)
    .set({ body: nextBody, mediaId: nextMedia, updatedAt: new Date() })
    .where(eq(newsPosts.id, postId));

  return { ok: true, updated: true };
}

/**
 * Delete a post. Permanent, **with no tombstone**.
 *
 * Unlike a chat message: there is no surrounding conversation that a gap would make
 * unreadable, so the soft-delete reasoning does not apply here.
 */
export async function deleteNewsPost(
  db: Db,
  ctx: AccessContext,
  postId: string,
): Promise<Result<{ deleted: true }>> {
  const rows = await db.select().from(newsPosts).where(eq(newsPosts.id, postId)).limit(1);
  const post = rows[0];
  if (!post) return { ok: false, code: 'not_found' };
  if (!canManageClubContent(ctx, post.clubId)) return { ok: false, code: 'forbidden' };

  await db.delete(newsPosts).where(eq(newsPosts.id, postId));
  return { ok: true, deleted: true };
}

/** React to a post, or remove your own reaction. One of each emoji per member per post. */
export async function toggleNewsReaction(
  db: Db,
  ctx: AccessContext,
  postId: string,
  emoji: string,
): Promise<Result<{ reacted: boolean }>> {
  const rows = await db.select().from(newsPosts).where(eq(newsPosts.id, postId)).limit(1);
  const post = rows[0];
  if (!post) return { ok: false, code: 'not_found' };
  // Every club member can react, not just admins.
  if (!canReadClubContent(ctx, post.clubId)) return { ok: false, code: 'not_found' };

  const existing = await db
    .select()
    .from(newsReactions)
    .where(
      and(
        eq(newsReactions.postId, postId),
        eq(newsReactions.userId, ctx.userId),
        eq(newsReactions.emoji, emoji),
      ),
    )
    .limit(1);

  if (existing.length > 0) {
    await db
      .delete(newsReactions)
      .where(
        and(
          eq(newsReactions.postId, postId),
          eq(newsReactions.userId, ctx.userId),
          eq(newsReactions.emoji, emoji),
        ),
      );
    return { ok: true, reacted: false };
  }

  await db
    .insert(newsReactions)
    .values({ postId, userId: ctx.userId, emoji })
    .onConflictDoNothing();
  return { ok: true, reacted: true };
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------
//
// `readRoutineWeek` above was the only read this module had. The meetings list, a single
// meeting and the news feed are all screens in PRD/15 with nothing behind them, which is the
// shape of gap Phase 3.75a exists to close.

export type MeetingSummary = {
  id: string;
  title: string;
  startsAt: string;
  link: string | null;
  creatorId: string;
  creatorName: string;
  /** Only the creator may edit or delete, in every case. */
  isCreator: boolean;
};

export type MeetingDetail = MeetingSummary & {
  description: string | null;
  eboardId: string;
  /** Resolved from the space, never taken from a caller. Effects route on it. */
  clubId: string;
};

/**
 * Upcoming or past meetings for one Eboard space.
 *
 * Split on `starts_at` against now rather than stored as a flag, for the same reason a poll's
 * closed-ness is evaluated at read time: a meeting becomes past by the clock passing it, and
 * nothing should have to run for that to be true.
 *
 * Ordering differs per half on purpose - upcoming ascending, so the next one is first; past
 * descending, so the most recent is first. Both put the meeting a reader is looking for at the
 * top of the list they opened.
 */
export async function listMeetings(
  db: Db,
  ctx: AccessContext,
  eboardId: string,
  when: 'upcoming' | 'past',
): Promise<Result<{ meetings: MeetingSummary[] }>> {
  if (!isEboardMember(ctx, eboardId)) return { ok: false, code: 'not_found' };

  const rows = await db.execute<{
    id: string;
    title: string;
    starts_at: string;
    link: string | null;
    creator_id: string;
    full_name: string;
  }>(sql`
    SELECT m.id::text AS id,
           m.title,
           ${isoUtc('m.starts_at')} AS starts_at,
           m.link,
           m.creator_id::text AS creator_id,
           u.full_name
      FROM meetings m
      JOIN users u ON u.id = m.creator_id
     WHERE m.eboard_id = ${eboardId}
       AND ${when === 'upcoming' ? sql`m.starts_at >= now()` : sql`m.starts_at < now()`}
     ORDER BY m.starts_at ${when === 'upcoming' ? sql`ASC` : sql`DESC`}
  `);

  return {
    ok: true,
    meetings: rows.rows.map((row) => ({
      id: row.id,
      title: row.title,
      startsAt: row.starts_at,
      link: row.link,
      creatorId: row.creator_id,
      creatorName: row.full_name,
      isCreator: row.creator_id === ctx.userId,
    })),
  };
}

/** One meeting. Members of the space only; the detail view shows "Added by <name>". */
export async function readMeeting(
  db: Db,
  ctx: AccessContext,
  meetingId: string,
): Promise<Result<{ meeting: MeetingDetail }>> {
  const rows = await db.execute<{
    id: string;
    title: string;
    description: string | null;
    starts_at: string;
    link: string | null;
    creator_id: string;
    full_name: string;
    eboard_id: string;
    club_id: string;
  }>(sql`
    SELECT m.id::text AS id,
           m.title,
           m.description,
           ${isoUtc('m.starts_at')} AS starts_at,
           m.link,
           m.creator_id::text AS creator_id,
           u.full_name,
           m.eboard_id::text AS eboard_id,
           eb.club_id::text AS club_id
      FROM meetings m
      JOIN users u ON u.id = m.creator_id
      JOIN eboard_channels eb ON eb.id = m.eboard_id
     WHERE m.id = ${meetingId}
  `);

  const row = rows.rows[0];
  if (!row) return { ok: false, code: 'not_found' };
  if (!isEboardMember(ctx, row.eboard_id)) return { ok: false, code: 'not_found' };

  return {
    ok: true,
    meeting: {
      id: row.id,
      title: row.title,
      description: row.description,
      startsAt: row.starts_at,
      link: row.link,
      creatorId: row.creator_id,
      creatorName: row.full_name,
      isCreator: row.creator_id === ctx.userId,
      eboardId: row.eboard_id,
      clubId: row.club_id,
    },
  };
}

export const NEWS_PAGE_SIZE = 20;

export type NewsPostView = {
  id: string;
  body: string | null;
  mediaId: string | null;
  authorId: string;
  authorName: string;
  authorImage: string | null;
  createdAt: string;
  updatedAt: string | null;
  /** Every emoji with a count, and whether this viewer is in it. */
  reactions: Array<{ emoji: string; count: number; mine: boolean }>;
};

/**
 * The club's front page: reverse-chronological, newest first.
 *
 * **No pinning and no ordering controls** (PRD/06 rule 2), which is the difference from chat
 * Highlights and the reason there is no sort parameter here.
 *
 * Paged by a `before` timestamp rather than an offset, because an offset shifts under a page
 * whenever a newer post lands - and this feed's whole job is that new posts land at the top.
 */
export async function readNewsFeed(
  db: Db,
  ctx: AccessContext,
  clubId: string,
  opts: { before?: string | undefined; limit?: number | undefined } = {},
): Promise<Result<{ posts: NewsPostView[]; hasMore: boolean }>> {
  if (!canReadClubContent(ctx, clubId)) return { ok: false, code: 'not_found' };

  const limit = Math.min(opts.limit ?? NEWS_PAGE_SIZE, 100);

  const rows = await db.execute<{
    id: string;
    body: string | null;
    media_id: string | null;
    author_id: string;
    full_name: string;
    image: string | null;
    created_at: string;
    updated_at: string | null;
  }>(sql`
    SELECT p.id::text AS id,
           p.body,
           p.media_id::text AS media_id,
           p.author_id::text AS author_id,
           u.full_name,
           u.image,
           ${isoUtc('p.created_at')} AS created_at,
           ${isoUtc('p.updated_at')} AS updated_at
      FROM news_posts p
      JOIN users u ON u.id = p.author_id
     WHERE p.club_id = ${clubId}
       ${opts.before ? sql`AND p.created_at < ${opts.before}::timestamptz` : sql``}
     ORDER BY p.created_at DESC
     LIMIT ${limit + 1}
  `);

  // One row over the limit answers "is there more" without a second count query.
  const hasMore = rows.rows.length > limit;
  const page = hasMore ? rows.rows.slice(0, limit) : rows.rows;

  return {
    ok: true,
    posts: await withReactions(db, ctx, page),
    hasMore,
  };
}

/** One post, for the permalink a notification opens. */
export async function readNewsPost(
  db: Db,
  ctx: AccessContext,
  postId: string,
): Promise<Result<{ post: NewsPostView }>> {
  const rows = await db.execute<{
    id: string;
    club_id: string;
    body: string | null;
    media_id: string | null;
    author_id: string;
    full_name: string;
    image: string | null;
    created_at: string;
    updated_at: string | null;
  }>(sql`
    SELECT p.id::text AS id,
           p.club_id::text AS club_id,
           p.body,
           p.media_id::text AS media_id,
           p.author_id::text AS author_id,
           u.full_name,
           u.image,
           ${isoUtc('p.created_at')} AS created_at,
           ${isoUtc('p.updated_at')} AS updated_at
      FROM news_posts p
      JOIN users u ON u.id = p.author_id
     WHERE p.id = ${postId}
  `);

  const row = rows.rows[0];
  if (!row) return { ok: false, code: 'not_found' };
  if (!canReadClubContent(ctx, row.club_id)) return { ok: false, code: 'not_found' };

  const [post] = await withReactions(db, ctx, [row]);
  if (!post) return { ok: false, code: 'not_found' };
  return { ok: true, post };
}

/**
 * Attach reaction summaries to a page of posts in ONE query.
 *
 * Not one query per post: a feed of twenty would otherwise cost twenty round trips for
 * something the client renders as a single row of counts. The same reasoning as
 * `reactionsForMessages` on the chat side, and the same shape - grouped by emoji with the
 * viewer's own membership resolved server-side, because "did I react" cannot be derived from
 * a count.
 */
async function withReactions(
  db: Db,
  ctx: AccessContext,
  rows: ReadonlyArray<{
    id: string;
    body: string | null;
    media_id: string | null;
    author_id: string;
    full_name: string;
    image: string | null;
    created_at: string;
    updated_at: string | null;
  }>,
): Promise<NewsPostView[]> {
  if (rows.length === 0) return [];

  const ids = rows.map((row) => row.id);
  const reactionRows = await db.execute<{
    post_id: string;
    emoji: string;
    count: string;
    mine: boolean;
  }>(sql`
    SELECT post_id::text AS post_id,
           emoji,
           count(*) AS count,
           bool_or(user_id = ${ctx.userId}) AS mine
      FROM news_reactions
     WHERE post_id = ANY(${sql.param(ids)}::uuid[])
     GROUP BY post_id, emoji
     ORDER BY emoji
  `);

  const byPost = new Map<string, NewsPostView['reactions']>();
  for (const row of reactionRows.rows) {
    const list = byPost.get(row.post_id) ?? [];
    list.push({ emoji: row.emoji, count: Number(row.count), mine: row.mine });
    byPost.set(row.post_id, list);
  }

  return rows.map((row) => ({
    id: row.id,
    body: row.body,
    mediaId: row.media_id,
    authorId: row.author_id,
    authorName: row.full_name,
    authorImage: row.image,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    reactions: byPost.get(row.id) ?? [],
  }));
}
