/**
 * The inbox.
 *
 * One feed answering "what did I miss, and what needs me", merging two row kinds that
 * behave differently on purpose:
 *
 * | | Discrete notification | Chat unread |
 * |---|---|---|
 * | What it is | A recorded event | A live count of unread messages in one chat |
 * | Storage | A row | **Not stored** - derived from `last_seq - last_read_seq` |
 * | Can it be wrong? | No, it is a record | No, it is derived from the messages themselves |
 * | How it clears | Opening the inbox, mostly | **Only by opening that chat** |
 *
 * The clearing rules carry two exceptions, and they are the most important behaviour in
 * this file. See `markInboxRead`.
 */

import { sql } from 'drizzle-orm';
import {
  notificationSubject,
  notificationTarget,
  renderNotification,
  requestDecision,
  PENDING_REQUEST_TYPES,
  type NotificationSubject,
  type NotificationTarget,
  type NotificationType,
} from '@clubchat/shared';
import type { Db } from '../db/client.ts';
import { advanceReadCursor } from './reads.ts';
import {
  accessibleChannelPredicate,
  channelDisplayImage,
  channelDisplayName,
  channelNameJoins,
} from './channel-access.ts';

/**
 * Normalise a timestamp coming back from raw SQL.
 *
 * **`db.execute` does NOT apply Drizzle's column type coercion.** A typed `select()`
 * hands back a `Date` for a timestamptz; `execute()` hands back whatever the driver
 * produced, which for timestamptz is a **string**. Annotating the row type as `Date`
 * typechecks perfectly and is simply false at runtime - the failure is
 * `x.toISOString is not a function`, at the call site rather than at the lie.
 *
 * So the row types below say `string`, which is the truth, and this converts. It tolerates
 * a Date too, so the helper stays correct if a caller ever switches to `select()`.
 */
