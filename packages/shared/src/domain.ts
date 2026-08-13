/**
 * Domain vocabulary shared by every process and by the client.
 *
 * This module holds names and shapes only. Behaviour lives in the server's policy
 * and domain modules; putting a predicate here would give it a second home, which
 * is the failure mode SPEC/TECH/05-authorization.md exists to prevent.
 */

import { z } from 'zod';
import { emojiCatalog } from './emoji-catalog.generated.ts';

/**
 * The reserved system actor.
 *
 * System messages are authored by this user, never by NULL. Postgres treats NULLs
 * as distinct inside a unique index, so a NULL sender_id would silently defeat
 * `UNIQUE (channel_id, sender_id, client_msg_id)` - and the one class of message
 * the worker retries after a crash is exactly the class the constraint would then
 * fail to protect. Seeded by the first migration.
 *
 * See SPEC/TECH/03-message-flows.md.
 */
export const SYSTEM_ACTOR_ID = '00000000-0000-4000-8000-000000000001';

/**
 * The four channel scopes.
 *
 * There is one chat implementation and it serves all four. A feature added to club
 * chat is added to every scope or it is an explicit parameter.
 * See SPEC/PRD/01-domain-model.md.
 */
export const channelScopes = ['club', 'race', 'eboard', 'dm'] as const;
export const ChannelScope = z.enum(channelScopes);
export type ChannelScope = z.infer<typeof ChannelScope>;

/** Club membership tiers. Owner is a strict superset of admin. */
export const clubRoles = ['owner', 'admin', 'member'] as const;
export const ClubRole = z.enum(clubRoles);
export type ClubRole = z.infer<typeof ClubRole>;

/**
 * The admin tier.
 *
 * Every audience query and authority check that filters on "admin" must match both
 * of these. A bare `admin` filter silently excludes a club whose only admin-tier
 * member is the Owner, which is every brand-new club. That bug shipped four
 * separate times in v1, which is why the tier is a named constant rather than a
 * literal repeated at each call site. See SPEC/PRD/02-roles-and-permissions.md.
 */
export const ADMIN_TIER: readonly ClubRole[] = ['owner', 'admin'];

export const joinPolicies = ['open', 'request'] as const;
export const JoinPolicy = z.enum(joinPolicies);
export type JoinPolicy = z.infer<typeof JoinPolicy>;

/**
 * Message types.
 *
 * Phase 0 only produces `text` and `system`, but the full set is declared here so
 * the wire format does not change shape when later phases start emitting the rest.
 * See SPEC/PRD/01-domain-model.md.
 */
export const messageTypes = [
  'text',
  'photo',
  'document',
  'announcement',
  'system',
  'poll',
  'event',
  'meeting',
] as const;
export const MessageType = z.enum(messageTypes);
export type MessageType = z.infer<typeof MessageType>;

export const platforms = ['ios', 'android', 'web'] as const;
export const Platform = z.enum(platforms);
export type Platform = z.infer<typeof Platform>;

export const Uuid = z.string().uuid();

/**
 * The set of emoji a reaction may be.
 *
 * **The catalog, not a constant.** Six fixed emoji shipped first and were widened to the whole
 * catalog on 2026-08-13; see ADR-0028 for why the set is a database table. This validator and
 * that table are generated from the same pinned dataset, so the API and the foreign key cannot
 * disagree about what exists - and a client sending a byte-different encoding of the right emoji
 * is refused here with a clean 400 rather than reaching a constraint violation.
 *
 * A `Set` rather than `z.enum`: an enum of 1,914 members produces a type union of 1,914 string
 * literals, which is a real cost in every file that touches a reaction and buys nothing - the
 * value is checked at runtime either way, and no call site can usefully switch on it.
 */
const catalogEmoji = new Set<string>(emojiCatalog.map((e) => e.emoji));

export const ReactionEmoji = z
  .string()
  .refine((value) => catalogEmoji.has(value), { message: 'not a known emoji' });
export type ReactionEmoji = string;

/** Is this string an emoji anybody may react with? The one place that question is answered. */
export function isReactionEmoji(value: string): boolean {
  return catalogEmoji.has(value);
}

