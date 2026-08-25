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
import { extractHashtags, isMapLink } from '@clubchat/shared';
import type { Db } from '../db/client.ts';
import { isoUtc } from '../db/sql-helpers.ts';
import {
  calendarEvents,
  meetings,
  newsPostMedia,
  newsPostPeople,
  newsPosts,
  newsPostTags,
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
    mapUrl?: string | null | undefined;
    description?: string | null | undefined;
  },
): Promise<Result<{ eventId: string }>> {
  if (!canManageClubContent(ctx, input.clubId)) return { ok: false, code: 'forbidden' };

  /*
   * Not a map link: not stored at all, exactly as a meetup treats it.
   *
   * The rule is the same one and it is worth restating: a stored URL becomes a Directions button
   * that opens it, so anything that is not a map is dropped rather than kept and refused later.
   * `isMapLink` is reused rather than re-derived - the second copy of a host allowlist is the one
   * that goes stale.
   */
  const link = typeof input.mapUrl === 'string' ? input.mapUrl.trim() : '';
  const mapUrl = link.length > 0 && isMapLink(link) ? link : null;

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
        mapUrl,
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

/**
 * Edit an event. Any admin, any event - not only its author.
 *
 * **Notifies nobody, which is the same call `PRD/06` rule 6 makes for a news post and for the
 * same reason.** Creating an event tells the club because the club has not heard of it; changing
 * the room it is in has not created a second event, and a club that gets buzzed every time a typo
 * is fixed learns to ignore the buzz. The card already in chat reads through to this row, so it
 * updates itself without an announcement.
 *
 * The whole event arrives rather than a diff, matching `updateMeetup` and `updateNewsPost`: the
 * composer holds the entire form in its hand and a field absent from a PATCH is genuinely
 * ambiguous between "unchanged" and "cleared".
 */
export async function updateEvent(
  db: Db,
  ctx: AccessContext,
  eventId: string,
  input: {
    type: EventType;
    title: string;
    startsAt: string;
    endsAt?: string | null | undefined;
    location?: string | null | undefined;
    mapUrl?: string | null | undefined;
    description?: string | null | undefined;
  },
): Promise<Result<{ updated: true }>> {
  const rows = await db.select().from(calendarEvents).where(eq(calendarEvents.id, eventId)).limit(1);
  const event = rows[0];
  if (!event) return { ok: false, code: 'not_found' };
  if (!canManageClubContent(ctx, event.clubId)) return { ok: false, code: 'forbidden' };

  // Same rule as the create: not a map link, not stored. A button must never open an arbitrary URL.
  const link = typeof input.mapUrl === 'string' ? input.mapUrl.trim() : '';
  const mapUrl = link.length > 0 && isMapLink(link) ? link : null;

  await db
    .update(calendarEvents)
    .set({
      type: input.type,
      title: input.title,
      startsAt: new Date(input.startsAt),
      endsAt: input.endsAt ? new Date(input.endsAt) : null,
      location: input.location ?? null,
      mapUrl,
      description: input.description ?? null,
      updatedBy: ctx.userId,
    })
    .where(eq(calendarEvents.id, eventId));

  return { ok: true, updated: true };
}

/** Delete an event. Any admin, any event - not only its author. */
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
   * A Google or Apple Maps link, pasted. **The link is the place** (ADR-0037).
   *
   * A link on a host that is not a map is dropped rather than stored, because whatever is stored
   * here ends up behind a Directions button that every member of the club taps. `isMapLink` is
   * the gate, and it is the only reason that module still exists - see ADR-0049.
   *
   * No coordinates travel with it in either direction. They were stored until 2026-08-25 for a
   * pin that was never drawn; ADR-0049 removed both.
   */
  mapUrl?: string | null | undefined;
};

/**
 * "And who changed it", or nothing at all.
 *
 * One function because two detail reads ask it and a rule written twice is a rule that diverges -
 * failure mode 9. The rule: an edit is only worth naming when somebody OTHER than the author made
 * it. A row nobody has edited has no editor, and a row edited only by its own author has nothing
 * to add; both come back null and the screen draws no second line.
 *
 * Compared by id rather than by name, because two members can share a name and one member can
 * change theirs.
 */
function editorFields(
  createdBy: string | null,
  updatedBy: string | null,
  editorName: string | null,
  editorImage: string | null,
): { editorId: string | null; editorName: string | null; editorImage: string | null } {
  if (updatedBy === null || updatedBy === createdBy) {
    return { editorId: null, editorName: null, editorImage: null };
  }
  return { editorId: updatedBy, editorName, editorImage };
}

