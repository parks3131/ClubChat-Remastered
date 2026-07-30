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
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
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