/**
 * Where an emoji sits in the catalog's own order.
 *
 * Used to break ties in the pill row so two emoji on equal counts hold their positions rather
 * than swapping about - SPEC/PRD/05 rule R3. Unknown emoji sort last, which cannot happen through
 * the API and can happen from a cache written before a dataset upgrade.
 */
const catalogOrdinal = new Map(emojiCatalog.map((e) => [e.emoji, e.order]));

/**
 * How many reaction pills a message shows before collapsing into a `+N` chip.
 *
 * SPEC/PRD/05 rule R2. Four, because the row sits under a bubble and has to stay a row.
 */
export const VISIBLE_REACTION_PILLS = 4;

/**
 * The most distinct emoji one message may carry.
 *
 * SPEC/PRD/05 rule R4, and the reason is ADR-0017: every update carries the full reaction set, so
 * an unbounded set of distinct emoji is an unbounded frame. The twenty-first is refused rather
 * than silently dropped.
 */
export const MAX_DISTINCT_REACTIONS = 20;

/**
 * Everyone who reacted with one emoji.
 *
 * `userIds` rather than a count, because a count cannot answer "did I react?" and cannot
 * render the who-reacted list. Reactions are visible to everyone by spec (SPEC/PRD/05
 * rule 4 of the acceptance list), so there is no identity to gate here - unlike poll
 * votes, where the count is public and the voters are not.
 */
export const MessageReaction = z.object({
  emoji: ReactionEmoji,
  userIds: z.array(Uuid),
});
export type MessageReaction = z.infer<typeof MessageReaction>;

/**
 * One person named in a message.
 *
 * > **The name is carried, not just the id**, which is the whole reason this is on the wire at
 * > all rather than being derived. A body reads `@Sean O Donnell` as plain text; to colour that
 * > span and make it open a profile, the client has to know which run of characters is a person
 * > and which person it is. Matching the text against a roster it may not have loaded - or may
 * > not be allowed to load, in a DM - is not a thing the client can do offline.
 *
 * The name is the one stored at send time and is deliberately NOT re-joined on read, unlike
 * `senderName`. It has to match the characters actually sitting in the body: a member who renames
 * themselves does not retroactively edit what everybody typed, so re-joining would produce a name
 * that highlights nothing.
 */
export const MessageMention = z.object({
  userId: Uuid,
  /** Exactly as it appears in the body, without the leading `@`. */
  name: z.string(),
});
export type MessageMention = z.infer<typeof MessageMention>;

/**
 * How much of a quoted message travels with the reply that quotes it.
 *
 * The quote box is two lines. A reply to an 8,000-character message would otherwise carry that
 * message twice - once as itself, once inside every reply to it - for text no quote box will
 * ever draw.
 */
export const REPLY_PREVIEW_CHARS = 140;

/**
 * The message a reply is answering, resolved for drawing.
 *
 * > **Joined at read time from `reply_to_seq`, never stored as a snapshot**, and the deciding
 * > case is deletion. A stored copy of the quoted text would survive the original being deleted,
 * > so the words an admin removed would live on inside every reply that quoted them - visible in
 * > the conversation, and out of reach of the delete that was supposed to remove them. Joining
 * > means a deleted original reads "This message was deleted" everywhere at once, for the same
 * > reason `senderName` is joined rather than stored.
 *
 * Carries enough to draw the box and nothing more: who said it, a truncated preview, and the
 * attachment identity for a photo or a document. What it does NOT carry is a second level of
 * quoting - replies are flat, so a quote of a reply shows the reply's own text, not a chain.
 */