/**
 * What a pasted link becomes on the way into the row: the link, if it is a link to a map at all.
 *
 * Decided here rather than at either call site so create and edit cannot drift - the shape of bug
 * `AGENTS.md` failure mode 31 is about, where two statements that must always happen together
 * eventually become one.
 *
 * **Not a map link means not stored at all**, rather than rejected. The meetup still saves; it
 * simply has no Directions button. Storing it anyway would put an arbitrary URL behind a button
 * every member of the club taps.
 */
function mapLinkOrNull(raw: string | null | undefined): { mapUrl: string | null } {
  const link = typeof raw === 'string' ? raw.trim() : '';
  return { mapUrl: link.length > 0 && isMapLink(link) ? link : null };
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
      description: input.description ?? null,
      title: input.title,
      locationNotes: input.locationNotes ?? null,
      ...mapLinkOrNull(input.mapUrl),
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
      description: input.description ?? null,
      title: input.title,
      locationNotes: input.locationNotes ?? null,
      // Who changed it, recorded on every edit including one by the author. The SCREEN decides
      // whether that is worth saying, by comparing this against the creator - storing the
      // judgement instead would bake in an answer that changes if an account is deleted.
      updatedBy: ctx.userId,
      // Re-decided rather than kept: an edit that clears the link has to clear the button, and an
      // edit that pastes a link to somewhere that is not a map has to drop it exactly as a create
      // would. Carrying the old value forward would leave Directions pointing at the old place.
      ...mapLinkOrNull(input.mapUrl),
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
    description: string | null;
    title: string;
    location_notes: string | null;
    map_url: string | null;
    created_by: string | null;
    creator_name: string | null;
    creator_image: string | null;
    updated_by: string | null;
    editor_name: string | null;
    editor_image: string | null;
  }>(sql`
    SELECT m.id, m.club_id, cl.name AS club_name, m.meetup_date, m.meetup_time,
           m.description, m.title, m.location_notes, m.map_url,
           m.created_by::text AS created_by,
           u.full_name AS creator_name,
           u.image AS creator_image,
           m.updated_by::text AS updated_by,
           editor.full_name AS editor_name,
           editor.image AS editor_image
      FROM meetups m
      JOIN clubs cl ON cl.id = m.club_id
      -- LEFT for both: created_by is nullable and updated_by is null on anything never edited,
      -- and an inner join on either would make the meetup itself vanish. (No backticks in here:
      -- this is a template literal and one would end it. AGENTS.md 2.5.8.)
      LEFT JOIN users u ON u.id = m.created_by
      LEFT JOIN users editor ON editor.id = m.updated_by
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
      description: row.description,
      title: row.title,
      locationNotes: row.location_notes,
      mapUrl: row.map_url,
      /*
       * COMPATIBILITY SHIM for builds shipped before ADR-0049, and it is load-bearing today.
       *
       * 0041 dropped `meetups.location`, and this read simply stopped returning the key. The
       * TestFlight build in people's hands reads it, and `DetailLine` in that build guards with
       * `value === null` and then calls `value.trim()`. `null` it handles; `undefined` throws,
       * and the meetup screen crashed the whole app on 2026-08-25 within minutes of the deploy.
       *
       * So the column is gone and the KEY is not. Always null, never read from a row.
       *
       * REMOVE IT when no build older than the first post-ADR-0049 release is still installed,
       * and not before. That is a fact about phones, not about this repo, so it cannot be
       * checked from here - which is exactly why it is written down rather than remembered.
       */
      location: null,
      /*
       * The second one, found the same way and latent rather than reported. `directionsUrl` in
       * the shipped build reads `if (point !== null) { ... point.lat ... }`: `undefined` takes
       * that branch and throws. It only bites a meetup with NO map link, because a link
       * short-circuits one line earlier - so it would have surfaced later, on a different
       * meetup, looking like a new bug. Same removal condition as `location`.
       */
      mapPoint: null,
      creatorId: row.created_by,
      creatorName: row.creator_name,
      creatorImage: row.creator_image,
      ...editorFields(row.created_by, row.updated_by, row.editor_name, row.editor_image),
      // The same gate the week's long press uses, answered by the server rather than re-derived
      // on the screen - `DESIGN/10` rule 4's rule, applied to a different surface.
      canManage: canManageClubContent(ctx, row.club_id),
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
  description: string | null;
  title: string;
  locationNotes: string | null;
  mapUrl: string | null;
  /**
   * Always null. A compatibility key for builds shipped before ADR-0049, whose `DetailLine`
   * throws on `undefined` and handles `null`. See the note at the return site.
   */
  location: null;
  /** Always null. Compatibility key, same reason as `location`. See the return site. */
  mapPoint: null;
  /** Who added it. Null once their account is gone; the meetup outlives them. */
  creatorId: string | null;
  creatorName: string | null;
  creatorImage: string | null;
  /** Who last changed it, and null unless that is somebody else. See `editorFields`. */
  editorId: string | null;
  editorName: string | null;
  editorImage: string | null;
  /** Whether this viewer may edit or delete it. Any club admin, not only the author. */
  canManage: boolean;
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
          /*
           * The meetup's NAME, and this line is the whole of bug 2026-08-25.
           *
           * It carried `meetup.location` until then. ADR-0037 had stopped collecting a place ten
           * days earlier, so the column was null on every meetup made since, and the worker's
           * `String(...)` turned that null into the four-letter text "null" - which is a valid
           * string, so nothing downstream refused it. The club was pushed "18:00 at null".
           *
           * `title` is `NOT NULL` on the row, so this cannot repeat the same way.
           */
          title: meetup.title,
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
    description: string | null;
    /** What the club calls it. The headline, everywhere, and required since 2026-08-15. */
    title: string;
    /** How to find the club once you are there. */
    locationNotes: string | null;
    /** The pasted Google or Apple Maps link, or null. Opens in Maps, and is the only "where". */
    mapUrl: string | null;
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
    description: string | null;
    title: string;
    location_notes: string | null;
    map_url: string | null;
    cooldown_until: string | null;
  }>(sql`
    SELECT m.id, m.meetup_date, m.meetup_time, m.description,
           m.title, m.location_notes, m.map_url,
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
      description: row.description,
      title: row.title,
      locationNotes: row.location_notes,
      mapUrl: row.map_url,
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

/** The three shapes a carousel can be drawn in. Mirrors `news_posts_aspect_valid`. */
export const NEWS_ASPECTS = ['1:1', '4:5', '16:9'] as const;

/** ADR-0038. Also a check constraint, so a route that forgets is still refused. */
export const MAX_NEWS_PHOTOS = 6;

/** What a post is written from. Every field but the club is optional; see `newsPostShape`. */
export type NewsPostInput = {
  title?: string | null | undefined;
  body?: string | null | undefined;
  mediaIds?: string[] | undefined;
  aspect?: string | undefined;
  locationName?: string | null | undefined;
  locationUrl?: string | null | undefined;
  peopleIds?: string[] | undefined;
};

/** Trimmed, or null. An empty string is not a title and must not become one. */
function blankToNull(value: string | null | undefined): string | null {
  const trimmed = (value ?? '').trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Everything about a post that can be wrong without touching the database.
 *
 * Returned as a single refusal rather than checked at three call sites, because create and edit
 * have to agree exactly: an edit that could reach a state a create could not is a rule that only
 * applies to new posts, which is not a rule.
 */
function newsPostShape(
  next: {
    title: string | null;
    body: string | null;
    mediaIds: string[];
    aspect: string;
    locationName: string | null;
    locationUrl: string | null;
  },
): 'invalid' | null {
  // PRD/06 rule 1. The deferred trigger says the same thing; this one produces a 400 instead
  // of a transaction that dies at COMMIT.
  if (!next.title && !next.body && next.mediaIds.length === 0) return 'invalid';
  if (next.mediaIds.length > MAX_NEWS_PHOTOS) return 'invalid';
  if (new Set(next.mediaIds).size !== next.mediaIds.length) return 'invalid';
  if (!(NEWS_ASPECTS as readonly string[]).includes(next.aspect)) return 'invalid';
  // A link with no name is unreachable: the card draws the row from the name.
  if (next.locationUrl && !next.locationName) return 'invalid';
  return null;
}

/**
 * The subset of `userIds` who are actually members of this club.
 *
 * ADR-0040: you cannot name somebody in a club they are not in. Checked here rather than trusted
 * to the picker, because the picker is a convenience and this is the rule.
 */
async function clubMembersAmong(db: Db, clubId: string, userIds: string[]): Promise<Set<string>> {
  if (userIds.length === 0) return new Set();
  const rows = await db.execute<{ user_id: string }>(sql`
    SELECT user_id::text AS user_id
      FROM club_memberships
     WHERE club_id = ${clubId}::uuid
       AND user_id = ANY(${sql.param(userIds)}::uuid[])
  `);
  return new Set(rows.rows.map((row) => row.user_id));
}

/**
 * Write a post's photos, tags and named people. Used by create and by edit, which is the point:
 * the two produce identical rows for identical input.
 *
 * **Tags are derived, never supplied.** They come out of the body every time it is written, so a
 * post's chips and its sentence cannot disagree - editing `#longrun` out of the text removes the
 * tag, with nothing to keep in sync.
 */
async function writePostChildren(
  tx: Db,
  postId: string,
  next: { body: string | null; mediaIds: string[]; peopleIds: string[] },
): Promise<void> {
  await tx.delete(newsPostMedia).where(eq(newsPostMedia.postId, postId));
  await tx.delete(newsPostTags).where(eq(newsPostTags.postId, postId));
  await tx.delete(newsPostPeople).where(eq(newsPostPeople.postId, postId));

  if (next.mediaIds.length > 0) {
    await tx
      .insert(newsPostMedia)
      .values(next.mediaIds.map((mediaId, ordinal) => ({ postId, mediaId, ordinal })));

    /*
      A news photo is not a chat photo, and the Gallery reads this column to tell them apart.
      Set on write rather than at upload because the uploader does not yet know what the object
      is for - it is created against the club's main channel, which is what governs access, and
      only becomes a post's photo here. See PRD/13 rule 4.
    */
    await tx.execute(sql`
      UPDATE media_objects SET owner_type = 'news_post', owner_id = ${postId}::uuid
       WHERE id = ANY(${sql.param(next.mediaIds)}::uuid[])
    `);
  }

  const tags = extractHashtags(next.body);
  if (tags.length > 0) {
    // The index IS the order they were written in, which is what the chips are drawn in.
    await tx.insert(newsPostTags).values(tags.map((tag, ordinal) => ({ postId, tag, ordinal })));
  }

  if (next.peopleIds.length > 0) {
    await tx.insert(newsPostPeople).values(next.peopleIds.map((userId) => ({ postId, userId })));
  }
}

/**
 * Create a news post. Any club admin.
 *
 * **Must have a title, body text, or at least one photo** (PRD/06 rule 1). The deferred
 * constraint trigger enforces it too, so this refusal is about a clear error rather than safety.
 *
 * **Creating notifies every other club member. Editing and deleting notify nobody**, except that
 * somebody newly named in an edit is told they were named - see `updateNewsPost`.
 */
export async function createNewsPost(
  db: Db,
  ctx: AccessContext,
  input: { clubId: string } & NewsPostInput,
): Promise<Result<{ postId: string }>> {
  if (!canManageClubContent(ctx, input.clubId)) return { ok: false, code: 'forbidden' };

  const next = {
    title: blankToNull(input.title),
    body: blankToNull(input.body),
    mediaIds: input.mediaIds ?? [],
    aspect: input.aspect ?? '1:1',
    locationName: blankToNull(input.locationName),
    locationUrl: blankToNull(input.locationUrl),
  };
  if (newsPostShape(next)) return { ok: false, code: 'invalid' };

  const asked = [...new Set(input.peopleIds ?? [])];
  const members = await clubMembersAmong(db, input.clubId, asked);
  // A name that is not in this club is a refusal rather than a silent drop: the picker only
  // offers members, so anything else is a client that has gone wrong or is being probed.
  if (asked.some((userId) => !members.has(userId))) return { ok: false, code: 'invalid' };

  return db.transaction(async (tx) => {
    const rows = await tx
      .insert(newsPosts)
      .values({ clubId: input.clubId, authorId: ctx.userId, ...next })
      .returning();
    const post = rows[0];
    if (!post) throw new Error('news post insert returned no row');

    await writePostChildren(tx as unknown as Db, post.id, { ...next, peopleIds: asked });

    await tx.insert(outbox).values({
      partitionKey: input.clubId,
      eventType: 'news.created',
      payload: {
        clubId: input.clubId,
        postId: post.id,
        actorId: ctx.userId,
        /* Who gets the specific line instead of the generic one. The worker subtracts these
           from the push list; see ADR-0040 and the announcement branch it copies. */
        taggedUserIds: asked,
      },
    });

    return { ok: true as const, postId: post.id };
  });
}

/**
 * Edit a post. **Any club admin can edit any post**, not only its author.
 *
 * Notifies nobody about the edit itself - it is a correction, not an announcement. The one
 * exception is people **newly** named, who have not been told anything yet: they get the same
 * "you were named" line a new post would have sent them, and nobody already on the post is
 * buzzed again for a fixed typo (ADR-0040).
 */
export async function updateNewsPost(
  db: Db,
  ctx: AccessContext,
  postId: string,
  fields: NewsPostInput,
): Promise<Result<{ updated: true }>> {
  const rows = await db.select().from(newsPosts).where(eq(newsPosts.id, postId)).limit(1);
  const post = rows[0];
  if (!post) return { ok: false, code: 'not_found' };
  if (!canManageClubContent(ctx, post.clubId)) return { ok: false, code: 'forbidden' };

  const existingMedia = await db
    .select({ mediaId: newsPostMedia.mediaId })
    .from(newsPostMedia)
    .where(eq(newsPostMedia.postId, postId))
    .orderBy(newsPostMedia.ordinal);
  const existingPeople = await db
    .select({ userId: newsPostPeople.userId })
    .from(newsPostPeople)
    .where(eq(newsPostPeople.postId, postId));

  // An absent field means "leave it alone"; an explicit null means "clear it" (PRD/06 rule 7).
  const next = {
    title: fields.title !== undefined ? blankToNull(fields.title) : post.title,
    body: fields.body !== undefined ? blankToNull(fields.body) : post.body,
    mediaIds: fields.mediaIds ?? existingMedia.map((row) => row.mediaId),
    aspect: fields.aspect ?? post.aspect,
    locationName:
      fields.locationName !== undefined ? blankToNull(fields.locationName) : post.locationName,
    locationUrl:
      fields.locationUrl !== undefined ? blankToNull(fields.locationUrl) : post.locationUrl,
  };
  if (newsPostShape(next)) return { ok: false, code: 'invalid' };

  const before = new Set(existingPeople.map((row) => row.userId));
  const asked = [...new Set(fields.peopleIds ?? [...before])];
  const members = await clubMembersAmong(db, post.clubId, asked);
  if (asked.some((userId) => !members.has(userId))) return { ok: false, code: 'invalid' };

  // Only the difference has learned anything. Removing a tag sends nothing and withdraws
  // nothing already delivered, the same shape as un-mentioning somebody in an edited message.
  const newlyNamed = asked.filter((userId) => !before.has(userId) && userId !== ctx.userId);

  await db.transaction(async (tx) => {
    await tx
      .update(newsPosts)
      .set({ ...next, updatedAt: new Date() })
      .where(eq(newsPosts.id, postId));

    await writePostChildren(tx as unknown as Db, postId, { ...next, peopleIds: asked });

    if (newlyNamed.length > 0) {
      await tx.insert(outbox).values({
        partitionKey: post.clubId,
        eventType: 'news.tagged',
        payload: {
          clubId: post.clubId,
          postId,
          actorId: ctx.userId,
          taggedUserIds: newlyNamed,
        },
      });
    }
  });

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
  /** A pasted map link, already validated. Becomes a Directions button, or no button at all. */
  mapUrl: string | null;
  description: string | null;
  /** Null once the creator's account is gone - `created_by` is `on delete set null`. */
  creatorId: string | null;
  creatorName: string | null;
  creatorImage: string | null;
  /**
   * Who last changed it, and **null unless that is somebody other than the creator**.
   *
   * The comparison happens here rather than on the screen so both detail surfaces cannot disagree
   * about it, and so an edit by the author stays silent instead of rendering "Added by Dana,
   * edited by Dana". A row edited by its own author is not news.
   */
  editorId: string | null;
  editorName: string | null;
  editorImage: string | null;
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
/**
 * One row of the event read, before authorization.
 *
 * Named rather than inlined because two functions now share it, and because of failure mode 7:
 * `db.execute` applies none of Drizzle's column coercion, so every timestamp here is a **string**
 * and saying `Date` would be a lie the compiler happily believes until it reaches a call site.
 */
type EventRow = {
  id: string;
  club_id: string;
  type: string;
  title: string;
  starts_at: string;
  ends_at: string | null;
  location: string | null;
  map_url: string | null;
  description: string | null;
  created_by: string | null;
  full_name: string | null;
  creator_image: string | null;
  updated_by: string | null;
  editor_name: string | null;
  editor_image: string | null;
};

/**
 * Several events, in one round trip, in the order they were asked for.
 *
 * > **`GET /events?ids=` was `3 + n` statements: the route looped `readEvent` once per id.**
 * > Measured on 2026-08-21 against a club-sized fixture at 4 statements for one id and 23 for
 * > twenty - exactly the shape `SPEC/TECH/18` 2.16 removed from `GET /polls?ids=`, and the last
 * > batch route still carrying it. Two review lanes found it independently.
 *
 * Mirrors `readPolls` deliberately, including the part that looks like it could be simpler:
 * **the refusal is a loop over the same predicate the single read calls, never a `WHERE` clause
 * expressing the same idea.** A second copy of an authorization rule is failure mode 9, and the
 * saving being bought here is network round trips rather than database work.
 *
 * Ordered by the caller's own id list rather than by whatever the scan returns, so batching
 * changes the cost and nothing else. An id that is gone, or that this caller may not read, is
 * simply absent - the two are indistinguishable to a caller by design, exactly as the single
 * read's `not_found` covers both.
 */
export async function readEvents(
  db: Db,
  ctx: AccessContext,
  eventIds: readonly string[],
): Promise<EventDetail[]> {
  if (eventIds.length === 0) return [];

  const rows = await db.execute<EventRow>(sql`
    SELECT e.id::text AS id,
           e.club_id::text AS club_id,
           e.type,
           e.title,
           ${isoUtc('e.starts_at')} AS starts_at,
           ${isoUtc('e.ends_at')} AS ends_at,
           e.location,
           e.map_url,
           e.description,
           e.created_by::text AS created_by,
           u.full_name,
           u.image AS creator_image,
           e.updated_by::text AS updated_by,
           editor.full_name AS editor_name,
           editor.image AS editor_image
      FROM calendar_events e
      -- LEFT, because created_by is nullable: an inner join would make the event itself
      -- disappear the moment the person who added it deleted their account.
      LEFT JOIN users u ON u.id = e.created_by
      -- And again for the editor, for the same reason and one more: updated_by is null on
      -- everything that has never been edited, which is most rows.
      LEFT JOIN users editor ON editor.id = e.updated_by
     WHERE e.id = ANY(${sql.param([...eventIds])}::uuid[])
  `);

  /*
   * The refusal, once per id, using the same predicate the single read used.
   *
   * Deliberately a loop rather than a `WHERE` clause saying the same thing. This is the rule
   * `batch-reads.test.ts` exists to protect and the one AGENTS.md failure mode 9 describes: a
   * hand-copied predicate does not diverge loudly, it diverges silently, and every copy stays
   * individually correct while one of them quietly stops covering a scope somebody added.
   */
  const visible = new Map<string, EventRow>();
  for (const row of rows.rows) {
    if (!canReadClubContent(ctx, row.club_id)) continue;
    visible.set(row.id, row);
  }

  // The caller's order, not the scan's. Batching must change the cost and nothing else.
  const events: EventDetail[] = [];
  for (const eventId of eventIds) {
    const row = visible.get(eventId);
    if (!row) continue;
    events.push({
      id: row.id,
      clubId: row.club_id,
      type: row.type as EventType,
      title: row.title,
      startsAt: row.starts_at,
      endsAt: row.ends_at,
      location: row.location,
      mapUrl: row.map_url,
      description: row.description,
      creatorId: row.created_by,
      creatorName: row.full_name,
      creatorImage: row.creator_image,
      // Suppressed when the editor IS the creator - see the type. Both ids are compared rather
      // than the names, because two members can share a name and one person can change theirs.
      ...editorFields(row.created_by, row.updated_by, row.editor_name, row.editor_image),
      canManage: canManageClubContent(ctx, row.club_id),
    });
  }
  return events;
}

/**
 * One event.
 *
 * Delegates to `readEvents` rather than having a body of its own, so the single route and the
 * batch route can never answer differently - the failure `batch-reads.test.ts` exists to catch,
 * removed by construction instead of asserted. An absent result still means gone OR not ours,
 * which is the same `not_found` this returned before and is deliberate: telling a stranger which
 * of the two it was would confirm the event exists.
 */
export async function readEvent(
  db: Db,
  ctx: AccessContext,
  eventId: string,
): Promise<Result<{ event: EventDetail }>> {
  const [event] = await readEvents(db, ctx, [eventId]);
  if (!event) return { ok: false, code: 'not_found' };
  return { ok: true, event };
}

export const NEWS_PAGE_SIZE = 20;

export type NewsPostView = {
  id: string;
  title: string | null;
  body: string | null;
  /** The shape every photo below is drawn in. One per post, never per photo (ADR-0038). */
  aspect: string;
  /** Ordered, at most six. Empty for a text post. */
  mediaIds: string[];
  locationName: string | null;
  locationUrl: string | null;
  /** Lowercased, in the order they were written in the body. */
  tags: string[];
  /** Club members named in the post (ADR-0040). */
  people: Array<{ userId: string; name: string; image: string | null }>;
  authorId: string;
  authorName: string;
  authorImage: string | null;
  createdAt: string;
  updatedAt: string | null;
  /** Every emoji with a count, and whether this viewer is in it. */
  reactions: Array<{ emoji: string; count: number; mine: boolean }>;
};

/** The columns every post read selects, so the feed and the permalink cannot drift apart. */
const NEWS_POST_COLUMNS = sql`
  p.id::text AS id,
  p.club_id::text AS club_id,
  p.title,
  p.body,
  p.aspect,
  p.location_name,
  p.location_url,
  p.author_id::text AS author_id,
  u.full_name,
  u.image,
  ${isoUtc('p.created_at')} AS created_at,
  ${isoUtc('p.updated_at')} AS updated_at
`;

type NewsPostRow = {
  id: string;
  club_id: string;
  title: string | null;
  body: string | null;
  aspect: string;
  location_name: string | null;
  location_url: string | null;
  author_id: string;
  full_name: string;
  image: string | null;
  created_at: string;
  updated_at: string | null;
};

/**
 * A `LIKE` pattern that matches `term` literally.
 *
 * Without this a member searching for `50%` gets every post in the club, because `%` is the
 * wildcard rather than the character they typed. The backslash is PostgreSQL's default `LIKE`
 * escape, so no `ESCAPE` clause is needed.
 */
function likeContains(term: string): string {
  return `%${term.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
}

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
  opts: { before?: string | undefined; limit?: number | undefined; q?: string | undefined } = {},
): Promise<Result<{ posts: NewsPostView[]; hasMore: boolean }>> {
  if (!canReadClubContent(ctx, clubId)) return { ok: false, code: 'not_found' };

  const limit = Math.min(opts.limit ?? NEWS_PAGE_SIZE, 100);

  /*
    PRD/06 rule 17: the box searches titles and tags, and nothing else.

    The two halves match differently on purpose. A **title** is a sentence, so it matches
    anywhere inside - somebody looking for "Binghamton" should find "Evening Run in Binghamton".
    A **tag** is a word somebody chose as a label, so it matches from the start, which is what
    makes typing `long` find `#longrun` while it is still being typed. Prefix matching is also
    the half `news_post_tags_by_tag` can actually serve.

    The leading `#` is stripped because a member searching for a tag types the character they
    can see on the chip, and requiring them not to would be a rule with no reason behind it.
  */
  const term = opts.q?.trim() ?? '';
  const searching = term.length > 0;
  const tagPrefix = `${term.replace(/^#/, '').toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

  const rows = await db.execute<NewsPostRow>(sql`
    SELECT ${NEWS_POST_COLUMNS}
      FROM news_posts p
      JOIN users u ON u.id = p.author_id
     WHERE p.club_id = ${clubId}
       ${opts.before ? sql`AND p.created_at < ${opts.before}::timestamptz` : sql``}
       ${
         searching
           ? sql`AND (
                   p.title ILIKE ${likeContains(term)}
                   OR EXISTS (SELECT 1 FROM news_post_tags t
                               WHERE t.post_id = p.id AND t.tag LIKE ${tagPrefix})
                 )`
           : sql``
       }
     ORDER BY p.created_at DESC
     LIMIT ${limit + 1}
  `);

  // One row over the limit answers "is there more" without a second count query.
  const hasMore = rows.rows.length > limit;
  const page = hasMore ? rows.rows.slice(0, limit) : rows.rows;

  return {
    ok: true,
    posts: await hydratePosts(db, ctx, page),
    hasMore,
  };
}

/** One post, for the permalink a notification opens. */
export async function readNewsPost(
  db: Db,
  ctx: AccessContext,
  postId: string,
): Promise<Result<{ post: NewsPostView }>> {
  const rows = await db.execute<NewsPostRow>(sql`
    SELECT ${NEWS_POST_COLUMNS}
      FROM news_posts p
      JOIN users u ON u.id = p.author_id
     WHERE p.id = ${postId}
  `);

  const row = rows.rows[0];
  if (!row) return { ok: false, code: 'not_found' };
  if (!canReadClubContent(ctx, row.club_id)) return { ok: false, code: 'not_found' };

  const [post] = await hydratePosts(db, ctx, [row]);
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
async function hydratePosts(
  db: Db,
  ctx: AccessContext,
  rows: ReadonlyArray<NewsPostRow>,
): Promise<NewsPostView[]> {
  if (rows.length === 0) return [];

  const ids = rows.map((row) => row.id);

  /*
    Four reads for a page of any size, rather than four per post. The four run together because
    none of them depends on another's answer - a feed of twenty posts costs the same round trips
    as a feed of one, which is the property that matters when the page size is a parameter.
  */
  const [reactionRows, mediaRows, tagRows, peopleRows] = await Promise.all([
    db.execute<{ post_id: string; emoji: string; count: string; mine: boolean }>(sql`
      SELECT post_id::text AS post_id,
             emoji,
             count(*) AS count,
             bool_or(user_id = ${ctx.userId}) AS mine
        FROM news_reactions
       WHERE post_id = ANY(${sql.param(ids)}::uuid[])
       GROUP BY post_id, emoji
       ORDER BY emoji
    `),
    // ORDER BY ordinal is the carousel's order, and it is the whole reason this is a table.
    db.execute<{ post_id: string; media_id: string }>(sql`
      SELECT post_id::text AS post_id, media_id::text AS media_id
        FROM news_post_media
       WHERE post_id = ANY(${sql.param(ids)}::uuid[])
       ORDER BY post_id, ordinal
    `),
    /* ORDER BY ordinal, never by tag: alphabetical is deterministic and is not the order
       anybody typed. See 0036_news_tag_order.sql. */
    db.execute<{ post_id: string; tag: string }>(sql`
      SELECT post_id::text AS post_id, tag
        FROM news_post_tags
       WHERE post_id = ANY(${sql.param(ids)}::uuid[])
       ORDER BY post_id, ordinal
    `),
    /* Named people come back with a face, because the card draws them and the sheet lists them.
       Ordered by name so two reads of the same post cannot shuffle the row order. */
    db.execute<{ post_id: string; user_id: string; full_name: string; image: string | null }>(sql`
      SELECT np.post_id::text AS post_id,
             np.user_id::text AS user_id,
             u.full_name,
             u.image
        FROM news_post_people np
        JOIN users u ON u.id = np.user_id
       WHERE np.post_id = ANY(${sql.param(ids)}::uuid[])
       ORDER BY np.post_id, u.full_name
    `),
  ]);

  const reactions = new Map<string, NewsPostView['reactions']>();
  for (const row of reactionRows.rows) {
    const list = reactions.get(row.post_id) ?? [];
    list.push({ emoji: row.emoji, count: Number(row.count), mine: row.mine });
    reactions.set(row.post_id, list);
  }

  const media = new Map<string, string[]>();
  for (const row of mediaRows.rows) {
    const list = media.get(row.post_id) ?? [];
    list.push(row.media_id);
    media.set(row.post_id, list);
  }

  const tags = new Map<string, string[]>();
  for (const row of tagRows.rows) {
    const list = tags.get(row.post_id) ?? [];
    list.push(row.tag);
    tags.set(row.post_id, list);
  }

  const people = new Map<string, NewsPostView['people']>();
  for (const row of peopleRows.rows) {
    const list = people.get(row.post_id) ?? [];
    list.push({ userId: row.user_id, name: row.full_name, image: row.image });
    people.set(row.post_id, list);
  }

  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    body: row.body,
    aspect: row.aspect,
    mediaIds: media.get(row.id) ?? [],
    locationName: row.location_name,
    locationUrl: row.location_url,
    tags: tags.get(row.id) ?? [],
    people: people.get(row.id) ?? [],
    authorId: row.author_id,
    authorName: row.full_name,
    authorImage: row.image,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    reactions: reactions.get(row.id) ?? [],
  }));
}
