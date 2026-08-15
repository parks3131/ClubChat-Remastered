/**
 * Meetings, calendar events, meetups and news.
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
 * | Meetup | **Nobody** | **No** |
 *
 * The meetup row is not an oversight. A meetup is reference material, not an event - and a week
 * of them authored in one sitting would otherwise fire seven notifications. That silence is what
 * makes Weekly Meetups a separate surface from the calendar rather than a view over it, and the
 * one deliberate exception to it is Nudge, which is a person choosing to send one.
 */

import { and, eq, sql } from 'drizzle-orm';
import { isMapLink } from '@clubchat/shared';
import type { Db } from '../db/client.ts';
import { isoUtc } from '../db/sql-helpers.ts';
import { resolveMapPoint } from '../maps.ts';
import {
  calendarEvents,
  meetings,
  newsPosts,
  newsReactions,
  meetupNudges,
  meetups,
  outbox,
} from '../db/schema.ts';
import type { AccessContext } from '../policy/context.ts';
import {
  canCancelMeeting,
  canCreateMeeting,
  canEditMeeting,
  canManageClubContent,
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
 * Edit a meeting. **Creator only** - unlike cancelling it, which any member may do.
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
  if (!canEditMeeting(ctx, meeting)) return { ok: false, code: 'forbidden' };

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

/**
 * Cancel a meeting. **Any member of the space, not only the one who scheduled it.**
 *
 * The deliberate asymmetry with `updateMeeting` above: a meeting nobody but one absent member
 * could call off is the failure this avoids, where editing somebody else's record is the failure
 * the creator-only rule avoids. See `canCancelMeeting`.
 *
 * The title rides along in the payload because the effect narrates the cancellation into board
 * chat as "X cancelled <title>", and by the time that handler runs the row is gone - so this is
 * the last moment the title exists to be read.
 */
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
  // The same predicate as the line above, stated anyway: "who can see this" and "who can cancel
  // it" are two rules that happen to coincide, and collapsing them would hide that they do.
  if (!canCancelMeeting(ctx, meeting.eboardId)) return { ok: false, code: 'forbidden' };

  await db.transaction(async (tx) => {
    // Deleting the meeting removes its chat card and leaves a cancellation line in its place,
    // rather than having the card silently vanish from the conversation.
    await tx.insert(outbox).values({
      partitionKey: clubId,
      eventType: 'meeting.deleted',
      payload: {
        clubId,
        meetingId,
        eboardId: meeting.eboardId,
        title: meeting.title,
        actorId: ctx.userId,
      },
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
// Weekly Meetups
// ---------------------------------------------------------------------------

/**
 * What one meetup carries. Where, when, and what - and deliberately nothing else.
 *
 * There is **no type, category or kind field**, and its absence is the design rather than an
 * omission: see ADR-0029, which records the per-club catalog of activity types that was
 * specified in full and then rejected. `description` is the only place what the club is doing
 * is ever recorded, in whatever words that club uses.
 */
type MeetupInput = {
  /** A real calendar date, `YYYY-MM-DD`. Never an instant - see `readMeetupWeek`. */
  meetupDate: string;
  /** Wall-clock `HH:MM`, in the club's own day. Required. */
  meetupTime: string;
  /**
   * The place as free text. **Optional since 2026-08-15, and the form no longer asks for it.**
   *
   * The founder replaced it with a pasted map link - "the link is the place". Still accepted so
   * an older client and the 80 meetups that already carry text keep working.
   */
  location?: string | null | undefined;
  description?: string | null | undefined;
  /**
   * What the club calls this one. **Required**, since the place stopped being.
   *
   * Something has to name a meetup, and this is the only thing left that can. It is also what
   * lets the feature belong to a club that is not a running club - "morning book reading", "swim
   * practice night".
   */
  title: string;
  /** How to find the club once you are there. The map pin cannot say "the wooden archway". */
  locationNotes?: string | null | undefined;
  /**
   * A Google or Apple Maps link, pasted.
   *
   * The client sends a LINK and never a coordinate. The server reads the point out of it - see
   * `resolveMapPoint` - so a phone cannot put a pin wherever it likes, and a link on a host that
   * is not a map is dropped rather than stored, because whatever is stored here ends up behind a
   * Directions button that opens it.
   */
  mapUrl?: string | null | undefined;
  /**
   * A point the admin placed by hand, when a link could not supply one.
   *
   * > **This exists because a Google "share a place" link carries no coordinates at all.** Found
   * > on the device on 2026-08-15: the short link resolves, at every hop, to a place NAME and a
   * > feature id - never a point. Apple Maps links and Google dropped-pin links do carry one, so
   * > those still need no tap. See `ADR-0037`.
   *
   * When both are present the TAP wins: somebody chose it deliberately, on a map, while looking
   * at where the club meets. The range is still checked here and again by a CHECK constraint,
   * because a coordinate arriving from a client is a coordinate arriving from a client.
   */
  mapLat?: number | null | undefined;
  mapLng?: number | null | undefined;
};

/**
 * What a pasted link becomes on the way into the row: the link if it is a map link at all, and
 * the point if one can be found.
 *
 * Both halves are decided here rather than at either call site, so create and edit cannot drift -
 * the shape of bug `AGENTS.md` failure mode 31 is about, where two statements that must always
 * happen together eventually become one.
 */
/**
 * The stored pair, back into a point for the wire.
 *
 * `numeric` arrives as a string, and both halves are present or neither - the database holds that
 * with a CHECK rather than this function trusting it, but this is still written to require both,
 * because half a coordinate reaching a map centres it on the wrong line rather than failing.
 */
function toPoint(lat: string | null, lng: string | null): { lat: number; lng: number } | null {
  if (lat === null || lng === null) return null;
  const point = { lat: Number(lat), lng: Number(lng) };
  return Number.isFinite(point.lat) && Number.isFinite(point.lng) ? point : null;
}

async function mapFields(
  raw: string | null | undefined,
  placed?: { lat?: number | null | undefined; lng?: number | null | undefined },
): Promise<{ mapUrl: string | null; mapLat: string | null; mapLng: string | null }> {
  const link = typeof raw === 'string' ? raw.trim() : '';
  const url = link.length > 0 && isMapLink(link) ? link : null;

  /*
   * A hand-placed pin wins over whatever the link says.
   *
   * Deliberate, and the order is the decision: a link is a guess about where somebody meant, and a
   * tap on a map is somebody saying it. The range check is here AND on the column, because this
   * value now arrives from a client rather than from a URL the server read.
   */
  const lat = placed?.lat ?? null;
  const lng = placed?.lng ?? null;
  if (
    typeof lat === 'number' &&
    typeof lng === 'number' &&
    Number.isFinite(lat) &&
    Number.isFinite(lng) &&
    Math.abs(lat) <= 90 &&
    Math.abs(lng) <= 180
  ) {
    return { mapUrl: url, mapLat: String(lat), mapLng: String(lng) };
  }

  // Not a map link: not stored at all. A Directions button must never open an arbitrary URL.
  if (url === null) return { mapUrl: null, mapLat: null, mapLng: null };

  const point = await resolveMapPoint(url);
  return {
    mapUrl: url,
    // `numeric` columns are read and written as strings, which is the point of them: a coordinate
    // that round-trips through a float comes back as 42.088699999999996.
    mapLat: point === null ? null : String(point.lat),
    mapLng: point === null ? null : String(point.lng),
  };
}

/**
 * Create a meetup. Any club admin, and **it notifies nobody and posts nothing**.
 *
 * That silence is deliberate and is the one thing to preserve here. A meetup is reference
 * material rather than an event, and an admin authoring a week of them in one sitting would
 * otherwise fire seven notifications at every member. Note the absence of an outbox write
 * below - there is no event because there is no effect.
 */
export async function createMeetup(
  db: Db,
  ctx: AccessContext,
  input: { clubId: string } & MeetupInput,
): Promise<Result<{ meetupId: string }>> {
  if (!canManageClubContent(ctx, input.clubId)) return { ok: false, code: 'forbidden' };

  const rows = await db
    .insert(meetups)
    .values({
      clubId: input.clubId,
      meetupDate: input.meetupDate,
      meetupTime: input.meetupTime,
      location: input.location ?? null,
      description: input.description ?? null,
      title: input.title,
      locationNotes: input.locationNotes ?? null,
      ...(await mapFields(input.mapUrl, { lat: input.mapLat, lng: input.mapLng })),
      createdBy: ctx.userId,
    })
    .returning();
  const meetup = rows[0];
  if (!meetup) throw new Error('meetup insert returned no row');

  // No outbox event, on purpose. See above.
  return { ok: true, meetupId: meetup.id };
}

/**
 * Any admin can edit any meetup, not only its author - the same rule as calendar events, and
 * the opposite of a meeting. A cancelled session that only its absent author could correct is
 * the failure this avoids.
 *
 * Editing notifies nobody either, for the same reason creating does not.
 */
export async function updateMeetup(
  db: Db,
  ctx: AccessContext,
  meetupId: string,
  input: MeetupInput,
): Promise<Result<{ updated: true }>> {
  const rows = await db.select().from(meetups).where(eq(meetups.id, meetupId)).limit(1);
  const meetup = rows[0];
  if (!meetup) return { ok: false, code: 'not_found' };
  if (!canManageClubContent(ctx, meetup.clubId)) return { ok: false, code: 'forbidden' };

  await db
    .update(meetups)
    .set({
      meetupDate: input.meetupDate,
      meetupTime: input.meetupTime,
      location: input.location ?? null,
      description: input.description ?? null,
      title: input.title,
      locationNotes: input.locationNotes ?? null,
      // Re-resolved rather than kept: an edit that changes the link has to change the point with
      // it, and an edit that clears the link has to clear the pin. Leaving the old coordinates
      // behind would draw a map of where the club used to meet.
      ...(await mapFields(input.mapUrl, { lat: input.mapLat, lng: input.mapLng })),
    })
    .where(eq(meetups.id, meetupId));
  return { ok: true, updated: true };
}

/**
 * One meetup, for its own screen.
 *
 * > **A meetup had no detail screen until 2026-08-15, and `ADR-0036` said it was not getting
 * > one** - the week carried every action, so a row that opened a screen about itself would have
 * > been a second place to read the same four lines. What changed is what a meetup holds: a name,
 * > location notes and a map do not fit a row, and the founder's mockup put them on a screen.
 *
 * Read access is club membership, the same as the week - `canReadClubContent`. The club's name
 * comes back with it because the screen leads with it and a second round trip for one string is
 * the kind of thing that makes a screen feel slow.
 */
export async function readMeetup(
  db: Db,
  ctx: AccessContext,
  meetupId: string,
): Promise<Result<{ meetup: MeetupDetail }>> {
  const rows = await db.execute<{
    id: string;
    club_id: string;
    club_name: string;
    meetup_date: string;
    meetup_time: string;
    location: string;
    description: string | null;
    title: string;
    location_notes: string | null;
    map_url: string | null;
    map_lat: string | null;
    map_lng: string | null;
  }>(sql`
    SELECT m.id, m.club_id, cl.name AS club_name, m.meetup_date, m.meetup_time,
           m.location, m.description, m.title, m.location_notes,
           m.map_url, m.map_lat::text, m.map_lng::text
      FROM meetups m
      JOIN clubs cl ON cl.id = m.club_id
     WHERE m.id = ${meetupId}
     LIMIT 1
  `);

  const row = rows.rows[0];
  if (!row) return { ok: false, code: 'not_found' };
  /*
   * Not `forbidden`. A meetup in a club the viewer is not in must not be distinguishable from a
   * meetup that does not exist - the same shape every other read in this module uses, so an id
   * cannot be probed for whether it names something real.
   */
  if (!canReadClubContent(ctx, row.club_id)) return { ok: false, code: 'not_found' };

  return {
    ok: true,
    meetup: {
      id: row.id,
      clubId: row.club_id,
      clubName: row.club_name,
      // Split, never parsed: a date-only value read as an instant is UTC midnight and renders a
      // day early west of Greenwich.
      date: String(row.meetup_date).slice(0, 10),
      time: String(row.meetup_time).slice(0, 5),
      location: row.location,
      description: row.description,
      title: row.title,
      locationNotes: row.location_notes,
      mapUrl: row.map_url,
      mapPoint: toPoint(row.map_lat, row.map_lng),
    },
  };
}

export type MeetupDetail = {
  id: string;
  clubId: string;
  clubName: string;
  /** `YYYY-MM-DD`, the club's own day. */
  date: string;
  /** `HH:MM`, the club's own clock. */
  time: string;
  location: string | null;
  description: string | null;
  title: string;
  locationNotes: string | null;
  mapUrl: string | null;
  mapPoint: { lat: number; lng: number } | null;
};

/** Any admin can delete any meetup, not only its author. */
export async function deleteMeetup(
  db: Db,
  ctx: AccessContext,
  meetupId: string,
): Promise<Result<{ deleted: true }>> {
  const rows = await db.select().from(meetups).where(eq(meetups.id, meetupId)).limit(1);
  const meetup = rows[0];
  if (!meetup) return { ok: false, code: 'not_found' };
  if (!canManageClubContent(ctx, meetup.clubId)) return { ok: false, code: 'forbidden' };

  await db.delete(meetups).where(eq(meetups.id, meetupId));
  return { ok: true, deleted: true };
}

/**
 * The outcome of tapping the bell.
 *
 * `cooling_down` carries **when the bell comes back**, which is why this is its own result type
 * rather than the shared `Refusal`: "you cannot" is a worse answer than "not until 10:00", and an
 * admin told only the first will tap it again in a minute.
 */
export type NudgeResult =
  | { ok: true; cooldownUntil: string }
  | { ok: false; code: 'forbidden' | 'not_found' | 'not_today' }
  | { ok: false; code: 'cooling_down'; availableAt: string };

/** Postgres `exclusion_violation`. The cooldown losing a race is this and nothing else. */
const EXCLUSION_VIOLATION = '23P01';

/**
 * Walk the cause chain looking for the exclusion violation.
 *
 * **Not `error.code`.** Drizzle wraps the driver's error, so the pg code sits on `.cause` rather
 * than on the error that surfaces - and reading only the top level makes this look like an
 * unrelated crash, which is exactly how it first presented.
 */
function isExclusionViolation(error: unknown): boolean {
  for (let e: unknown = error; e != null; e = (e as { cause?: unknown }).cause) {
    if ((e as { code?: string }).code === EXCLUSION_VIOLATION) return true;
  }
  return false;
}

/**
 * Nudge a meetup: push it to every other member of the club, at most once an hour.
 *
 * **This is the single deliberate exception to Weekly Meetups notifying nobody** (PRD/08 rule 11).
 * The rule is not weakened by it - creating seven meetups still fires zero notifications. What
 * changes is that a person can choose to send one, which is a different act from the app deciding
 * to buzz.
 *
 * **The hour is per MEETUP** (ADR-0031, superseding ADR-0030's per-club rule), and it is enforced
 * by an `EXCLUDE` constraint rather than by the read below. The read exists so the refusal can
 * name a time; the constraint is what stays true when two admins tap the same bell in the same
 * second, which a read-then-write cannot.
 *
 * **Only TODAY's meetups can be nudged**, and that one IS a handler check rather than a
 * constraint - deliberately. "Is this date today" is a question whose answer changes with the
 * clock, so it is not immutable and cannot live in an index. There is also no race to lose: two
 * admins nudging a meetup on the wrong day are both simply wrong, where two admins nudging a live
 * one are competing for a single slot.
 *
 * Today and **not** today-or-later: a nudge means "we are meeting, today", so ringing it about
 * next Tuesday is premature rather than early. A past day has nothing left to say at all.
 */
export async function nudgeMeetup(
  db: Db,
  ctx: AccessContext,
  meetupId: string,
): Promise<NudgeResult> {
  const rows = await db.select().from(meetups).where(eq(meetups.id, meetupId)).limit(1);
  const meetup = rows[0];
  if (!meetup) return { ok: false, code: 'not_found' };
  if (!canManageClubContent(ctx, meetup.clubId)) return { ok: false, code: 'forbidden' };

  /*
   * Today only. Compared by DATE, not by instant, so this morning's run is still nudgeable this
   * evening - the rule is about the day, not the moment, and a bell that died at 06:31 would be
   * the more surprising reading.
   */
  if (meetup.meetupDate !== todayIso()) return { ok: false, code: 'not_today' };

  const open = await openCooldown(db, meetup.id);
  if (open) return { ok: false, code: 'cooling_down', availableAt: open };

  try {
    return await db.transaction(async (tx) => {
      const inserted = await tx
        .insert(meetupNudges)
        .values({ clubId: meetup.clubId, meetupId: meetup.id, actorId: ctx.userId })
        .returning();
      const nudge = inserted[0];
      if (!nudge) throw new Error('nudge insert returned no row');

      await tx.insert(outbox).values({
        partitionKey: meetup.clubId,
        eventType: 'meetup.nudged',
        payload: {
          clubId: meetup.clubId,
          meetupId: meetup.id,
          meetupDate: meetup.meetupDate,
          // HH:MM on the wire, as everywhere else. Postgres hands back HH:MM:SS.
          meetupTime: String(meetup.meetupTime).slice(0, 5),
          location: meetup.location,
          actorId: ctx.userId,
        },
      });

      return { ok: true as const, cooldownUntil: nudge.cooldownUntil.toISOString() };
    });
  } catch (error) {
    // Lost the race rather than hit a bug: another admin's nudge committed between the read
    // above and this insert. Re-read so the refusal still names a time.
    if (!isExclusionViolation(error)) throw error;
    const now = await openCooldown(db, meetup.id);
    return { ok: false, code: 'cooling_down', availableAt: now ?? new Date().toISOString() };
  }
}

/** When THIS meetup's bell comes back, or null if it is live. */
async function openCooldown(db: Db, meetupId: string): Promise<string | null> {
  const rows = await db.execute<{ cooldown_until: string }>(sql`
    SELECT ${isoUtc('cooldown_until')} AS cooldown_until
      FROM meetup_nudges
     WHERE meetup_id = ${meetupId} AND cooldown_until > now()
     ORDER BY cooldown_until DESC
     LIMIT 1
  `);
  return rows.rows[0]?.cooldown_until ?? null;
}

/**
 * Today, as the club's own calendar date.
 *
 * The same expression `readMeetupWeek` uses to mark a day past, and deliberately the same: a day
 * the week draws as gone must not carry a live bell. The two were coupled more tightly still when
 * the week HID those days; now that it shows them, this comparison is the only thing refusing a
 * nudge on one, which is why `nudgeMeetup` makes it again rather than trusting the read.
 */
function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

export type WeekDay = {
  date: string;
  /** Several may share a day, in time order. A morning session and an evening social are two. */
  meetups: Array<{
    id: string;
    /** `HH:MM`. Wall-clock in the club's day, never converted to the reader's zone. */
    time: string;
    /** The place as text, for the meetups that carry it. New ones do not - see the schema. */
    location: string | null;
    description: string | null;
    /** What the club calls it. The headline, everywhere, and required since 2026-08-15. */
    title: string;
    /** How to find the club once you are there. */
    locationNotes: string | null;
    /** The pasted Google or Apple Maps link, or null. Opens in Maps; see `mapPoint` for the pin. */
    mapUrl: string | null;
    /**
     * The point read out of `mapUrl`, or null when it had none.
     *
     * Null with a `mapUrl` present is an ordinary state, not a failure: a link to a named place
     * with no coordinates still opens in Maps, it just cannot be drawn.
     */
    mapPoint: { lat: number; lng: number } | null;
    /**
     * When THIS meetup's bell comes back, or null if it is live.
     *
     * Per meetup since ADR-0031: four meetups in a day carry four clocks, so this cannot be one
     * field on the week. A past day is never nudgeable at all, and the server says so here
     * rather than leaving the client to compare dates and reach a different answer.
     */
    nudgeBlockedUntil: string | null;
    /** True only on today's date. A nudge says "we are meeting, today". */
    nudgeable: boolean;
  }>;
  /** True when nothing is planned. Rendered explicitly as "Nothing planned", never omitted. */
  empty: boolean;
  /**
   * A day that has already gone. Shown, and not addable to.
   *
   * This is what replaced hiding those days outright. The week still refuses to be a diary you
   * write into backwards - `createMeetup` and the client both stop at today - but it can be read
   * backwards, which it has to be now that the calendar can point a member at any day of it.
   */
  past: boolean;
};

/**
 * One real calendar week, Monday through Sunday.
 *
 * Not a repeating template - the week is a plan for specific dates. Three rules live here:
 *
 *  - **A day with nothing on it is empty, explicitly.** An empty day is otherwise ambiguous
 *    between "nothing is happening" and "nobody has posted yet", so the flag is returned rather
 *    than left for the client to infer from an absence.
 *  - **All seven days are returned, and a past one is marked rather than dropped.** Until
 *    2026-08-15 the current week hid the days that had gone, which made a past meetup on the
 *    calendar unreachable - see the loop below. `past` is what carries the old rule's intent now:
 *    the day is readable and cannot be added to.
 *  - **A day may hold several meetups**, ordered by time. Nothing here limits it to one.
 */
export async function readMeetupWeek(
  db: Db,
  ctx: AccessContext,
  clubId: string,
  mondayIso: string,
): Promise<Result<{ days: WeekDay[] }>> {
  if (!canReadClubContent(ctx, clubId)) return { ok: false, code: 'not_found' };

  /*
   * One read, with each meetup's own open cooldown joined on.
   *
   * A query per meetup would be seven-plus round trips for one screen; the lateral is what keeps
   * "four clocks" from costing four times the work.
   */
  const rows = await db.execute<{
    id: string;
    meetup_date: string;
    meetup_time: string;
    location: string;
    description: string | null;
    title: string;
    location_notes: string | null;
    map_url: string | null;
    map_lat: string | null;
    map_lng: string | null;
    cooldown_until: string | null;
  }>(sql`
    SELECT m.id, m.meetup_date, m.meetup_time, m.location, m.description,
           m.title, m.location_notes, m.map_url, m.map_lat::text, m.map_lng::text,
           ${isoUtc('n.cooldown_until')} AS cooldown_until
      FROM meetups m
      LEFT JOIN LATERAL (
        SELECT cooldown_until
          FROM meetup_nudges
         WHERE meetup_id = m.id AND cooldown_until > now()
         ORDER BY cooldown_until DESC
         LIMIT 1
      ) n ON true
     WHERE m.club_id = ${clubId}
       AND m.meetup_date >= ${mondayIso}::date
       AND m.meetup_date < ${mondayIso}::date + interval '7 days'
     ORDER BY m.meetup_date, m.meetup_time, m.created_at
  `);

  /* One clock for the whole read, so the hide rule and the nudge rule cannot disagree. */
  const today = todayIso();

  const byDate = new Map<string, WeekDay['meetups']>();
  for (const row of rows.rows) {
    // Split components, never a parsed ISO string: a date-only value parsed as ISO is UTC
    // midnight and renders a day early in negative-offset timezones.
    const key = String(row.meetup_date).slice(0, 10);
    const list = byDate.get(key) ?? [];
    list.push({
      id: row.id,
      // Postgres hands back HH:MM:SS. The seconds are always zero and nobody wants to read
      // them, so the wire format is HH:MM and the trim happens once, here.
      time: String(row.meetup_time).slice(0, 5),
      location: row.location,
      description: row.description,
      title: row.title,
      locationNotes: row.location_notes,
      mapUrl: row.map_url,
      mapPoint: toPoint(row.map_lat, row.map_lng),
      nudgeBlockedUntil: row.cooldown_until,
      // Today only, and decided here so the client cannot reach a different answer.
      nudgeable: key === today,
    });
    byDate.set(key, list);
  }

  const monday = new Date(`${mondayIso}T00:00:00Z`);
  const days: WeekDay[] = [];

  for (let offset = 0; offset < 7; offset += 1) {
    const day = new Date(monday);
    day.setUTCDate(monday.getUTCDate() + offset);
    const iso = day.toISOString().slice(0, 10);

    /*
     * Every day of the week is returned, past ones included, and marked rather than dropped.
     *
     * > **This used to skip past days of the current week**, on the reasoning that the week is a
     * > plan rather than a record. That stopped being tenable on 2026-08-15, when meetups joined
     * > the calendar (`ADR-0036`): the calendar shows every day, so tapping a meetup on a past
     * > day opened this screen onto a week that structurally could not show it. Worse, it was the
     * > one case no amount of paging could reach - the day is inside the current week, so PREVIOUS
     * > jumps past it. Reported from the phone with a video the same afternoon.
     *
     * The flag is what keeps "a plan, not a record" true where it matters: a past day is shown
     * and cannot be added to. Nudging a past meetup is refused independently, by `nudgeMeetup`
     * comparing its own date - not by this day being absent.
     */
    const dayMeetups = byDate.get(iso) ?? [];
    days.push({
      date: iso,
      meetups: dayMeetups,
      empty: dayMeetups.length === 0,
      past: iso < today,
    });
  }

  return { ok: true, days };
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
// `readMeetupWeek` above was the only read this module had. The meetings list, a single
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

export type EventDetail = {
  id: string;
  clubId: string;
  type: EventType;
  title: string;
  startsAt: string;
  endsAt: string | null;
  location: string | null;
  description: string | null;
  /** Null once the creator's account is gone - `created_by` is `on delete set null`. */
  creatorId: string | null;
  creatorName: string | null;
  /**
   * Whether this viewer may delete it. **Any club admin, not only the creator** - which is the
   * exact opposite of a poll, where only its creator can.
   *
   * The asymmetry is deliberate rather than an oversight in one of the two. A poll is a question
   * somebody asked and the answer belongs to them; an event is club business on a shared
   * calendar, and a cancelled practice nobody but the absent creator can remove is the failure
   * that rule avoids. Both live in `PRD/07`.
   */
  canManage: boolean;
};

/**
 * One event, for the screen a notification and a chat card open.
 *
 * Readable by **every club member**, not only the admins who create them: an event is announced
 * to the whole club, so a notification that could not be opened by the people it was sent to
 * would be the more surprising rule. Managing it is the narrower gate, returned beside the row.
 */
export async function readEvent(
  db: Db,
  ctx: AccessContext,
  eventId: string,
): Promise<Result<{ event: EventDetail }>> {
  const rows = await db.execute<{
    id: string;
    club_id: string;
    type: string;
    title: string;
    starts_at: string;
    ends_at: string | null;
    location: string | null;
    description: string | null;
    created_by: string | null;
    full_name: string | null;
  }>(sql`
    SELECT e.id::text AS id,
           e.club_id::text AS club_id,
           e.type,
           e.title,
           ${isoUtc('e.starts_at')} AS starts_at,
           ${isoUtc('e.ends_at')} AS ends_at,
           e.location,
           e.description,
           e.created_by::text AS created_by,
           u.full_name
      FROM calendar_events e
      -- LEFT, because created_by is nullable: an inner join would make the event itself
      -- disappear the moment the person who added it deleted their account.
      LEFT JOIN users u ON u.id = e.created_by
     WHERE e.id = ${eventId}
  `);

  const row = rows.rows[0];
  if (!row) return { ok: false, code: 'not_found' };
  if (!canReadClubContent(ctx, row.club_id)) return { ok: false, code: 'not_found' };

  return {
    ok: true,
    event: {
      id: row.id,
      clubId: row.club_id,
      type: row.type as EventType,
      title: row.title,
      startsAt: row.starts_at,
      endsAt: row.ends_at,
      location: row.location,
      description: row.description,
      creatorId: row.created_by,
      creatorName: row.full_name,
      canManage: canManageClubContent(ctx, row.club_id),
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