export const MessageReplyRef = z.object({
  /** The quoted message's seq, which is also what tapping the quote jumps to. */
  seq: z.number().int().positive(),
  senderId: Uuid,
  /** Null for a sender whose account is gone, exactly as on the envelope itself. */
  senderName: z.string().nullable(),
  type: MessageType,
  /** Truncated to `REPLY_PREVIEW_CHARS`. Null for a photo with no caption, or a tombstone. */
  preview: z.string().nullable(),
  /** So the quote can draw a thumbnail rather than the word "Photo". */
  mediaId: Uuid.nullable().default(null),
  documentName: z.string().nullable().default(null),
  /**
   * Whether the original has since been deleted.
   *
   * The quote stays and says so, rather than vanishing. A reply whose quote disappeared reads as
   * an answer to nothing, which is the exact unreadability the tombstone exists to prevent
   * (domain invariant 7) - one level up.
   */
  deleted: z.boolean(),
});
export type MessageReplyRef = z.infer<typeof MessageReplyRef>;

/** Cut a quoted body down to what a quote box can show. One definition, both sides of the wire. */
export function replyPreview(body: string | null): string | null {
  if (body === null || body.length === 0) return null;
  return body.length <= REPLY_PREVIEW_CHARS ? body : body.slice(0, REPLY_PREVIEW_CHARS);
}

/**
 * The quote a message would produce if it were replied to.
 *
 * Here rather than in the client that uses it so it sits beside the server's version of the same
 * mapping, which builds a ref out of a database row. The two have to agree - one draws the
 * sender's optimistic bubble and the other draws everybody else's - and agreement is easier to
 * check when they are next to each other than when they are two packages apart.
 */
export function quoteOf(message: MessageEnvelopeShape): MessageReplyRef {
  return {
    seq: message.seq,
    senderId: message.senderId,
    senderName: message.senderName,
    type: message.type,
    preview: replyPreview(message.body),
    mediaId: message.mediaId,
    documentName: message.documentName,
    deleted: message.deletedAt !== null,
  };
}

/** What `quoteOf` reads. Declared structurally so it cannot depend on the envelope's own type. */
type MessageEnvelopeShape = {
  seq: number;
  senderId: string;
  senderName: string | null;
  type: MessageType;
  body: string | null;
  mediaId: string | null;
  documentName: string | null;
  deletedAt: string | null;
};

/**
 * A message as it appears on the wire and in the client's local store.
 *
 * `seq` is the ordering. `createdAt` is for display only - a timestamp is not an
 * ordering, and clock skew is real. See SPEC/TECH/02-channel-log.md.
 *
 * `reactions` rides along on the envelope rather than being fetched separately, which is
 * what makes them survive airplane mode along with the messages they belong to. See
 * ADR-0017. Defaulted so a producer that predates them still parses.
 */
