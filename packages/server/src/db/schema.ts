/**
 * The Phase 0 schema.
 *
 * Every unique partial index and check constraint here encodes an invariant from
 * SPEC/PRD/01-domain-model.md **at the data layer**, per that section's instruction
 * that these are enforced by data rather than by UI. If an invariant can be
 * expressed as a constraint, it is a defect for it to live in a handler instead:
 * a handler races, a constraint does not.
 *
 * Property names are camelCase and column names are snake_case. The auth tables'
 * property names are fixed by better-auth (it queries through the Drizzle schema by
 * property key), so `name` is the property and `full_name` is the column.
 */

import {
  bigint,
  bigserial,
  boolean,
  check,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  unique,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

/**
 * Users.
 *
 * The first seven columns are better-auth's required core schema; the rest are
 * ClubChat's own profile fields from SPEC/TECH/09-data-model.md. Identity lives in
 * our own Postgres specifically so account deletion is one transaction rather than
 * a two-system dance (ADR-0011).
 *
 * `signinBlockedAt`, not `blockedAt`: once member-to-member blocking exists an
 * unqualified "blocked" is ambiguous between "cannot sign in" and "blocked by
 * another member", which are very different things.
 */
export const users = pgTable('users', {
  // defaultRandom(), because better-auth's Drizzle adapter emits `default` for the id
  // column and relies on the database to produce one - its `generateId` setting does
  // not fill this in. Found by the exit drill failing on a not-null violation, not by
  // reading the adapter. Postgres gen_random_uuid() is the source of truth for these
  // four tables' ids; the seeded system actor supplies its own fixed UUID explicitly.
  id: uuid('id').primaryKey().defaultRandom(),
  // better-auth core
  name: text('full_name').notNull(),
  email: text('email').notNull().unique(),
  emailVerified: boolean('email_verified').notNull().default(false),
  image: text('image'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  // ClubChat profile
  bio: text('bio'),
  city: text('city'),
  dob: date('dob'),
  school: text('school'),
  // Account lifecycle. Deletion anonymises and blocks future sign-in; it does not
  // remove content, so history stays readable (domain invariant 10).
  anonymizedAt: timestamp('anonymized_at', { withTimezone: true }),
  signinBlockedAt: timestamp('signin_blocked_at', { withTimezone: true }),
  // Gates the DM report queue only, and nothing else. See TECH/05-authorization.md.
  isPlatformModerator: boolean('is_platform_moderator').notNull().default(false),
});

export const sessions = pgTable('sessions', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  token: text('token').notNull().unique(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  ipAddress: text('ip_address'),
  userAgent: text('user_agent'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const accounts = pgTable('accounts', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  accountId: text('account_id').notNull(),
  providerId: text('provider_id').notNull(),
  accessToken: text('access_token'),
  refreshToken: text('refresh_token'),
  accessTokenExpiresAt: timestamp('access_token_expires_at', { withTimezone: true }),
  refreshTokenExpiresAt: timestamp('refresh_token_expires_at', { withTimezone: true }),
  scope: text('scope'),
  idToken: text('id_token'),
  password: text('password'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const verifications = pgTable('verifications', {
  id: uuid('id').primaryKey().defaultRandom(),
  identifier: text('identifier').notNull(),
  value: text('value').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// ---------------------------------------------------------------------------
// Clubs and membership
// ---------------------------------------------------------------------------

/**
 * `inviteToken`, not `inviteCode`. Nobody types it: it exists only inside a share
 * link. It is therefore 32 bytes of CSPRNG as base64url, matched exactly and
 * case-sensitively. Do NOT shorten it or make it case-insensitive - that shape
 * existed only to be typed by hand, and it is the shape that is feasible to
 * enumerate. See ADR-0010.
 */
export const clubs = pgTable('clubs', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  sport: text('sport').notNull(),
  description: text('description'),
  joinPolicy: text('join_policy').notNull().default('open'),
  inviteToken: text('invite_token').notNull().unique(),
  inviteTokenRotatedAt: timestamp('invite_token_rotated_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const clubMemberships = pgTable(
  'club_memberships',
  {
    clubId: uuid('club_id')
      .notNull()
      .references(() => clubs.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: text('role').notNull(),
    joinedAt: timestamp('joined_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.clubId, t.userId] }),
    // Domain invariant 1: exactly one Owner per club, always. Enforced here rather
    // than in a handler because an ownerless club has NO recovery path, and because
    // the ownership-transfer path must demote before it promotes - the constraint is
    // checked per statement, so the other order momentarily holds two owners and
    // correctly fails.
    uniqueIndex('club_memberships_one_owner')
      .on(t.clubId)
      .where(sql`role = 'owner'`),
    check('club_memberships_role_valid', sql`role in ('owner', 'admin', 'member')`),
    index('club_memberships_by_user').on(t.userId),
  ],
);

/**
 * Pending and decided join requests.
 *
 * The partial unique index is what makes decisions idempotent: two admins hitting Approve
 * on the same request must produce **one** membership, one notification and one recorded
 * decider. Scoped to `pending` so a denied request can be re-filed later - a plain
 * UNIQUE would permanently bar anyone who was ever turned down.
 */
export const clubJoinRequests = pgTable(
  'club_join_requests',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    clubId: uuid('club_id')
      .notNull()
      .references(() => clubs.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    status: text('status').notNull().default('pending'),
    decidedBy: uuid('decided_by').references(() => users.id, { onDelete: 'set null' }),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('club_join_requests_one_pending')
      .on(t.clubId, t.userId)
      .where(sql`status = 'pending'`),
    check('club_join_requests_status_valid', sql`status in ('pending', 'approved', 'denied')`),
    index('club_join_requests_by_club').on(t.clubId, t.status),
  ],
);

// ---------------------------------------------------------------------------
// Eboard
// ---------------------------------------------------------------------------

/** Exactly one per club, created automatically with the club. */
export const eboardChannels = pgTable('eboard_channels', {
  id: uuid('id').primaryKey().defaultRandom(),
  clubId: uuid('club_id')
    .notNull()
    .unique()
    .references(() => clubs.id, { onDelete: 'cascade' }),
  name: text('name').notNull().default('Eboard & Council'),
  description: text('description'),
});

export const eboardMemberships = pgTable(
  'eboard_memberships',
  {
    eboardId: uuid('eboard_id')
      .notNull()
      .references(() => eboardChannels.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    joinedAt: timestamp('joined_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.eboardId, t.userId] })],
);

// ---------------------------------------------------------------------------
// The channel abstraction - one concept, four scopes
// ---------------------------------------------------------------------------

/**
 * Channels.
 *
 * `lastSeq` is the per-channel message counter. It is bumped inside the same
 * transaction that inserts the message, under a row lock held until commit, which
 * is what makes `seq` gapless. See appendMessage and SPEC/TECH/02-channel-log.md.
 *
 * `clubId` is nullable ONLY for the dm scope: two people who share two clubs must
 * get one thread, not two, so a DM cannot belong to a club. The check constraint
 * stops the other three scopes from ever exploiting the relaxed column.
 */
export const channels = pgTable(
  'channels',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    clubId: uuid('club_id').references(() => clubs.id, { onDelete: 'cascade' }),
    scope: text('scope').notNull(),
    // For scope='club' this is the club id, for 'eboard' the eboard id, and so on.
    // NOT NULL on purpose: a nullable column inside a unique index is treated as
    // distinct by Postgres and would silently defeat the constraint below.
    scopeId: uuid('scope_id').notNull(),
    lastSeq: integer('last_seq').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('channels_scope_valid', sql`scope in ('club', 'race', 'eboard', 'dm')`),
    // Domain invariant 2: exactly one main channel per club. Any lookup for "the
    // club's main channel" must also exclude race- and eboard-scoped channels;
    // forgetting that predicate produced "more than one row returned by a subquery"
    // twice in v1.
    uniqueIndex('channels_one_main_per_club')
      .on(t.clubId)
      .where(sql`scope = 'club'`),
    uniqueIndex('channels_scope_identity').on(t.scope, t.scopeId),
    check('channels_dm_has_no_club', sql`(club_id is null) = (scope = 'dm')`),
  ],
);

/**
 * The channel log. One row per message, ever - no per-recipient copy (ADR-0003).
 *
 * Both `senderId` and `clientMsgId` are NOT NULL, and that is load-bearing rather
 * than tidiness: Postgres treats NULLs as distinct inside a unique index, so one
 * nullable column silently defeats the idempotency constraint below. System
 * messages therefore use the reserved system-actor UUID, never NULL - and system
 * messages are exactly the class the worker retries after a crash, so they are
 * exactly the class that must not slip through.
 */
export const messages = pgTable(
  'messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    channelId: uuid('channel_id')
      .notNull()
      .references(() => channels.id, { onDelete: 'cascade' }),
    seq: integer('seq').notNull(),
    senderId: uuid('sender_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    type: text('type').notNull().default('text'),
    body: text('body'),
    clientMsgId: uuid('client_msg_id').notNull(),
    pinned: boolean('pinned').notNull().default(false),
    // Soft delete with a tombstone, never a removal: a message vanishing
    // mid-conversation makes the replies unreadable (domain invariant 7).
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('messages_channel_seq').on(t.channelId, t.seq),
    // Idempotency. A retry after a flaky network hits this index and the handler
    // returns the existing row's seq instead of erroring, which is what makes the
    // client's send outbox safe to retry aggressively.
    uniqueIndex('messages_idempotency').on(t.channelId, t.senderId, t.clientMsgId),
    // The paging index: history reads walk backward from the live tail.
    index('messages_channel_seq_desc').on(t.channelId, t.seq.desc()),
    // Highlights must not lose pins past the loaded window, so the pinned and
    // announcement lists are server-side queries over the WHOLE channel rather
    // than a computed slice of loaded history.
    index('messages_pinned')
      .on(t.channelId, t.seq)
      .where(sql`pinned`),
    index('messages_announcements')
      .on(t.channelId, t.seq)
      .where(sql`type = 'announcement'`),
    check('messages_seq_positive', sql`seq > 0`),
  ],
);

/**
 * Read cursors.
 *
 * Opening a chat sets `lastReadSeq = channel.lastSeq`. That is the only thing that
 * clears an unread count. The count itself is never stored: it is
 * `channel.lastSeq - cursor.lastReadSeq`, which is O(1) and cannot drift.
 *
 * This table is also what suppresses push, and that is a correctness requirement
 * rather than an optimisation - `lastReadSeq >= N` is a fact committed to Postgres
 * that the member saw the message, whereas a live socket is proof of nothing
 * (ADR-0008).
 */
export const readCursors = pgTable(
  'read_cursors',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    channelId: uuid('channel_id')
      .notNull()
      .references(() => channels.id, { onDelete: 'cascade' }),
    lastReadSeq: integer('last_read_seq').notNull().default(0),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.channelId] })],
);

// ---------------------------------------------------------------------------
// The transactional outbox
// ---------------------------------------------------------------------------

/**
 * Every command handler writes domain rows AND outbox events in one transaction.
 * Either both land or neither does - a guarantee an external queue cannot give you,
 * and the entire reason the outbox exists rather than publishing from a handler.
 *
 * `processedAt`, not `publishedAt`, and the distinction is deliberate. ADR-0006
 * defines `published_at` as meaning "handed to Kafka, NOT effect performed".
 * Phase 0 has no Kafka - the worker drains this table directly with
 * FOR UPDATE SKIP LOCKED - so here the column genuinely does mean "effect
 * performed". Using the Kafka-era name for a non-Kafka meaning is precisely the
 * drift that ADR warns about. Phase 1.5 renames this column when the relay and
 * Kafka arrive, which is one migration and is already budgeted in that ADR.
 *
 * `partitionKey` is the ordering domain (a channel id or a club id). It exists now,
 * before Kafka does, because it is the key Kafka must eventually partition by:
 * ordering is guaranteed within a partition only, and any other key silently breaks
 * per-channel ordering with "a system message arriving before the event that caused
 * it" as the symptom.
 */
export const outbox = pgTable(
  'outbox',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    partitionKey: text('partition_key').notNull(),
    eventType: text('event_type').notNull(),
    payload: jsonb('payload').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    processedAt: timestamp('processed_at', { withTimezone: true }),
    attempts: integer('attempts').notNull().default(0),
    lastError: text('last_error'),
  },
  (t) => [
    // The relay claim index. Partial on unprocessed rows so the index stays small
    // no matter how much history accumulates.
    index('outbox_unprocessed')
      .on(t.partitionKey, t.id)
      .where(sql`processed_at is null`),
  ],
);

// ---------------------------------------------------------------------------
// Notifications, devices and mutes  (Phase 1)
// ---------------------------------------------------------------------------

/**
 * Discrete notifications.
 *
 * **No `body` column and no `target` column, deliberately.** Both the display text and
 * the navigation destination are derived at READ time from `(type, params)`. A stored
 * route string left approvals permanently unresolved for eight migrations in v1
 * (engineering pitfall 8), and a stored English body is unlocalizable and correctable
 * only by rewriting history (roadmap debt 11). See ADR-0013.
 *
 * `params` is validated against a per-type Zod schema at write time, so a malformed
 * param fails the write rather than surfacing as broken text in an inbox months later.
 *
 * The other row kind in the inbox - a chat unread - is **not stored at all**. It is
 * derived from `channel.last_seq - cursor.last_read_seq`, because a stored count drifts
 * and a computed one cannot.
 */
export const notifications = pgTable(
  'notifications',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    recipientId: uuid('recipient_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    // Nullable: not every notification has a human actor (a deadline passing has none).
    actorId: uuid('actor_id').references(() => users.id, { onDelete: 'set null' }),
    // Nullable for dm-scoped notifications, since a DM belongs to no club. Every
    // audience query has to tolerate it.
    clubId: uuid('club_id').references(() => clubs.id, { onDelete: 'cascade' }),
    type: text('type').notNull(),
    params: jsonb('params').notNull(),
    // bigint, NOT bigserial. This references an outbox row's id; it is not a value
    // this table generates. bigserial would attach a sequence default, so an insert
    // that forgot to supply the id would silently get a sequence number and defeat
    // the idempotency index below rather than failing loudly.
    //
    // There is deliberately NO foreign key to outbox: the outbox is pruned nightly
    // after 7 days, and a cascade would delete a member's notification history along
    // with it. This column is an idempotency key, not a relationship.
    outboxEventId: bigint('outbox_event_id', { mode: 'number' }).notNull(),
    readAt: timestamp('read_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // At-least-once safety. Outbox delivery WILL redeliver, and without this a
    // redelivered event fans out a second copy of every notification it produced.
    uniqueIndex('notifications_idempotency').on(t.outboxEventId, t.recipientId),
    // The inbox feed: newest first, per recipient.
    index('notifications_feed').on(t.recipientId, t.createdAt.desc()),
    // The badge counts unread rows only, so keep the index to those.
    index('notifications_unread')
      .on(t.recipientId)
      .where(sql`read_at is null`),
  ],
);

/**
 * Registered push targets.
 *
 * Push is targeted per DEVICE while suppression is per MEMBER via the read cursor. A
 * member with a laptop open and a phone in their pocket has not read the message, so
 * both devices are pushed and the phone rings; once they read it anywhere, the cursor
 * suppresses for that member everywhere at once. That is the behaviour you want, and it
 * is why this table exists separately from any notion of "is a socket alive".
 */
export const devices = pgTable(
  'devices',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    // Unique so re-registering the same physical device updates rather than duplicates,
    // which is what stops one phone receiving N copies of every push.
    pushToken: text('push_token').notNull().unique(),
    platform: text('platform').notNull(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
    // Set when the provider reports the token dead. Kept rather than deleted so a
    // dedupe key referencing it stays resolvable.
    invalidatedAt: timestamp('invalidated_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('devices_platform_valid', sql`platform in ('ios', 'android', 'web')`),
    // The audience query walks a member's live devices.
    index('devices_live_for_user')
      .on(t.userId)
      .where(sql`invalidated_at is null`),
  ],
);

/**
 * Push dedupe ledger.
 *
 * At-least-once delivery means the worker will re-evaluate an event it has already
 * pushed. Without a record of what already went out, a redelivered event buzzes every
 * phone a second time - and unlike a duplicated database row, that one is impossible to
 * take back. Keyed exactly as SPEC/TECH/06 specifies.
 */
export const pushDeliveries = pgTable(
  'push_deliveries',
  {
    // bigint for the same reason as on notifications: a reference, not a generated
    // value, and no FK because outbox rows are pruned while this ledger must outlive
    // them - a pruned outbox row must never make an already-sent push re-sendable.
    outboxEventId: bigint('outbox_event_id', { mode: 'number' }).notNull(),
    deviceId: uuid('device_id')
      .notNull()
      .references(() => devices.id, { onDelete: 'cascade' }),
    sentAt: timestamp('sent_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.outboxEventId, t.deviceId] })],
);

/**
 * Per-conversation mute.
 *
 * A muted conversation produces no push but its unread count still accrues - mute is
 * not "mark as read". Read by the push audience function and applying to EVERY scope,
 * not just dm: this is the "per-user mute and notification preferences" that had
 * nowhere to live before the audience function existed.
 */
export const channelMutes = pgTable(
  'channel_mutes',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    channelId: uuid('channel_id')
      .notNull()
      .references(() => channels.id, { onDelete: 'cascade' }),
    // NULL means muted indefinitely, rather than "not muted" - the row's existence is
    // the mute.
    mutedUntil: timestamp('muted_until', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.channelId] })],
);

/**
 * Mentions.
 *
 * A mention notifies the mentioned member individually, and **only if they can actually
 * access that chat** - the audience function re-checks, because a client could name
 * anyone.
 */
export const messageMentions = pgTable(
  'message_mentions',
  {
    messageId: uuid('message_id')
      .notNull()
      .references(() => messages.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
  },
  (t) => [primaryKey({ columns: [t.messageId, t.userId] })],
);

// ---------------------------------------------------------------------------
// Races  (Phase 2)
// ---------------------------------------------------------------------------

/**
 * A race: a mini-club nested one level inside a club.
 *
 * Same shape as a club - membership, roster, chat, sub-features - rather than a
 * special-purpose "event" screen. That is why it gets a channel from the shared
 * abstraction instead of its own message table.
 *
 * The five `meet*` columns are Meet Information, kept as columns on the race rather than a
 * separate table because they are **edited together as one form**. A `meet_information`
 * table would invite partial saves of something the product treats as atomic.
 *
 * `raceDate` is a DATE, not a timestamp: a race has a day, not a time. Storing it as a
 * timestamp would reintroduce the timezone bug where a date-only value parsed as an ISO
 * string becomes UTC midnight and renders a day early in negative-offset zones.
 */
export const races = pgTable(
  'races',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    clubId: uuid('club_id')
      .notNull()
      .references(() => clubs.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    raceDate: date('race_date').notNull(),
    // Meet Information. Empty-state behaviour differs per field on purpose: description,
    // location and hotel are hidden when empty, while photos and results always show a
    // "stay tuned" placeholder - photos and results are expected later, a missing hotel
    // link usually means there is no hotel. That is a render decision, not a schema one.
    meetDescription: text('meet_description'),
    meetLocationUrl: text('meet_location_url'),
    meetHotelUrl: text('meet_hotel_url'),
    meetPhotosUrl: text('meet_photos_url'),
    meetResultsUrl: text('meet_results_url'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('races_by_club').on(t.clubId, t.raceDate)],
);

/**
 * The race roster.
 *
 * **The ONLY source of truth for race access.** Club-admin status is management authority,
 * never access - substituting one for the other was wrong in five separate places in v1, so
 * this table is the single thing every race access predicate consults.
 */
export const raceMemberships = pgTable(
  'race_memberships',
  {
    raceId: uuid('race_id')
      .notNull()
      .references(() => races.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    joinedAt: timestamp('joined_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.raceId, t.userId] }),
    index('race_memberships_by_user').on(t.userId),
  ],
);

export const raceJoinRequests = pgTable(
  'race_join_requests',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    raceId: uuid('race_id')
      .notNull()
      .references(() => races.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    status: text('status').notNull().default('pending'),
    decidedBy: uuid('decided_by').references(() => users.id, { onDelete: 'set null' }),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Scoped to pending, so a denied request can be re-filed.
    uniqueIndex('race_join_requests_one_pending')
      .on(t.raceId, t.userId)
      .where(sql`status = 'pending'`),
    check('race_join_requests_status_valid', sql`status in ('pending', 'approved', 'denied')`),
  ],
);

/**
 * Race pins.
 *
 * **Personal.** Each member pins for themselves and it affects only their own club-hub
 * preview, never anyone else's. Club-wide admin pins were built in v1 and then corrected;
 * the primary key including `user_id` is what makes the wrong version unrepresentable.
 *
 * Any member can pin any race they can SEE, which is every race in their club - pinning is
 * not gated on race access, so this deliberately has no dependency on the roster.
 */
export const racePins = pgTable(
  'race_pins',
  {
    raceId: uuid('race_id')
      .notNull()
      .references(() => races.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.raceId, t.userId] })],
);

/**
 * Car groups.
 *
 * Auto-numbered on creation - "Group 1", "Group 2" - with no naming prompt, because naming
 * eight cars is friction.
 *
 * The `UNIQUE (id, race_id)` looks redundant against the primary key, and it is not: it is
 * the target the composite foreign key on `car_group_members` needs. See below.
 */
export const carGroups = pgTable(
  'car_groups',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    raceId: uuid('race_id')
      .notNull()
      .references(() => races.id, { onDelete: 'cascade' }),
    number: integer('number').notNull(),
    // Cleared automatically when the holder leaves the group. Nullable because a group
    // legitimately persists with no Incharge until an admin names a new one.
    inchargeUserId: uuid('incharge_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('car_groups_race_number').on(t.raceId, t.number),
    // A UNIQUE CONSTRAINT, not a unique index, and the distinction matters: drizzle-kit
    // emits every foreign key BEFORE every CREATE INDEX, so a composite FK pointing at an
    // index would reference something that does not exist yet and the migration would fail.
    // A table constraint is emitted inline with CREATE TABLE, so it is already there.
    // Redundant against the PK otherwise.
    unique('car_groups_id_race').on(t.id, t.raceId),
  ],
);

/**
 * Car group membership.
 *
 * > **Domain invariant 5: a person is in at most one car group per race.**
 * >
 * > Enforcing that needs `race_id` on this table, which means denormalising it off
 * > `car_groups`. A generated column cannot do it - Postgres generated columns may only
 * > reference columns in their own row, and `race_id` lives on the parent. So the value is
 * > stored, and the **composite foreign key** back to `car_groups (id, race_id)` makes the
 * > stored value provably consistent with the group's actual race.
 * >
 * > The result is that the invariant is enforced by the database rather than trusted from a
 * > handler. Without the composite FK the denormalised `race_id` could drift and the unique
 * > index below would be guarding a lie.
 */
export const carGroupMembers = pgTable(
  'car_group_members',
  {
    carGroupId: uuid('car_group_id').notNull(),
    raceId: uuid('race_id').notNull(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.carGroupId, t.userId] }),
    // Invariant 5, at the data layer.
    uniqueIndex('car_group_members_one_per_race').on(t.raceId, t.userId),
    foreignKey({
      columns: [t.carGroupId, t.raceId],
      foreignColumns: [carGroups.id, carGroups.raceId],
    }).onDelete('cascade'),
  ],
);

// ---------------------------------------------------------------------------
// Eboard meetings
// ---------------------------------------------------------------------------

/**
 * A meeting.
 *
 * Any Eboard member creates one; **only its creator edits or deletes it**. Two explicit
 * founder follow-ups landed on that rule after meetings first shipped as any-member
 * editable, which is why `creatorId` is not merely audit metadata here - it is the
 * authorization subject.
 */
export const meetings = pgTable(
  'meetings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    eboardId: uuid('eboard_id')
      .notNull()
      .references(() => eboardChannels.id, { onDelete: 'cascade' }),
    creatorId: uuid('creator_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    title: text('title').notNull(),
    description: text('description'),
    startsAt: timestamp('starts_at', { withTimezone: true }).notNull(),
    link: text('link'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('meetings_by_eboard').on(t.eboardId, t.startsAt)],
);

// ---------------------------------------------------------------------------
// Polls
// ---------------------------------------------------------------------------

/**
 * A poll, in any of the three scopes.
 *
 * One poll concept with a club/race/eboard scope, repeating the channel abstraction's trick.
 *
 * **No `is_closed` column.** Closed-ness is evaluated at READ time as
 * `closed_at IS NOT NULL OR closes_at < now()`, because a passed deadline must read as
 * closed **everywhere** without anyone having closed it. A stored boolean would need a job
 * to flip it, and there deliberately is no job that closes polls - the only scheduled job is
 * the closing-soon reminder.
 *
 * `UNIQUE (id, allow_multiple)` is the composite-FK target that lets `poll_votes` enforce
 * single-choice voting in the database. See below.
 */
export const polls = pgTable(
  'polls',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    clubId: uuid('club_id')
      .notNull()
      .references(() => clubs.id, { onDelete: 'cascade' }),
    scope: text('scope').notNull(),
    scopeId: uuid('scope_id').notNull(),
    creatorId: uuid('creator_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    question: text('question').notNull(),
    allowMultiple: boolean('allow_multiple').notNull().default(false),
    isPrivate: boolean('is_private').notNull().default(false),
    closedAt: timestamp('closed_at', { withTimezone: true }),
    closesAt: timestamp('closes_at', { withTimezone: true }),
    // Stamped in the same transaction as the fan-out, which is what makes the reminder fire
    // at most once per poll, ever.
    closingSoonNotifiedAt: timestamp('closing_soon_notified_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('polls_scope_valid', sql`scope in ('club', 'race', 'eboard')`),
    // A constraint rather than an index, for the same ordering reason as car_groups above:
    // poll_votes' composite FK points here.
    unique('polls_id_allow_multiple').on(t.id, t.allowMultiple),
    index('polls_by_scope').on(t.scope, t.scopeId),
    // The scheduled job's claim index: open polls with a deadline not yet flagged.
    index('polls_closing_soon')
      .on(t.closesAt)
      .where(sql`closed_at is null and closing_soon_notified_at is null and closes_at is not null`),
  ],
);

/**
 * Poll options.
 *
 * `voteCount` is a maintained column rather than a derived count, and that is a deliberate
 * carry-over: **vote counts are public while voter identity is gated**, so a count cannot be
 * derived from rows the viewer is forbidden to read. Updated inside the vote transaction.
 */
export const pollOptions = pgTable(
  'poll_options',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    pollId: uuid('poll_id')
      .notNull()
      .references(() => polls.id, { onDelete: 'cascade' }),
    label: text('label').notNull(),
    position: integer('position').notNull(),
    voteCount: integer('vote_count').notNull().default(0),
  },
  (t) => [
    uniqueIndex('poll_options_position').on(t.pollId, t.position),
    check('poll_options_count_non_negative', sql`vote_count >= 0`),
  ],
);

/**
 * A vote.
 *
 * > **Single-choice voting is enforced by the database, not by the handler.**
 * >
 * > `allow_multiple` is denormalised onto each vote, with a composite foreign key back to
 * > `polls (id, allow_multiple)` so the copy cannot drift from the poll. That makes the
 * > partial unique index below meaningful: on a single-choice poll, a member can hold at
 * > most one vote, so "tapping a different option MOVES the vote rather than adding a
 * > second" is guaranteed rather than merely implemented.
 * >
 * > Same pattern as `car_group_members`, and the migration checklist lists it as the
 * > house style for exactly this shape.
 */
export const pollVotes = pgTable(
  'poll_votes',
  {
    pollId: uuid('poll_id').notNull(),
    optionId: uuid('option_id')
      .notNull()
      .references(() => pollOptions.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    allowMultiple: boolean('allow_multiple').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.optionId, t.userId] }),
    uniqueIndex('poll_votes_single_choice')
      .on(t.pollId, t.userId)
      .where(sql`not allow_multiple`),
    foreignKey({
      columns: [t.pollId, t.allowMultiple],
      foreignColumns: [polls.id, polls.allowMultiple],
    }).onDelete('cascade'),
  ],
);

// ---------------------------------------------------------------------------
// Calendar, routines, news
// ---------------------------------------------------------------------------

/**
 * A calendar event. Club-scoped only.
 *
 * The `race` type is a **label only** and has no relationship to a real Race. Spawning races
 * from a race-type event was designed and never built; the two remain unconnected, and an
 * open question asks whether the type should be removed for reading as though it were.
 */
export const calendarEvents = pgTable(
  'calendar_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    clubId: uuid('club_id')
      .notNull()
      .references(() => clubs.id, { onDelete: 'cascade' }),
    type: text('type').notNull(),
    title: text('title').notNull(),
    startsAt: timestamp('starts_at', { withTimezone: true }).notNull(),
    endsAt: timestamp('ends_at', { withTimezone: true }),
    location: text('location'),
    description: text('description'),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check(
      'calendar_events_type_valid',
      sql`type in ('race', 'practice', 'team_bonding', 'volunteer', 'other')`,
    ),
    index('calendar_events_by_club').on(t.clubId, t.startsAt),
  ],
);

/**
 * A weekly routine workout. The feature that replaces the screenshotted Excel sheet.
 *
 * `workoutDate` is a real calendar DATE - the week view shows one real Monday-to-Sunday
 * week, not a repeating template. Deliberately carries an activity type, a title and an
 * optional description and **nothing else**: no sets, reps, distances or splits, and no
 * completion tracking. That is an explicit "keep it very simple" scoping call, not an
 * omission to be filled in later.
 */
export const routineWorkouts = pgTable(
  'routine_workouts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    clubId: uuid('club_id')
      .notNull()
      .references(() => clubs.id, { onDelete: 'cascade' }),
    workoutDate: date('workout_date').notNull(),
    activityType: text('activity_type').notNull(),
    title: text('title').notNull(),
    description: text('description'),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check(
      'routine_workouts_activity_valid',
      sql`activity_type in ('run', 'trail_run', 'bike', 'swim', 'strength',
                            'hybrid_fitness', 'indoor_climb', 'bouldering', 'xc_ski', 'other')`,
    ),
    index('routine_workouts_by_club').on(t.clubId, t.workoutDate),
  ],
);

/**
 * A news post. The club's front page.
 *
 * A post must have **body text, a photo, or both** - the check constraint carries that, so
 * an entirely empty post cannot exist even if a handler forgets.
 *
 * `mediaId` has no foreign key yet: `media_objects` arrives in Phase 3. The column exists
 * now so the check constraint can express the invariant today rather than being retrofitted
 * over historical rows.
 */
export const newsPosts = pgTable(
  'news_posts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    clubId: uuid('club_id')
      .notNull()
      .references(() => clubs.id, { onDelete: 'cascade' }),
    authorId: uuid('author_id').references(() => users.id, { onDelete: 'set null' }),
    body: text('body'),
    mediaId: uuid('media_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('news_posts_not_empty', sql`body is not null or media_id is not null`),
    index('news_posts_by_club').on(t.clubId, t.createdAt.desc()),
  ],
);

/** One reaction per emoji per member per post. Same fixed emoji set as chat. */
export const newsReactions = pgTable(
  'news_reactions',
  {
    postId: uuid('post_id')
      .notNull()
      .references(() => newsPosts.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    emoji: text('emoji').notNull(),
  },
  (t) => [primaryKey({ columns: [t.postId, t.userId, t.emoji] })],
);