function toIso(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

/** Discrete notifications per page. Chat-unread rows ride along on top. */
export const INBOX_PAGE_SIZE = 20;

/**
 * The face a row wears, resolved at read time.
 *
 * `PRD/12` rule 2c. Carries everything the client needs to draw it and nothing it does not:
 *
 * - `name` for the fallback, since most subjects have no picture at all.
 * - `kind`, because the fallback differs - a **person** gets their initial and a **group** gets a
 *   glyph (`DESIGN/02` rule 4). An initial is meaningless for a club: "B" says nothing about
 *   Binghamton Running Club that the name beside it does not already say.
 * - `tintId`, because the fallback's colour comes from an **id and never from a name**
 *   (`DESIGN/02` rule 5), so a renamed club keeps the colour people find it by.
 *
 * The shape is deliberately absent: this list draws every one of them as a circle
 * (`PRD/12` rule 2d), so it is a fact about the surface rather than about the subject.
 */
export type InboxPicture = {
  name: string;
  /** A media id, or null - which is the common case, not an error. */
  image: string | null;
  kind: 'person' | 'group';
  tintId: string;
};

/**
 * Resolve each row's subject to a picture, batched by kind.
 *
 * **Joined at read time, never stored in `params`.** `params` records the moment the event
 * happened; a picture is a fact about the subject now, so storing it would freeze a club's old
 * avatar into every notification ever sent about it and make changing a picture a migration over
 * history - the retrofit ADR-0013 closed off for the body and the target. Same reason
 * `sender_name` is joined onto a message rather than written into it.
 *
 * One query per subject kind rather than one per row, so a page of twenty costs at most five
 * reads regardless of how the types are mixed.
 *
 * > **No authorization hop, and that is a fact about what these are rather than an omission.**
 * > Avatars are identity media on public, stable URLs (`PRD/13`), and every row already renders
 * > the subject's NAME in its own text - a club a member was just removed from, a requester whose
 * > name an admin is reading in order to decide. The picture discloses nothing the sentence does
 * > not. A content photo would be a different question entirely and does not appear here.
 */
async function resolveSubjectPictures(
  db: Db,
  userId: string,
  subjects: readonly NotificationSubject[],
): Promise<Map<string, InboxPicture>> {
  const out = new Map<string, InboxPicture>();
  if (subjects.length === 0) return out;

  const idsOf = (kind: NotificationSubject['kind']): string[] => [
    ...new Set(
      subjects
        .filter((s) => s.kind === kind)
        .map((s) =>
          s.kind === 'channel'
            ? s.channelId
            : s.kind === 'club'
              ? s.clubId
              : s.kind === 'race'
                ? s.raceId
                : s.kind === 'eboard'
                  ? s.eboardId
                  : s.userId,
        ),
    ),
  ];

  /** Parameterised, never interpolated - every id goes through a bind. */
  const list = (ids: readonly string[]) => sql.join(ids.map((id) => sql`${id}`), sql`, `);

  const channelIds = idsOf('channel');
  if (channelIds.length > 0) {
    /*
     * The scope picks its own name and picture, through the same two fragments the Chats list
     * uses. Resolving a chat row against its CLUB instead would be the failure that looks like
     * success: a race and an Eboard channel both carry a club id, so every race row would wear
     * the club's face over the race's name.
     */
    const rows = await db.execute<{
      id: string;
      name: string;
      image: string | null;
      scope: string;
    }>(sql`
      SELECT c.id,
             ${channelDisplayName()} AS name,
             ${channelDisplayImage()} AS image,
             c.scope
        FROM channels c
        ${channelNameJoins(userId)}
       WHERE c.id IN (${list(channelIds)})
    `);
    for (const row of rows.rows) {
      out.set(`channel:${row.id}`, {
        name: row.name,
        image: row.image,
        // A DM is a person - that is who is on the other end of it. Every other scope is a space.
        kind: row.scope === 'dm' ? 'person' : 'group',
        tintId: row.id,
      });
    }
  }

  /** The three space kinds are the same query against three tables. */
  const spaces = [
    ['club', 'clubs', idsOf('club')],
    ['race', 'races', idsOf('race')],
    ['eboard', 'eboard_channels', idsOf('eboard')],
  ] as const;

  for (const [kind, table, ids] of spaces) {
    if (ids.length === 0) continue;
    const rows = await db.execute<{ id: string; name: string; image: string | null }>(sql`
      SELECT id, name, image FROM ${sql.raw(table)} WHERE id IN (${list(ids)})
    `);
    for (const row of rows.rows) {
      out.set(`${kind}:${row.id}`, {
        name: row.name,
        image: row.image,
        kind: 'group',
        tintId: row.id,
      });
    }
  }

  const userIds = idsOf('user');
  if (userIds.length > 0) {
    const rows = await db.execute<{ id: string; full_name: string; image: string | null }>(sql`
      SELECT id, full_name, image FROM users WHERE id IN (${list(userIds)})
    `);
    for (const row of rows.rows) {
      out.set(`user:${row.id}`, {
        name: row.full_name,
        image: row.image,
        kind: 'person',
        tintId: row.id,
      });
    }
  }

  return out;
}

/** The map key for a subject, so the lookup cannot collide across kinds sharing an id space. */
function subjectKey(s: NotificationSubject): string {
  switch (s.kind) {
    case 'channel':
      return `channel:${s.channelId}`;
    case 'club':
      return `club:${s.clubId}`;
    case 'race':
      return `race:${s.raceId}`;
    case 'eboard':
      return `eboard:${s.eboardId}`;
    case 'user':
      return `user:${s.userId}`;
  }
}

export type InboxRow =
  | {
      kind: 'notification';
      id: string;
      type: NotificationType;
      title: string;
      body: string;
      target: NotificationTarget;
      read: boolean;
      /** Present on a decided request, so the admin keeps a record of what they decided. */
      decision?: 'approved' | 'denied';
      /**
       * The subject's face, or `null` for the glyph tier and for a subject that has gone.
       *
       * Null is an ordinary answer twice over: a poll notification never has one by design, and a
       * club that was deleted resolves to nothing. `PRD/12` rule 6 already requires such a row to
       * degrade rather than break, and this is the drawing half of that.
       */
      picture: InboxPicture | null;
      createdAt: string;
    }
  | {
      kind: 'chat_unread';
      /** Synthetic and stable, since there is no row to have an id. */
      id: string;
      channelId: string;
      channelName: string;
      count: number;
      target: NotificationTarget;
      /** Always present in practice - a conversation always resolves - but nullable in shape so
       *  the two row kinds carry one field rather than two that must be kept in step. */
      picture: InboxPicture | null;
      createdAt: string;
    };

export type InboxPage = {
  rows: InboxRow[];
  /** Opaque cursor for the next page of discrete rows. */
  nextCursor: string | null;
};

/**
 * Read the inbox.
 *
 * Chat-unread rows are computed fresh on every read and are NOT paginated: there is at
 * most one per channel the member belongs to, so the count is bounded by club membership
 * rather than by message volume. Paginating them would be pointless and would also make
 * "how many chats have unread" unanswerable without walking every page.
 */
export async function readInbox(
  db: Db,
  userId: string,
  opts: { cursor?: string | undefined; limit?: number | undefined } = {},
): Promise<InboxPage> {
  const limit = Math.min(opts.limit ?? INBOX_PAGE_SIZE, 100);
  const before = opts.cursor ? new Date(opts.cursor) : null;

  const discrete = await db.execute<{
    id: string;
    type: string;
    params: Record<string, unknown>;
    // Strings, not Dates. See toIso above.
    read_at: string | null;
    created_at: string;
  }>(sql`
    SELECT id, type, params, read_at, created_at
      FROM notifications
     WHERE recipient_id = ${userId}
       ${before ? sql`AND created_at < ${before}` : sql``}
     ORDER BY created_at DESC
     LIMIT ${limit + 1}
  `);

  const hasMore = discrete.rows.length > limit;
  const page = discrete.rows.slice(0, limit);

  /*
   * Whose face each row wears, resolved once for the whole page.
   *
   * The mapping from type to subject lives in `@clubchat/shared` so this resolver and the client's
   * renderer read the same definition - the alternative is each end carrying its own copy of
   * "which types get a face", which is the hand-copied-predicate class (failure mode 9).
   */
  const subjects = page.map((row) =>
    notificationSubject({ type: row.type as NotificationType, params: row.params }),
  );
  const pictures = await resolveSubjectPictures(
    db,
    userId,
    subjects.filter((s): s is NotificationSubject => s !== null),
  );

  const rows: InboxRow[] = page.map((row, i) => {
    const type = row.type as NotificationType;
    // Rendered here, from params. The row itself stores no prose and no route.
    const rendered = renderNotification({ type, params: row.params });
    // Present only on a request that somebody has since decided, which is what turns the row
    // from a job into a record. The body already names the decider; this drives the tag.
    const decision = requestDecision({ type, params: row.params });
    const subject = subjects[i] ?? null;
    return {
      kind: 'notification' as const,
      id: row.id,
      type,
      title: rendered.title,
      body: rendered.body,
      target: notificationTarget({ type, params: row.params }),
      read: row.read_at !== null,
      ...(decision ? { decision } : {}),
      // A subject that resolved to nothing - deleted club, deleted account - falls back rather
      // than erroring, exactly as tapping such a row does.
      picture: subject ? (pictures.get(subjectKey(subject)) ?? null) : null,
      createdAt: toIso(row.created_at),
    };
  });

  // Only merge the live rows into the FIRST page. They are current-state rather than
  // history, so repeating them on page two would show the same unread chat twice.
  if (!before) {
    rows.push(...(await chatUnreadRows(db, userId)));
  }

  rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  return {
    rows,
    nextCursor: hasMore
      ? (() => {
          const last = page[page.length - 1];
          return last ? toIso(last.created_at) : null;
        })()
      : null,
  };
}

/**
 * The live chat-unread rows.
 *
 * `last_seq - last_read_seq`, computed. **Never stored**: a stored count drifts, a
 * computed one cannot. Timestamped with the newest unread message so it sorts into the
 * feed at the point the member actually missed something.
 */
async function chatUnreadRows(db: Db, userId: string): Promise<InboxRow[]> {
  const rows = await db.execute<{
    channel_id: string;
    channel_name: string;
    channel_image: string | null;
    scope: string;
    unread: number;
    last_at: string;
  }>(sql`
    SELECT c.id AS channel_id,
           ${channelDisplayName()} AS channel_name,
           ${channelDisplayImage()} AS channel_image,
           c.scope,
           c.last_seq - COALESCE(rc.last_read_seq, 0) AS unread,
           COALESCE(
             (SELECT m.created_at FROM messages m
               WHERE m.channel_id = c.id ORDER BY m.seq DESC LIMIT 1),
             c.created_at
           ) AS last_at
      FROM channels c
      ${channelNameJoins(userId)}
      LEFT JOIN read_cursors rc ON rc.channel_id = c.id AND rc.user_id = ${userId}
     WHERE ${accessibleChannelPredicate(userId)}
       AND c.last_seq > COALESCE(rc.last_read_seq, 0)
  `);

  return rows.rows.map((row) => ({
    kind: 'chat_unread' as const,
    id: `unread:${row.channel_id}`,
    channelId: row.channel_id,
    channelName: row.channel_name,
    count: Number(row.unread),
    target: { kind: 'chat' as const, channelId: row.channel_id },
    /*
     * The conversation's own face, from the same two fragments the Chats list uses.
     *
     * Tinted from the CHANNEL id rather than the club's, because that is the one id every scope
     * has - a DM carries no club at all - and because it must stay stable when a club is renamed.
     */
    picture: {
      name: row.channel_name,
      image: row.channel_image,
      kind: row.scope === 'dm' ? ('person' as const) : ('group' as const),
      tintId: row.channel_id,
    },
    createdAt: toIso(row.last_at),
  }));
}

/**
 * The badge.
 *
 * Unread discrete notifications plus **one per channel** with unread messages - never a
 * per-message sum. A badge of 200 because someone sent 200 messages is noise; a badge of
 * 1 because one conversation needs attention is information.
 */
export async function badgeCount(db: Db, userId: string): Promise<number> {
  const result = await db.execute<{ total: number }>(sql`
    SELECT
      (SELECT COUNT(*) FROM notifications
        WHERE recipient_id = ${userId} AND read_at IS NULL)
      +
      (SELECT COUNT(*)
         FROM channels c
         LEFT JOIN read_cursors rc ON rc.channel_id = c.id AND rc.user_id = ${userId}
        WHERE ${accessibleChannelPredicate(userId)}
          AND c.last_seq > COALESCE(rc.last_read_seq, 0))
      AS total
  `);
  return Number(result.rows[0]?.total ?? 0);
}

/**
 * Opening the inbox.
 *
 * Marks visible discrete notifications read and clears the badge - **with two
 * exceptions**, and both are deliberate:
 *
 *  1. **Chat-unread rows are never cleared here.** They are not rows to clear; they are
 *     derived from the read cursor, and only opening that chat advances it.
 *  2. **The three pending join-request types are never cleared here either.** This is the
 *     "only clears once you actually look" rule: a row representing work waiting on you
 *     must not be dismissed by a glance at the inbox. It clears when the relevant roster
 *     screen is opened. **The founder lost real join requests to the other behaviour.**
 *
 * A decided request is a different row (`request_approved` / `request_denied`) and does
 * clear here, because it is a record rather than outstanding work.
 */
export async function markInboxRead(db: Db, userId: string): Promise<{ cleared: number }> {
  const result = await db.execute<{ id: string }>(sql`
    UPDATE notifications SET read_at = now()
     WHERE recipient_id = ${userId}
       AND read_at IS NULL
       AND type <> ALL(${sql.param([...PENDING_REQUEST_TYPES])}::text[])
    RETURNING id
  `);
  return { cleared: result.rows.length };
}

/**
 * Opening a roster screen.
 *
 * The ONLY thing that clears a pending join-request notification. Scoped to the specific
 * roster, so opening a club's member list does not silently dismiss a race's pending
 * requests as well.
 */
export async function markRosterSeen(
  db: Db,
  userId: string,
  scope: { kind: 'club'; clubId: string } | { kind: 'race'; raceId: string } | { kind: 'eboard'; eboardId: string },
): Promise<{ cleared: number }> {
  const [type, paramKey, paramValue] =
    scope.kind === 'club'
      ? (['club_join_request', 'clubId', scope.clubId] as const)
      : scope.kind === 'race'
        ? (['race_join_request', 'raceId', scope.raceId] as const)
        : (['eboard_join_request', 'eboardId', scope.eboardId] as const);

  const result = await db.execute<{ id: string }>(sql`
    UPDATE notifications SET read_at = now()
     WHERE recipient_id = ${userId}
       AND read_at IS NULL
       AND type = ${type}
       AND params ->> ${paramKey} = ${paramValue}
    RETURNING id
  `);
  return { cleared: result.rows.length };
}

/**
 * Opening a chat.
 *
 * Advances the read cursor - the ONLY thing that clears an unread count - and records a
 * "caught up on N messages" row so the history of having caught up survives even though
 * the live count is gone.
 *
 * The synthetic `outbox_event_id` is the interesting part. This notification comes from a
 * user action rather than an outbox event, but the idempotency index still applies, and it
 * is wanted here: re-opening a chat at the same position must not add another history row.
 * So the id is derived deterministically from `(channelId, seq)` and made **negative**, to
 * keep it out of the positive space real outbox ids occupy - a collision between a
 * synthetic key and a genuine event would silently suppress a real notification.
 */
export async function openChat(
  db: Db,
  userId: string,
  channelId: string,
): Promise<{ caughtUp: number; lastReadSeq: number }> {
  const state = await db.execute<{
    last_seq: number;
    last_read_seq: number;
    channel_name: string;
    club_id: string | null;
  }>(sql`
    SELECT c.last_seq,
           COALESCE(rc.last_read_seq, 0) AS last_read_seq,
           ${channelDisplayName()} AS channel_name,
           c.club_id
      FROM channels c
      ${channelNameJoins(userId)}
      LEFT JOIN read_cursors rc ON rc.channel_id = c.id AND rc.user_id = ${userId}
     WHERE c.id = ${channelId}
  `);

  const row = state.rows[0];
  if (!row) return { caughtUp: 0, lastReadSeq: 0 };

  const caughtUp = Math.max(0, Number(row.last_seq) - Number(row.last_read_seq));
  const lastReadSeq = await advanceReadCursor(db, userId, channelId, Number(row.last_seq));

  if (caughtUp > 0) {
    await db.execute(sql`
      INSERT INTO notifications
        (recipient_id, club_id, type, params, outbox_event_id, read_at)
      VALUES (
        ${userId},
        ${row.club_id},
        'chat_caught_up',
        ${JSON.stringify({
          clubId: row.club_id,
          channelId,
          channelName: row.channel_name,
          count: caughtUp,
        })}::jsonb,
        ${syntheticEventId(channelId, Number(row.last_seq))},
        -- Written already-read. It is history, not an alert: the member has just this
        -- moment seen the messages it describes, so surfacing it as unread would be
        -- telling them about something they are currently looking at.
        now()
      )
      ON CONFLICT (outbox_event_id, recipient_id) DO NOTHING
    `);
  }

  return { caughtUp, lastReadSeq };
}

/**
 * A stable, negative pseudo-event id for a user-triggered notification.
 *
 * Negative on purpose: real outbox ids are a positive bigserial, so nothing synthetic can
 * ever collide with a genuine event and suppress it.
 */
function syntheticEventId(channelId: string, seq: number): number {
  let hash = 0;
  const key = `${channelId}:${seq}`;
  for (let i = 0; i < key.length; i += 1) {
    // Kept inside 32 bits so the result stays a safe integer after the shift below.
    hash = (hash * 31 + key.charCodeAt(i)) | 0;
  }
  return -Math.abs(hash) - 1;
}