export const MessageEnvelope = z.object({
  id: Uuid,
  channelId: Uuid,
  seq: z.number().int().positive(),
  senderId: Uuid,
  /**
   * Who sent it, ready to render.
   *
   * > **A group chat that does not say who is talking is broken**, and until 2026-07-30 the
   * > envelope carried only `senderId` - so every received bubble was anonymous. Found by
   * > comparing against v1, which joins the profile on every message read.
   *
   * On the envelope rather than looked up by the client, because the local cache has to be
   * **self-sufficient**: chat is readable in airplane mode from that cache, and a name resolved
   * by a separate request would be the one thing missing exactly when there is no network.
   *
   * Joined at read time, never stored on `messages` - so a member who changes their name has it
   * change everywhere, and a deleted account's history reads "Deleted member" by itself, which is
   * what "messages remain, unattributed" means in practice.
   *
   * **Nullable, and deliberately without a default.** Null is the honest answer for the client's
   * own optimistic bubble, which is built locally before any round trip and never renders a name
   * anyway - a sender does not need telling who they are. Leaving the default off keeps the
   * compiler forcing every construction site to answer, which is how all eight of them were found.
   */
  senderName: z.string().nullable(),
  /**
   * Their picture, as a media id. Null draws the letter placeholder instead.
   *
   * Rides beside `senderName` for every one of that field's reasons, and they are not decorative
   * here: a name resolved per message would be one request per distinct sender on a screen that
   * scrolls, and an avatar resolved that way would be the same again. Both are joined once, at
   * read time, and both are therefore in the offline cache.
   *
   * **A media id, never a URL.** Turning it into bytes is the authorized `/media/:id` hop, which
   * re-checks access on every request - the same rule the attached-media note below states. An
   * avatar is identity media and readable by any signed-in member, but it travels as an id all
   * the same, because a URL on the envelope is a capability leaking into history.
   *
   * Defaulted to null rather than required, unlike `senderName`. The name had eight construction
   * sites that each needed a deliberate answer; this one has a single honest default - a bubble
   * built before any round trip has no avatar to show either.
   */
  senderImage: z.string().nullable().default(null),
  type: MessageType,
  body: z.string().nullable(),
  clientMsgId: Uuid,
  pinned: z.boolean(),
  /**
   * When it was pinned, or null.
   *
   * The pinned strip orders by this, not by `seq`: a strip ordered by message age put a re-pinned
   * old message back in its old place, where a four-item cap dropped it straight back out. It is
   * also the only date a notice could honestly show for itself.
   */
  pinnedAt: z.string().datetime().nullable().default(null),
  reactions: z.array(MessageReaction).default([]),
  /**
   * Who is named in the body, so the client can colour those spans and open a profile from one.
   *
   * On the envelope for the same reason as `reactions` and `senderName`: chat is readable from
   * the local cache in airplane mode, and a mention that needed a roster lookup would be the one
   * thing missing exactly when there is no network. It is also the only way a DM can render one -
   * there is no roster there to look a name up in.
   *
   * Defaulted, so a producer predating this field still parses.
   */
  mentions: z.array(MessageMention).default([]),
  /**
   * The attached object, for a `photo` or `document` message.
   *
   * > **Phase 3 stored these on `messages` and never put them on the wire**, so a client
   * > receiving a photo knew its `type` was `'photo'` and had no way to find the bytes. The
   * > pipeline was complete and unreachable at the same time.
   *
   * Not a URL. Media is fetched through the authorized `/media/:id` hop, which re-checks the
   * same membership predicate that protects the message on **every** request - so what travels
   * here is an id, and turning it into bytes is a separate, authorized step. A URL on the
   * envelope would be a capability leaking into history.
   */
  mediaId: Uuid.nullable().default(null),
  /** Shown on a document bubble. A photo carries neither. */
  documentName: z.string().nullable().default(null),
  documentSize: z.number().int().nonnegative().nullable().default(null),
  /**
   * What this `card` message is a card FOR.
   *
   * > **The same defect as `mediaId` above, found the same way.** `linked_poll_id` has been
   * > stored on `messages` since Phase 2 so that deleting a poll can find and remove its card,
   * > but it was never put on the wire - so a client receiving a poll card had a sentence of
   * > text and no way to reach the poll it announced. The card rendered as a system line, and
   * > the whole point of a card is that it is not one.
   *
   * An id, not the poll: the tally moves after the card is written, so a card carrying a copy
   * of it would be wrong by the first vote. The client resolves the id through the same
   * authorized read the poll screen uses, which is also what keeps a member who may not see
   * this poll from learning its contents through a card.
   */
  linkedPollId: Uuid.nullable().default(null),
  /** The same, for an event card and a meeting card. One of the three at most is ever set. */
  linkedEventId: Uuid.nullable().default(null),
  linkedMeetingId: Uuid.nullable().default(null),
  /**
   * What this message is a reply to, ready to draw as a quote. Null for the great majority.
   *
   * The reply itself is stored as one integer - `reply_to_seq`, the quoted message's address
   * within the same channel - and this is that integer resolved. See `MessageReplyRef` for why
   * it is resolved on every read rather than snapshotted at send time.
   *
   * Defaulted, so a producer predating this field still parses.
   */
  replyTo: MessageReplyRef.nullable().default(null),
  deletedAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
});
export type MessageEnvelope = z.infer<typeof MessageEnvelope>;

/** Human-readable size for a document bubble. Kept in shared so both platforms agree. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  // One decimal below 10 and none above, so "9.4 MB" and "12 MB" rather than "12.0 MB".
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

/**
 * Collapse reactions for rendering: count per emoji, and whether the viewer is in it.
 *
 * A pure function over the envelope, in shared, so the pill row cannot disagree between
 * platforms about what "mine" means - and so the server never has to build a
 * per-recipient payload. That is the whole reason `userIds` travels instead of a count:
 * one publish serves every viewer.
 *
 * **Most reacted first, ties broken by catalog order** - SPEC/PRD/05 rule R3.
 *
 * > **This used to iterate the fixed six**, which gave a stable row for free and silently
 * > dropped anything outside the list. With the set open that would hide real reactions with no
 * > error anywhere, so the order is now computed. Ordering by count means the row CAN reshuffle
 * > as people tap, which was chosen deliberately over a stable order; the catalog tie-break is
 * > what keeps it to the smallest version of that cost, since equal counts never swap.
 *
 * Returns every emoji with reactors. Deciding how many to *show* is the caller's job -
 * `VISIBLE_REACTION_PILLS` and the `+N` chip.
 */
export function reactionSummary(
  reactions: readonly MessageReaction[],
  viewerId: string | null,
): Array<{ emoji: ReactionEmoji; count: number; mine: boolean }> {
  return reactions
    .filter((r) => r.userIds.length > 0)
    .map((r) => ({
      emoji: r.emoji,
      count: r.userIds.length,
      mine: viewerId !== null && r.userIds.includes(viewerId),
    }))
    .sort(
      (a, b) =>
        b.count - a.count ||
        (catalogOrdinal.get(a.emoji) ?? Number.MAX_SAFE_INTEGER) -
          (catalogOrdinal.get(b.emoji) ?? Number.MAX_SAFE_INTEGER),
    );
}

/** Per-channel sync state, as handed to the client on `auth.ok`. */
export const ChannelState = z.object({
  id: Uuid,
  scope: ChannelScope,
  /**
   * What this channel belongs to - the club, race, Eboard space or conversation.
   *
   * Carried so a screen holding a race or an Eboard id can find its channel's unread count
   * without a second read. Without it the club hub could badge its main chat and nothing else,
   * which is how unread sitting in the Eboard space became invisible everywhere.
   */
  scopeId: Uuid,
  clubId: Uuid.nullable(),
  lastSeq: z.number().int().nonnegative(),
  lastReadSeq: z.number().int().nonnegative(),
});
export type ChannelState = z.infer<typeof ChannelState>;

export const Club = z.object({
  id: Uuid,
  name: z.string(),
  sport: z.string(),
  description: z.string().nullable(),
  /** The club's picture, as a media id. Null falls back to its initial. */
  image: z.string().nullable().default(null),
  joinPolicy: JoinPolicy,
  role: ClubRole,
  mainChannelId: Uuid,
});
export type Club = z.infer<typeof Club>;

/** How much of a message body a conversation row can show. Shorter than a quote box. */
export const CONVERSATION_PREVIEW_CHARS = 80;

/**
 * The last thing said in a conversation, as a list row needs it.
 *
 * Structured fields rather than a finished sentence, for the reason
 * [ADR-0013](../../../SPEC/decisions/0013-notifications-store-type-and-params.md) gives about
 * notifications: the wording is produced where it is read, so it stays localisable and a copy
 * edit is one function rather than a migration. `conversationPreview` below is that function,
 * and it lives here so the client cannot render this differently from anywhere else that wants
 * it later.
 */
export const ConversationLastMessage = z.object({
  seq: z.number().int().positive(),
  type: MessageType,
  /**
   * The body, truncated. **Null for a tombstone**, and null for an attachment with no caption.
   *
   * Deletion nulls the column, so there is no stored text for this to resurrect even by
   * accident - which is the property that matters, since a chat list is exactly where a deleted
   * message would otherwise keep being quoted long after it vanished from the conversation.
   */
  preview: z.string().nullable(),
  /** Who said it, for the "Name: text" prefix. Null once the account is anonymised. */
  senderName: z.string().nullable(),
  senderId: Uuid,
  documentName: z.string().nullable().default(null),
  deleted: z.boolean(),
  createdAt: z.string(),
});
export type ConversationLastMessage = z.infer<typeof ConversationLastMessage>;

/**
 * One row of the unified chat list.
 *
 * `scope` is the full `ChannelScope` even though the endpoint currently returns **club and dm
 * only**. That is deliberate rather than sloppy: the narrowing is a product decision about what
 * this screen shows, not a fact about the contract, and race and Eboard rows would need no
 * change here to start appearing. Every non-dm scope navigates identically, so the client's
 * handling of the wider union costs a line.
 */
export const ConversationSummary = z.object({
  channelId: Uuid,
  scope: ChannelScope,
  /** The scope's own name - the club's, or the other participant's in a DM. */
  name: z.string(),
  /**
   * The scope's own picture, and never its parent's as a stand-in.
   *
   * Null means "no picture set", and the row draws the initial of `name`. See
   * `channelDisplayImage` on the server for why this is a CASE on the scope rather than a
   * COALESCE - a race with no picture of its own once wore its club's face.
   */
  image: z.string().nullable().default(null),
  /** Computed from the log, never stored. */
  unread: z.number().int().nonnegative(),
  /** Muted silences the push, not the count, so a muted row can still be unread. */
  muted: z.boolean(),
  /**
   * Kept at the top of this viewer's list.
   *
   * A **conversation** pin, personal and invisible to everybody else - not the message pin that
   * `canPinInChannel` gates. Pinned rows sort above every unpinned one regardless of how recent
   * either is, which is the whole reason somebody pins one.
   */
  pinned: z.boolean().default(false),
  /** The owning club, for a club row. Null in a DM, which belongs to no club. */
  clubId: Uuid.nullable().default(null),
  /**
   * Whether this viewer may leave the space behind this row, which the long-press menu asks
   * before offering "Leave club".
   *
   * False in a DM - there is nothing to leave, and leaving is not what Delete chat does. False
   * for a club's Owner, because `canLeaveClub` refuses them and `PRD/04` says the action is not
   * even rendered: an Owner leaves by transferring ownership first. Answered by the server
   * rather than inferred client-side from a role, so the menu and the endpoint cannot disagree.
   */
  canLeave: z.boolean().default(false),
  /** The other participant, for a DM row. Null in every other scope. */
  otherUserId: Uuid.nullable().default(null),
  /**
   * Whether the composer is live there.
   *
   * A DM goes read-only when blocked or when the last shared club goes, and **stays in the
   * list** either way, because both leave history readable.
   */
  canPost: z.boolean(),
  /** Null in a conversation nobody has said anything in yet. */
  lastMessage: ConversationLastMessage.nullable(),
});
export type ConversationSummary = z.infer<typeof ConversationSummary>;

/** Cut a body down to what a conversation row can show. One definition, both sides of the wire. */
export function conversationPreview(body: string | null): string | null {
  if (body === null || body.length === 0) return null;
  return body.length <= CONVERSATION_PREVIEW_CHARS
    ? body
    : body.slice(0, CONVERSATION_PREVIEW_CHARS);
}

/**
 * What a conversation row says under the name.
 *
 * Defined here rather than in the screen so that the one place a message becomes a sentence is
 * shared, and so it can be tested without rendering anything. Returns the text only - the
 * sender prefix is the caller's, because a DM and a club row space it differently.
 */
export function conversationSummaryText(last: ConversationLastMessage | null): string {
  if (last === null) return 'No messages yet';
  if (last.deleted) return 'Message deleted';

  switch (last.type) {
    case 'photo':
      // A caption when there is one, because the words are more use than the medium.
      return last.preview ?? 'Photo';
    case 'document':
      return last.documentName ?? 'Document';
    case 'poll':
      return last.preview ?? 'Poll';
    case 'event':
      return last.preview ?? 'Event';
    case 'meeting':
      return last.preview ?? 'Meeting';
    default:
      // text, announcement and system all carry their words in the body.
      return last.preview ?? '';
  }
}

/**
 * Unread count for a channel.
 *
 * Computed, never stored. `lastSeq - lastReadSeq` is O(1) and cannot drift; a
 * stored count can. See SPEC/PRD/16-cross-cutting-ux.md.
 */
export function unreadCount(state: {
  lastSeq: number;
  lastReadSeq: number;
}): number {
  return Math.max(0, state.lastSeq - state.lastReadSeq);
}
