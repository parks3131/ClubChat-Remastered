import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { Redirect, useLocalSearchParams, useRouter } from "expo-router";
import { useDeclareSpace } from "../../src/current-space.tsx";
import {
  quoteOf,
  reactionEmoji,
  reactionSummary,
  SYSTEM_ACTOR_ID,
  type MessageEnvelope,
  type MessageReplyRef,
  type ReactionEmoji,
} from "@clubchat/shared";
import { useSession } from "../../src/chat-provider.tsx";
import {
  buildChatRows,
  decideLastReadAnchor,
  LAST_READ_ROW,
  type Row,
} from "../../src/chat-rows.ts";
import { formatDaySeparator } from "../../src/dates.ts";
import { channelApi, dmApi, type ChannelMeta } from "../../src/api.ts";
import { DocumentBubble, PhotoBubble, RemoteImage } from "../../src/media-bubble.tsx";
import { PhotoViewer } from "../../src/photo-viewer.tsx";
import {
  pickDocument,
  pickPhoto,
  takePhoto,
  uploadAttachment,
  UploadError,
  type PickedAttachment,
  type UploadKind,
} from "../../src/upload.ts";
import { LinearGradient } from "expo-linear-gradient";
import * as Clipboard from "expo-clipboard";
import * as Haptics from "expo-haptics";
import { BlurView } from "expo-blur";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  activeMentionQuery,
  applyMention,
  matchMentionables,
  mentionIdsInBody,
  splitMentions,
  type Mentionable,
  type MentionPick,
} from "../../src/mentions.ts";
import { MaterialIcons } from "@expo/vector-icons";
import { Avatar } from "../../src/ui.tsx";
import { ChatEventCard } from "../../src/screens/events.tsx";
import { ChatMeetingCard } from "../../src/screens/meetings.tsx";
import { ChatPollCard } from "../../src/screens/polls.tsx";
import { QuickNav, spaceProfileHref, useGoBack } from "../../src/nav.tsx";
import { color, fontFamily, radius, space, type } from "../../src/theme.ts";

/**
 * How many pinned notices hang above the conversation.
 *
 * A window on the most recent, not the whole pin list - everything pinned stays in Highlights.
 * Four fits the strip without it becoming a second scrolling list on top of the first.
 */
const PINNED_STRIP_LIMIT = 4;

/**
 * How far from the live tail the pinned strip stays visible, in points.
 *
 * Generous enough that a small nudge up does not flicker it away, short enough that reading back
 * through history clears it. Measured from the bottom, so it is a distance rather than a
 * direction and does not need to track which way the finger moved.
 */
const PINNED_STRIP_FADE_AFTER = 400;

/**
 * How long a jumped-to message stays highlighted.
 *
 * Long enough to find it after the list settles, short enough that it does not linger as though
 * the message were permanently marked. Clearing the highlight is also what stops the jump from
 * re-firing on every later change to the list.
 */
const JUMP_HIGHLIGHT_MS = 2200;

/*
 * `Row`, the markers and the arithmetic that places them live in `src/chat-rows.ts`, where they
 * can be tested. They were here, and both of their bugs shipped: this file is 3,400 lines and a
 * memo inside it has no way to be exercised except by opening a chat on a phone and looking.
 */

/**
 * Whether a card bubble can be held to open the message menu.
 *
 * > **One fact, asked in two places**, and they must never disagree: the bubble attaches the
 * > gesture, and the card draws a visible dots control only where the gesture is missing. Written
 * > as two separate platform checks these would eventually drift into a card that can be held AND
 * > carries a redundant button, or one with neither.
 *
 * A card holds its own controls - vote, see voters, View Event - so long-pressing it wraps a
 * pressable in a pressable, and the platforms resolve that differently. Native negotiates: the
 * responder system gives the touch to the deepest view that wants it, so a finger on a poll option
 * votes and never reaches the bubble, while a finger on the card's body does. Web bubbles events
 * upward regardless, so holding a vote button there would vote AND open the menu.
 *
 * So the phone gets the same gesture every other bubble has, and web keeps the dots as its way in.
 * Verified on both: long press confirmed working on a physical iPhone on 2026-08-01.
 */
const CARDS_ARE_LONG_PRESSABLE = Platform.OS !== 'web';

/**
 * How far from the bottom still counts as being AT the bottom, in pixels.
 *
 * Not zero. A list settles a pixel or two short of its own end after a layout pass - measured at
 * 16px here on a freshly opened chat - and a strict comparison would decide the reader had walked
 * away from the tail when they had not moved at all. A row is taller than this, so it cannot
 * swallow a whole message the reader has scrolled past.
 */
const TAIL_SLACK = 48;

/** What the disabled composer says, per reason. */
const DENIED_TEXT: Record<
  NonNullable<ChannelMeta["postDeniedReason"]>,
  string
> = {
  // Reports the viewer's own action back to them, and offers the way out.
  you_blocked_them: "You blocked this person. Unblock them to send messages.",
  /*
   * Deliberately does not say which of "they blocked you" and "you no longer share a club"
   * happened. PRD/14 requires the composer to state a reason while keeping a block quiet to
   * the blocked party, and both hold only if the reason does not identify the cause.
   */
  unavailable: "You can no longer send messages in this conversation.",
};

/**
 * The header quick-nav entries for a group scope.
 *
 * `PRD/15` gives club chat "Members · Poll · Routines · Events" and race chat "Members · Meet
 * Information · Polls · Car Assignments and Groups", and Eboard chat "Members · Meetings · Polls".
 * Built from the channel's scope rather than forked per scope: one list function, three answers.
 *
 * Every target is addressed by the SCOPE id, which is why the channel meta carries it.
 */
function scopeLinks(
  scope: "club" | "race" | "eboard",
  meta: { scopeId: string; clubId: string | null },
): Array<{ href: string; label: string; icon: MaterialIconName }> {
  if (scope === "club") {
    return [
      { href: `/clubs/${meta.scopeId}/members`, label: "Members", icon: "group" },
      { href: `/clubs/${meta.scopeId}/polls`, label: "Poll", icon: "how-to-vote" },
      { href: `/clubs/${meta.scopeId}/routines`, label: "Routines", icon: "fitness-center" },
      { href: `/clubs/${meta.scopeId}/events`, label: "Events", icon: "event" },
    ];
  }
  if (scope === "race") {
    return [
      { href: `/races/${meta.scopeId}/roster`, label: "Members", icon: "group" },
      { href: `/races/${meta.scopeId}/meet`, label: "Meet Information", icon: "info" },
      { href: `/races/${meta.scopeId}/polls`, label: "Polls", icon: "how-to-vote" },
      {
        href: `/races/${meta.scopeId}/car-groups`,
        label: "Car Assignments & Groups",
        icon: "directions-car",
      },
    ];
  }
  return [
    { href: `/eboard/${meta.scopeId}/members`, label: "Members", icon: "group" },
    { href: `/eboard/${meta.scopeId}/meetings`, label: "Meetings", icon: "groups" },
    { href: `/eboard/${meta.scopeId}/polls`, label: "Polls", icon: "how-to-vote" },
  ];
}

type MaterialIconName = React.ComponentProps<typeof MaterialIcons>["name"];

/**
 * The create actions the "+" menu offers, by scope.
 *
 * **This answers what the SCOPE has, never who the caller is** - the role half is one
 * `canAnnounce` check at the call site. Keeping them apart is the point: an Event belongs to a
 * club and there is no race or Eboard calendar to put one on, and a Meeting is an Eboard concept
 * with no club-wide or race equivalent. Neither absence is a permission, and writing them as one
 * combined condition is how "this scope has no Events" turns into "you are not allowed to make
 * one" in somebody's head six months from now.
 *
 * A DM gets nothing: no polls, no events, no meetings, and `canAnnounce` is false there anyway.
 */
function createActions(meta: ChannelMeta): Array<{
  label: string;
  href: string;
  icon: MaterialIconName;
  tint: string;
}> {
  /*
   * Where the composer should land when it is done, encoded into the link that opened it.
   *
   * **Creating from the "+" menu is a chat gesture, so it has to end in chat.** The creation
   * already posts its own card into this conversation, so leaving the member on the polls list
   * strands them one back-tap away from the thing they just made, looking at a screen they never
   * asked for. v1 solved it the same way and for the same reason.
   *
   * The channel id travels rather than being re-derived, because a scope has more than one
   * channel and "the club's chat" is not a lookup this menu should be doing.
   */
  const backToChat = encodeURIComponent(`/chat/${meta.channelId}`);

  switch (meta.scope) {
    case "club":
      return [
        {
          label: "Poll",
          href: `/clubs/${meta.scopeId}/polls?create=1&from=${backToChat}`,
          icon: "how-to-vote",
          tint: color.inverseSurface,
        },
        {
          label: "Event",
          href: `/clubs/${meta.scopeId}/events?create=1&from=${backToChat}`,
          icon: "event",
          tint: color.error,
        },
      ];
    case "race":
      // No Event: a calendar event belongs to a club, and a race has no calendar of its own.
      return [
        {
          label: "Poll",
          href: `/races/${meta.scopeId}/polls?create=1&from=${backToChat}`,
          icon: "how-to-vote",
          tint: color.inverseSurface,
        },
      ];
    case "eboard":
      return [
        {
          label: "Poll",
          href: `/eboard/${meta.scopeId}/polls?create=1&from=${backToChat}`,
          icon: "how-to-vote",
          tint: color.inverseSurface,
        },
        {
          label: "Meeting",
          href: `/eboard/${meta.scopeId}/meetings?create=1&from=${backToChat}`,
          icon: "groups",
          tint: color.error,
        },
      ];
    case "dm":
      return [];
  }
}

/**
 * A message body with its mentions coloured and tappable.
 *
 * > **Nested `<Text>`, never a row of Views.** A mention sits mid-sentence and has to wrap with
 * > the words around it; laying the runs out as siblings in a flex row would break the line
 * > wherever a name appears and leave ragged gaps. Nested Text is the only thing that flows as
 * > one paragraph.
 *
 * The tap is `onPress` on the inner Text rather than a Pressable, for the same reason and for
 * failure mode 17: a Pressable inside a bubble that is itself long-pressable nests two gesture
 * targets, which is invalid on web and swallows the outer long-press on native.
 *
 * Only names the server vouched for are highlighted, because the runs come from the stored
 * mention list rather than from scanning the text for `@`. Typing an `@` in front of arbitrary
 * words colours nothing.
 */
function MentionedBody({
  body,
  mentions,
  mine,
  onOpenProfile,
}: {
  body: string;
  mentions: MessageEnvelope["mentions"];
  mine: boolean;
  onOpenProfile: (userId: string) => void;
}) {
  const runs = splitMentions(body, mentions);
  // The overwhelming majority of messages name nobody, and pay one check for it.
  if (runs.length === 1 && runs[0]!.userId === null) return <>{body}</>;

  return (
    <>
      {runs.map((run, index) =>
        run.userId === null ? (
          <Text key={index}>{run.text}</Text>
        ) : (
          <Text
            key={index}
            style={mine ? styles.mentionInMine : styles.mentionInTheirs}
            onPress={() => onOpenProfile(run.userId as string)}
            accessibilityRole="link"
            accessibilityLabel={`Open ${run.text.slice(1)}'s profile`}
          >
            {run.text}
          </Text>
        ),
      )}
    </>
  );
}

/**
 * The long-press overlay: reactions above, the message itself, actions below.
 *
 * v1's own menu is GroupMe's, and the shape is doing real work rather than decoration. The
 * backdrop blurs the conversation so the pressed message is unambiguous - in a dense chat, a
 * bottom sheet leaves you guessing which bubble you actually caught. The message is redrawn here
 * rather than the real row being lifted, because the real row is inside a FlatList cell that
 * clips and scrolls.
 *
 * The whole backdrop dismisses. A destructive item is last and red, and the two destructive ones
 * hand off to a confirmation rather than acting.
 */
function MessageActions({
  message,
  mine,
  canPin,
  canReport,
  canDelete,
  onDismiss,
  onReact,
  onReply,
  onCopy,
  onPin,
  onReport,
  onDelete,
}: {
  message: MessageEnvelope;
  mine: boolean;
  canPin: boolean;
  /** Whether this conversation has reporting at all. False for the whole Eboard scope. */
  canReport: boolean;
  canDelete: boolean;
  onDismiss: () => void;
  onReact: (emoji: ReactionEmoji) => void;
  onReply: () => void;
  onCopy: () => void;
  onPin: () => void;
  onReport: () => void;
  onDelete: () => void;
}) {
  const hasText = message.body !== null && message.body.length > 0;

  const items: Array<{
    label: string;
    icon: React.ComponentProps<typeof MaterialIcons>["name"];
    onPress: () => void;
    destructive?: boolean;
  }> = [
    { label: "Reply", icon: "reply", onPress: onReply },
    // Copy is offered only when there is text to copy - a photo has nothing to put on the
    // clipboard, and an item that silently does nothing is worse than an absent one.
    ...(hasText ? [{ label: "Copy", icon: "content-copy" as const, onPress: onCopy }] : []),
    ...(canPin
      ? [
          {
            label: message.pinned ? "Unpin" : "Pin",
            icon: "push-pin" as const,
            onPress: onPin,
          },
        ]
      : []),
    /*
      Nobody reports their own message, and Eboard chat has no reporting at all - everyone in
      that space is admin-tier, so a report would be raised by the same people who would review
      it. They delete directly instead. `canReport` is the server's answer rather than a scope
      check written out here.
    */
    ...(mine || !canReport
      ? []
      : [
          {
            label: "Report a concern",
            icon: "shield" as const,
            onPress: onReport,
            destructive: true,
          },
        ]),
    ...(canDelete
      ? [{ label: "Delete", icon: "delete" as const, onPress: onDelete, destructive: true }]
      : []),
  ];

  return (
    <View style={styles.overlay}>
      {/*
        The scrim is its own pressable filling the screen, BEHIND the content rather than
        wrapping it - a Pressable wrapping the menu would put every item inside another press
        target, which is failure mode 17.
      */}
      <Pressable
        style={StyleSheet.absoluteFill}
        onPress={onDismiss}
        accessibilityRole="button"
        accessibilityLabel="Close message actions"
      />
      <BlurView intensity={24} tint="light" style={StyleSheet.absoluteFill} pointerEvents="none" />

      <View style={styles.overlayContent} pointerEvents="box-none">
        <View style={styles.overlayEmojiBar}>
          {reactionEmoji.map((emoji) => (
            <Pressable
              key={emoji}
              style={styles.overlayEmojiButton}
              onPress={() => onReact(emoji)}
              accessibilityRole="button"
              accessibilityLabel={`React with ${emoji}`}
            >
              <Text style={styles.emojiGlyph}>{emoji}</Text>
            </Pressable>
          ))}
        </View>

        {/* The pressed message, redrawn plainly so it is unmistakable which one this is about. */}
        <View style={[styles.overlayBubble, mine && styles.overlayBubbleMine]}>
          <Text style={styles.overlayBubbleSender}>
            {message.senderName ?? "Deleted member"}
          </Text>
          <Text style={styles.overlayBubbleBody} numberOfLines={6}>
            {hasText ? message.body : pinnedPreview(message)}
          </Text>
        </View>

        <View style={styles.overlayMenu}>
          {items.map((item, index) => (
            <Pressable
              key={item.label}
              style={[styles.overlayMenuItem, index > 0 && styles.overlayMenuItemDivided]}
              onPress={item.onPress}
              accessibilityRole="button"
              accessibilityLabel={item.label}
            >
              <Text
                style={[
                  styles.overlayMenuLabel,
                  item.destructive === true && styles.destructive,
                ]}
              >
                {item.label}
              </Text>
              <MaterialIcons
                name={item.icon}
                size={20}
                color={item.destructive === true ? color.error : color.textPrimary}
              />
            </Pressable>
          ))}
        </View>
      </View>
    </View>
  );
}

/**
 * One line describing a pinned message, for the notice strip.
 *
 * A pinned photo or document has no body to show, and an empty notice is worse than none: the
 * strip's whole job is to say what is being kept in view.
 */
function pinnedPreview(message: MessageEnvelope): string {
  if (message.deletedAt !== null) return "This message was deleted";
  if (message.type === "photo") return "Photo";
  if (message.type === "document") return message.documentName ?? "Document";
  return message.body ?? "";
}

/**
 * What a quote box says when the quoted message has no words of its own.
 *
 * A photo sent without a caption has nothing to print, and an empty quote box is worse than a
 * labelled one: the whole job of the box is to say what is being answered.
 */
function quoteLabel(quote: MessageReplyRef): string {
  if (quote.deleted) return "This message was deleted";
  if (quote.preview !== null) return quote.preview;
  if (quote.type === "photo") return "Photo";
  if (quote.type === "document") return quote.documentName ?? "Document";
  return "Message";
}

/**
 * The quote box: what this message is answering, drawn inside its bubble.
 *
 * > **Tapped through `Text.onPress`, never a nested `Pressable`.** This sits inside the bubble's
 * > own long-press target, and a Pressable within one is failure mode 17 - invalid on web, and on
 * > native the inner gesture eats the outer. `MentionedBody` solves the identical problem the
 * > identical way, which is the precedent this follows rather than inventing a second answer.
 *
 * A deleted original keeps its box and says so. Letting the quote vanish would leave a reply
 * answering nothing, which is the unreadability the tombstone exists to prevent, one level up.
 */
function QuotedMessage({
  quote,
  mine,
  onJump,
}: {
  quote: MessageReplyRef;
  mine: boolean;
  onJump: (seq: number) => void;
}) {
  const label = quoteLabel(quote);
  const jump = () => onJump(quote.seq);

  return (
    <View style={[styles.quote, mine ? styles.quoteMine : styles.quoteTheirs]}>
      {/* The accent rule down the left edge, which is what makes this read as quoted rather
          than as a first line of the message. */}
      <View style={[styles.quoteBar, mine && styles.quoteBarMine]} />
      {/*
        A thumbnail rather than the word "Photo", when there is one to show. `thumb` is the small
        derivative, so a quote costs a thumbnail rather than a full-size image - and a photo whose
        access has since been withdrawn degrades to the label inside `RemoteImage` itself.
      */}
      {quote.mediaId !== null && !quote.deleted && quote.type === "photo" && (
        <RemoteImage
          mediaId={quote.mediaId}
          variant="thumb"
          style={styles.quoteThumb}
          accessibilityLabel="Photo being replied to"
        />
      )}
      {quote.type === "document" && !quote.deleted && (
        <View style={styles.quoteDocIcon}>
          <MaterialIcons
            name="insert-drive-file"
            size={16}
            color={mine ? color.onAccent : color.secondary}
          />
        </View>
      )}
      <View style={styles.quoteColumn}>
        <Text
          style={[styles.quoteSender, mine && styles.quoteSenderMine]}
          numberOfLines={1}
          onPress={jump}
          accessibilityRole="link"
          accessibilityLabel={`Replying to ${quote.senderName ?? "a deleted member"}. Go to that message`}
        >
          {quote.senderName ?? "Deleted member"}
        </Text>
        <Text
          style={[
            styles.quotePreview,
            mine && styles.quotePreviewMine,
            quote.deleted && styles.quoteDeleted,
          ]}
          numberOfLines={2}
          onPress={jump}
          accessibilityRole="link"
          accessibilityLabel={`${label}. Go to that message`}
        >
          {label}
        </Text>
      </View>
    </View>
  );
}

/**
 * The bubble shell.
 *
 * > **Ported verbatim from v1's `ChatScreen`**, including the reason it is its own component: the
 * > sent bubble is an Energetic Orange to rust diagonal gradient from the Stitch export, and every
 * > other bubble is a plain tinted View. Isolating it means `renderItem` never switches element
 * > types between a `View` and a `LinearGradient` mid-list, which is the kind of change that makes
 * > a virtualised list drop its recycling.
 *
 * The asymmetric corners are v1's too: each bubble has one small corner where its tail would be.
 */
function BubbleContainer({
  mine,
  pending,
  children,
}: {
  mine: boolean;
  pending?: boolean;
  children: React.ReactNode;
}) {
  if (mine) {
    return (
      <LinearGradient
        colors={[color.accent, color.accentPressed]}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        style={[styles.bubble, styles.sent, pending === true && styles.pending]}
      >
        {children}
      </LinearGradient>
    );
  }
  return <View style={[styles.bubble, styles.received]}>{children}</View>;
}

/**
 * An optimistic row from the send outbox, before its ack.
 *
 * Memoized beside `MessageRow` and for the same reason. There are rarely more than one or two
 * of these, but they sit at the tail - the part of the list that is always mounted - so an
 * unmemoized copy re-renders on every scroll frame the list decides to re-render on.
 */
const PendingRow = memo(function PendingRow({
  row,
  onRetry,
  onJumpToQuote,
}: {
  row: Extract<Row, { kind: "pending" }>;
  onRetry: (clientMsgId: string) => void;
  onJumpToQuote: (seq: number) => void;
}) {
  return (
    <View style={[styles.messageRow, styles.messageRowMine]}>
      {/*
        A spacer the exact width of an avatar, not an avatar. The client knows its own
        user id but not its own name, so there is no initial to draw; leaving the slot
        empty instead would let the bubble jump 40px left the moment the ack arrives
        and the real avatar takes the space.
      */}
      <View style={styles.avatarSpacer} />
      <View style={styles.bubbleWrapMine}>
        <BubbleContainer mine pending>
          {/* The quote is drawn before the ack, from the outbox entry's own copy of it, so a
              reply does not visibly gain its quote a moment after being sent. */}
          {row.replyTo !== undefined && (
            <QuotedMessage quote={row.replyTo} mine onJump={onJumpToQuote} />
          )}
          {row.type === "photo" && (
            <PhotoBubble mediaId={null} localUri={row.localUri} mine />
          )}
          {row.type === "document" && (
            <DocumentBubble
              name={row.documentName ?? null}
              size={row.documentSize ?? null}
              mine
            />
          )}
          {row.body.length > 0 && <Text style={styles.sentText}>{row.body}</Text>}
          {row.failed ? (
            <Pressable
              onPress={() => onRetry(row.clientMsgId)}
              accessibilityRole="button"
              accessibilityLabel="Retry sending this message"
            >
              <Text style={styles.failed}>Failed. Tap to retry</Text>
            </Pressable>
          ) : (
            <Text style={styles.pendingLabel}>Sending</Text>
          )}
        </BubbleContainer>
      </View>
    </View>
  );
});

/**
 * One message in the conversation.
 *
 * > **Memoized, and that is a bug fix rather than a tuning knob.**
 * >
 * > This was an inline closure inside `renderItem`, so every row's entire subtree - the
 * > gradient, the mention splitting, two `toLocaleTimeString` calls, the reaction summary - was
 * > rebuilt whenever the SCREEN re-rendered, for reasons no row cared about: a notice appearing,
 * > the pinned strip fading, a long press selecting some other message. On a device the log
 * > reported `VirtualizedList: Encountered an error while measuring a window update` with the JS
 * > thread blocked for nearly four seconds between scroll events, which also cost the app its
 * > Metro connection.
 *
 * The memo only pays off if every prop is stable, which is why the callbacks below are `seq`-in,
 * nothing-out and are `useCallback`ed at the call site. Passing `message` itself is safe: `rows`
 * is rebuilt only when the store changes, so during a scroll every row's props are identical to
 * the previous render and React skips the whole subtree.
 */
const MessageRow = memo(function MessageRow({
  message,
  userId,
  mine,
  isJumpTarget,
  onSelect,
  onReact,
  onOpenProfile,
  onJumpToQuote,
  onOpenPhoto,
}: {
  message: MessageEnvelope;
  /** The viewer, for marking their own reactions. Null only before auth resolves. */
  userId: string | null;
  mine: boolean;
  isJumpTarget: boolean;
  /** Open the long-press menu for this message. The card's own dots call it too. */
  onSelect: (seq: number) => void;
  onReact: (seq: number, emoji: ReactionEmoji) => void;
  onOpenProfile: (userId: string) => void;
  onJumpToQuote: (seq: number) => void;
  /** Open the full-screen viewer. Only ever reached from a photo message. */
  onOpenPhoto: (message: MessageEnvelope) => void;
}) {
  // A system message is centred and unattributed, not a bubble.
  if (message.senderId === SYSTEM_ACTOR_ID) {
    return (
      <View style={styles.systemRow}>
        <Text style={styles.systemText}>{message.body}</Text>
      </View>
    );
  }

  /*
   * A card bubble, of any of the three kinds.
   *
   * Poll, event and meeting cards differ in everything except this: each holds its own
   * press targets, so the bubble around them must hold none. Asking `linkedPollId !==
   * null` in the places that decide it is how the event card shipped without the
   * long-press suppression the poll card has - failure mode 17 all over again.
   */
  const cardId =
    message.linkedPollId ?? message.linkedEventId ?? message.linkedMeetingId;

  if (message.deletedAt !== null) {
    /*
     * A deleted CARD leaves nothing at all; a deleted MESSAGE leaves a tombstone.
     *
     * The tombstone exists for one reason - a message vanishing mid-conversation makes
     * the replies around it unreadable (domain invariant 7). A card has no replies: it
     * is a thing the server posted about an object, and when the object goes there is
     * no conversation left with a hole in it.
     *
     * It would also read as a contradiction. Cancelling a meeting posts "X cancelled
     * <title>" in the card's place, and a tombstone directly above that line says the
     * same event twice while claiming somebody deleted a message.
     */
    if (cardId !== null) return null;
    return (
      <View style={styles.systemRow}>
        <Text style={styles.tombstone}>This message was deleted</Text>
      </View>
    );
  }

  /*
   * An announcement, which is v1's card rather than a bubble.
   *
   * > **This branch did not exist, and its absence made the whole feature look broken.**
   * > Arming the megaphone worked, the send carried `type: 'announcement'`, the row
   * > stored as one and the Highlights tab listed it - and in the conversation it drew
   * > as an ordinary message, identical to the one before it. An announcement notifies
   * > everybody in the channel, so a reader who cannot tell one from ordinary chatter is
   * > the entire point of the feature going missing.
   *
   * Full width rather than a sided bubble, because it is addressed to the room rather
   * than said to it - so it is not `mine`-aware and carries no avatar.
   */
  if (message.type === "announcement") {
    return (
      <View style={[styles.announcementWrap, isJumpTarget && styles.jumpTarget]}>
        <View style={styles.announcementCard}>
          {/* Oversized, clipped and nearly transparent: texture, not a label. */}
          <Text style={styles.announcementWatermark}>INFO</Text>
          <View style={styles.announcementHeadlineRow}>
            <View style={styles.announcementAccentBar} />
            <Text style={styles.announcementHeadline}>{message.body}</Text>
          </View>
          {/* A hyphen, not v1's em dash: standing instruction 1 covers UI text too. */}
          <Text style={styles.announcementSender}>
            {"- "}
            {message.senderName ?? "Deleted member"}
          </Text>
          <Text style={styles.announcementTime}>
            {new Date(message.createdAt).toLocaleTimeString([], {
              hour: "2-digit",
              minute: "2-digit",
            })}
          </Text>
        </View>
      </View>
    );
  }

  const summary = reactionSummary(message.reactions, userId);

  return (
    <View
      style={[
        styles.messageRow,
        mine && styles.messageRowMine,
        isJumpTarget && styles.jumpTarget,
      ]}
    >
      {/*
        v1's arrangement: the avatar sits beside the bubble on BOTH sides, and the row
        right-aligns for your own messages rather than mirroring - so the avatar stays
        on the left of the bubble either way. Tappable, because a name in a busy channel
        is only useful if you can get from it to the person.
      */}
      <Pressable
        onPress={() => onOpenProfile(message.senderId)}
        accessibilityRole="button"
        accessibilityLabel={`Open ${message.senderName ?? "this member"}'s profile`}
        hitSlop={space.xs}
      >
        <Avatar
          name={message.senderName ?? "?"}
          image={message.senderImage}
          size={32}
        />
      </Pressable>
      <Pressable
        // Long press, not a visible button: reporting is rare and a tap target on
        // every bubble would be noise. Own messages are excluded because nobody can
        // report themselves.
        //
        // A card bubble is long-pressable on native and deliberately not on web - the
        // honest reading of failure mode 17 rather than a workaround. See
        // `CARDS_ARE_LONG_PRESSABLE` for why the two platforms differ, and note that the
        // dots below key off the same constant so the two can never disagree.
        onLongPress={
          cardId !== null && !CARDS_ARE_LONG_PRESSABLE
            ? undefined
            : () => {
                /*
                 * A tap you can feel, before anything appears on screen.
                 *
                 * A long press has no visual progress, so without haptics the only way
                 * to learn it worked is the menu arriving - and the only way to learn
                 * you have not held long enough is nothing happening. The buzz is the
                 * acknowledgement.
                 *
                 * Fire-and-forget: on a device with the setting off, or on web where
                 * there is no Taptic Engine, this rejects and the menu still opens.
                 */
                void Haptics.impactAsync(
                  Haptics.ImpactFeedbackStyle.Medium,
                ).catch(() => undefined);
                onSelect(message.seq);
              }
        }
        /*
          A tap opens the photo, and ONLY on a photo message.

          It belongs to this Pressable rather than to the bubble inside it, which is what
          `media-bubble.tsx` has said since it was written: a second Pressable nested in this one
          is a <button> inside a <button> on web and swallows this long press on native. So the
          gesture that already owns the bubble grows a tap, and a message with no photo keeps
          having none rather than becoming a control that does nothing.
        */
        onPress={
          message.type === "photo" && message.mediaId !== null
            ? () => onOpenPhoto(message)
            : undefined
        }
        delayLongPress={400}
        // `none` for a card, and that is what keeps the nesting legal: react-native-web
        // renders a Pressable as a real <button> ONLY when its role says so, and a plain
        // <div> wrapper can hold the card's controls legally. `disabled` was the first
        // attempt and was worse than the bug - a disabled button disables its descendants,
        // so every option inside went dead and the card could not be voted on at all.
        accessibilityRole={cardId !== null ? "none" : "button"}
        accessibilityLabel={
          mine
            ? "Press and hold to react to your message"
            : "Press and hold to react to or report this message"
        }
        // The gesture stays on the OUTERMOST element and the gradient sits inside it,
        // so the bubble's fill can be a LinearGradient without the pressable becoming
        // one - and without nesting a second pressable (failure mode 16).
        style={mine ? styles.bubbleWrapMine : styles.bubbleWrapTheirs}
      >
        <BubbleContainer mine={mine}>
          {/*
            v1's bubble header: the name on BOTH sides, dimmed on your own, with the
            pin marker beside it. Attribution on your own messages is not redundant
            here - the avatar sits on the left of every bubble, so a nameless own
            bubble would be the only unlabelled thing on screen.

            Null when the message was cached before this column existed. It renders
            unattributed rather than blank-labelled, and the next sync fills it in.
          */}
          {(message.senderName !== null || message.pinned) && (
            <View style={styles.bubbleHeader}>
              {message.senderName !== null && (
                <Text style={mine ? styles.senderNameMine : styles.senderName}>
                  {message.senderName}
                </Text>
              )}
              {message.pinned && (
                <MaterialIcons
                  name="push-pin"
                  size={12}
                  color={mine ? color.onAccent : color.accent}
                />
              )}
            </View>
          )}
          {/*
            The quote sits above everything the message itself carries - its photo, its text, its
            card - because that is the reading order: what is being answered, then the answer.
          */}
          {message.replyTo !== null && (
            <QuotedMessage
              quote={message.replyTo}
              mine={mine}
              onJump={onJumpToQuote}
            />
          )}
          {message.type === "photo" && message.mediaId !== null && (
            <PhotoBubble mediaId={message.mediaId} mine={mine} />
          )}
          {message.type === "document" && (
            <DocumentBubble
              name={message.documentName}
              size={message.documentSize}
              mine={mine}
            />
          )}
          {/*
            A poll card, drawn inside the bubble of the person who made it - which is
            what it is. v1 does the same, on an explicit founder request that the
            bubble look and behave like the full poll rather than a link out of the
            conversation, so it votes, closes and deletes in place.

            The body sentence is suppressed alongside it: the card already says who
            asked what, and repeating it above is the same line twice.
          */}
          {cardId !== null ? (
            <>
              {message.linkedPollId !== null ? (
                <ChatPollCard
                  pollId={message.linkedPollId}
                  authorName={message.senderName}
                />
              ) : message.linkedEventId !== null ? (
                /*
                  An event card, drawn in its creator's bubble exactly as a poll is -
                  v1's card, with the calendar glyph, the date, the location and View
                  Event out to the event's own screen.

                  It carries no controls of its own, so unlike the poll card it is a
                  single press target: the whole card navigates. That is legal inside
                  this bubble only because the bubble declares `accessibilityRole="none"`
                  above, which is what stops react-native-web rendering it as a <button>.
                */
                <ChatEventCard eventId={message.linkedEventId} />
              ) : (
                /* A meeting card. The event card's twin, and navigates the same way. */
                <ChatMeetingCard meetingId={cardId} />
              )}
              {/*
                The dots, ONLY where the long press is not available - which today means
                web alone.

                > **They were on every card and are now on almost none**, at the founder's
                > request once holding a card was confirmed working on the phone: a visible
                > control doing what the gesture already does is clutter on the one surface
                > that is actually the product, and it sits in the corner of a card whose
                > own controls are what the card is for.

                Web keeps them because it has nothing else: the gesture is deliberately not
                attached there, and without these a card would be the one message in the log
                nobody could react to, report or reply to.
              */}
              {!CARDS_ARE_LONG_PRESSABLE && (
                <Pressable
                  style={styles.cardMenu}
                  onPress={() => onSelect(message.seq)}
                  hitSlop={space.sm}
                  accessibilityRole="button"
                  accessibilityLabel={
                    mine ? "React to your card" : "React to or report this card"
                  }
                >
                  <MaterialIcons
                    name="more-vert"
                    size={18}
                    color={mine ? color.onAccent : color.textSecondary}
                  />
                </Pressable>
              )}
            </>
          ) : (
            /* A photo may carry a caption, and usually does not. */
            message.body !== null &&
            message.body.length > 0 && (
              <Text style={mine ? styles.sentText : styles.receivedText}>
                <MentionedBody
                  body={message.body}
                  mentions={message.mentions}
                  mine={mine}
                  onOpenProfile={onOpenProfile}
                />
              </Text>
            )
          )}
          <Text style={mine ? styles.sentMeta : styles.receivedMeta}>
            {new Date(message.createdAt).toLocaleTimeString([], {
              hour: "2-digit",
              minute: "2-digit",
            })}
          </Text>
        </BubbleContainer>
      </Pressable>

      {/*
        The reaction row.

        > **Inside the bubble's own column, not a sibling of it.** The message row is a
        > horizontal flex - avatar, then bubble - so a pill row added there became a
        > THIRD column and sat beside the bubble rather than beneath it. Reactions belong
        > to a message and have to read that way.

        Only emoji anyone actually used, in the fixed order from the shared constant so
        the row does not reshuffle as counts change.
      */}
      {summary.length > 0 && (
        <View
          style={[styles.pillRow, mine ? styles.pillRowMine : styles.pillRowTheirs]}
        >
          {summary.map((entry) => (
            <Pressable
              key={entry.emoji}
              style={[styles.pill, entry.mine && styles.pillMine]}
              onPress={() => onReact(message.seq, entry.emoji)}
              accessibilityRole="button"
              accessibilityLabel={
                entry.mine
                  ? `Remove your ${entry.emoji} reaction, ${entry.count} total`
                  : `React with ${entry.emoji}, ${entry.count} total`
              }
            >
              <Text style={styles.pillEmoji}>{entry.emoji}</Text>
              <Text
                style={[styles.pillCount, entry.mine && styles.pillCountMine]}
              >
                {entry.count}
              </Text>
            </Pressable>
          ))}
        </View>
      )}
    </View>
  );
});

export default function ChatScreen() {
  const { channelId, around } = useLocalSearchParams<{
    channelId: string;
    around?: string;
  }>();
  const { authState, client, userId, revision, offline } = useSession();
  const router = useRouter();
  // The status bar's height, for the header below. Zero on web, ~59pt on a Dynamic Island phone.
  const insets = useSafeAreaInsets();
  const [rows, setRows] = useState<Row[]>([]);
  const [draft, setDraft] = useState("");
  /*
   * The `@` mention state.
   *
   * `caret` is where the cursor is, which decides whether a mention is being typed at all.
   * `mentionPicks` remembers who was chosen - the body alone cannot say, since two members can
   * share a name - and is filtered against the final text on send, so a name deleted before
   * sending takes its mention with it.
   */
  const [caret, setCaret] = useState(0);
  const [mentionable, setMentionable] = useState<Mentionable[]>([]);
  const [mentionPicks, setMentionPicks] = useState<MentionPick[]>([]);
  const [loading, setLoading] = useState(true);
  const [meta, setMeta] = useState<ChannelMeta | null>(null);
  /** Whether the meta read has finished, successfully or not. See `loadMeta`. */
  const [metaResolved, setMetaResolved] = useState(false);
  /*
   * Chat counts as inside the club, which is what keeps the Clubs tab's shortcut working from a
   * race or Eboard conversation - and inside its own SPACE, so backing out of a race chat leaves
   * the race's name in the header rather than its club's.
   *
   * A DM declares nothing: it belongs to no club and has no space of its own. `scope` is narrowed
   * to the three that do rather than cast, so a fifth scope is a type error here instead of a
   * header quietly labelled 'dm'.
   */
  const spaceScope =
    meta === null || meta.scope === "dm" ? undefined : meta.scope;
  useDeclareSpace({
    kind: spaceScope ?? "club",
    id: spaceScope === undefined ? undefined : meta?.scopeId,
    clubId: meta?.clubId,
    name: meta?.name,
    image: meta?.image,
  });
  const [menuOpen, setMenuOpen] = useState(false);
  /**
   * The seq a long press selected.
   *
   * One sheet for both actions on a message, which is why a long press does not report
   * directly: reacting is the common case and reporting is the rare one, and a gesture that
   * did the rare thing immediately would be a trap.
   */
  const [selected, setSelected] = useState<number | null>(null);
  /**
   * The message the composer is answering, by seq. Null when writing an ordinary message.
   *
   * A seq rather than the message itself, and resolved below exactly as `selected` is: the quote
   * shown over the composer then tracks the real message, so replying to something that is
   * deleted while you are still typing shows the tombstone rather than words that are gone.
   */
  const [replyingToSeq, setReplyingToSeq] = useState<number | null>(null);
  /** Set once Report is tapped, so the confirmation is a second deliberate step. */
  const [confirmingReport, setConfirmingReport] = useState<number | null>(null);
  /** The photo being looked at full screen, or null. The whole message - see `openPhoto`. */
  const [viewingPhoto, setViewingPhoto] = useState<MessageEnvelope | null>(null);
  /**
   * The message the "Last read" rule sits above - a DECISION, taken once, not a comparison.
   *
   * > **This is the whole fix for the bug it shipped with.** The first version kept the entry
   * > cursor and compared every message against it as the list changed, which is a different rule
   * > wearing the same clothes: the cursor is frozen at arrival, so a message sent a minute later
   * > has a higher `seq` and counts as unread against it. Open a chat you are caught up on, type
   * > anything, and the rule appeared above your own message.
   *
   * Null means "no rule this visit", and it stays null: nothing that arrives after you got here
   * was unread when you got here. `decideLastReadAnchor` is tested in `chat-rows.test.ts`.
   */
  const [lastReadAnchor, setLastReadAnchor] = useState<number | null>(null);
  /**
   * Set once Delete is tapped. Deleting is irreversible and destroys somebody's words, so it
   * gets the same second deliberate step reporting does rather than firing off a long press.
   */
  const [confirmingDelete, setConfirmingDelete] = useState<number | null>(null);
  /**
   * Whether the next send goes out as an announcement.
   *
   * A compact armed toggle beside the composer rather than a permanent banner, which is what v1
   * settled on after the banner ate the top of the conversation. It disarms on send.
   */
  const [asAnnouncement, setAsAnnouncement] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [attachOpen, setAttachOpen] = useState(false);
  /** The dropdown of this conversation's other screens. */
  const [gridOpen, setGridOpen] = useState(false);
  /**
   * The header's bottom edge, measured, so the dropdown can hang off it.
   *
   * Measured rather than computed from `insets.top` plus a constant: the header's height is the
   * sum of a safe-area inset, its own padding and the tallest thing in its row, and a constant
   * that duplicated that arithmetic would be wrong on the first device with a different notch.
   */
  const [headerBottom, setHeaderBottom] = useState(0);
  /** True while bytes are in flight, so the "+" cannot start a second upload. */
  const [uploading, setUploading] = useState(false);
  const listRef = useRef<FlatList<Row>>(null);
  /*
   * There is no "am I at the tail" flag any more, and its absence is the fix rather than a
   * simplification.
   *
   * The list used to chase the bottom with `scrollToEnd` on every content size change, which is
   * right for a new message and catastrophic for everything else that changes a row's height
   * after layout - a card resolving its fetch, a photo's bytes landing. `atTailRef` existed to
   * suppress that, and it was itself set from a `fromBottom` computed against a content height
   * that was still growing, so opening a channel switched it off and left the reader partway up
   * the history having watched the list scroll.
   *
   * An inverted list has nothing to chase: offset 0 IS the newest message, arrival needs no
   * scroll, and a message arriving while the reader is up in history extends the list away from
   * them rather than moving them. See the `FlatList` below.
   */
  /** Whether the pinned strip is showing. Fades out once the reader leaves the live tail. */
  const [pinnedStripVisible, setPinnedStripVisible] = useState(true);
  /**
   * Whether the reader is sitting at the newest message.
   *
   * State rather than a ref, unlike the flag this replaces: the "new messages" control has to
   * render off it. Set only when it actually flips, so scrolling does not re-render the log on
   * every frame.
   */
  const [atNewest, setAtNewest] = useState(true);
  /**
   * The newest seq the reader has actually been shown.
   *
   * Everything above this is what the control below counts. It advances while they are at the
   * newest message and freezes the moment they scroll back into history, which is what makes
   * "3 new messages" mean *since you started reading* rather than *since you last opened the
   * app*. Set on arrival too, so the messages that were already unread when the screen opened
   * are not counted as new - the reader is being placed at them, not told about them.
   */
  const [seenThrough, setSeenThrough] = useState(0);
  /**
   * The message a jump landed on, if any.
   *
   * Held in state rather than read from the param on every render because it does two jobs: it
   * suppresses the scroll-to-end that chat otherwise does on every content change, and it marks
   * the row so the reader can see WHICH message they were sent to. Cleared once they scroll away,
   * which is what makes it a jump rather than a mode.
   */
  const [jumpedTo, setJumpedTo] = useState<number | null>(null);
  /**
   * Pins the reader has waved away, by seq.
   *
   * Local and deliberately not persisted: dismissing is "I have read this notice", not "unpin
   * this for everybody", and it lasts as long as the screen does. Unpinning is a separate,
   * authorized action that lives in the message's own sheet.
   */
  const [dismissedPins, setDismissedPins] = useState<ReadonlySet<number>>(
    new Set(),
  );

  const refresh = useCallback(async () => {
    if (!client || !channelId) return;
    const stored = await client.store.list(channelId);
    const pending: Row[] = [...client.outbox.values()]
      .filter((entry) => entry.channelId === channelId)
      .map((entry) => ({
        kind: "pending" as const,
        clientMsgId: entry.clientMsgId,
        body: entry.body,
        failed: entry.status === "failed",
        type: entry.type ?? "text",
        localUri: entry.localUri,
        documentName: entry.documentName,
        documentSize: entry.documentSize,
        replyTo: entry.replyTo,
      }));
    setRows([
      ...stored.map((message) => ({ kind: "message" as const, message })),
      ...pending,
    ]);
    setLoading(false);
  }, [client, channelId]);

  useEffect(() => {
    void refresh();
  }, [refresh, revision]);

  /**
   * The rows as the inverted list wants them: newest first.
   *
   * Derived rather than stored, so `rows` keeps the order history actually happened in - which is
   * what the pinned strip, the jump lookup and every future paging read reason about. Memoized
   * because reversing on each render would allocate a new array per keystroke and defeat the
   * memoized rows underneath it.
   */
  const invertedRows = useMemo(
    () => buildChatRows(rows, { lastReadAnchor }),
    [rows, lastReadAnchor],
  );

  /** The newest message this screen currently holds, or 0 for an empty conversation. */
  const newestSeq = useMemo(
    () =>
      rows.reduce(
        (highest, row) => (row.kind === "message" && row.message.seq > highest ? row.message.seq : highest),
        0,
      ),
    [rows],
  );

  /**
   * The messages that have arrived since the reader last saw the newest one.
   *
   * Counted from `rows` rather than tracked with a counter, so it cannot drift: a message that
   * arrives twice, or one that was already held, changes nothing.
   */
  const newSinceSeen = useMemo(
    () =>
      rows.filter((row) => row.kind === "message" && row.message.seq > seenThrough).length,
    [rows, seenThrough],
  );

  /**
   * Take the reader to the newest message.
   *
   * In an inverted list that is offset 0, which is also where the list opens - so this is only
   * ever a correction after the reader has scrolled away, and it does nothing when they have not.
   * Animated on purpose: this is the "your thing landed, here it is" motion, and it is the one
   * place in this screen where movement is the point rather than the defect.
   */
  const scrollToNewest = useCallback(() => {
    listRef.current?.scrollToOffset({ offset: 0, animated: true });
  }, []);

  /**
   * Put a message at the top of the screen, with everything newer below it to read forward into.
   *
   * `viewPosition: 1` rather than 0, because this list is inverted: offset 0 is the visual
   * BOTTOM, so the far end of the viewport - position 1 - is the top. Getting that backwards
   * lands the target on the last line of the screen with the thing you were sent to read
   * already scrolled past.
   *
   * Never animated. Both callers are placements rather than journeys - "start here" - and an
   * animated one is the travelling-down motion this whole change exists to remove.
   */
  const placeAtTop = useCallback(
    (row: Row | undefined) => {
      if (!row) return;
      const index = invertedRows.indexOf(row);
      if (index < 0) return;
      listRef.current?.scrollToIndex({ index, viewPosition: 1, animated: false });
    },
    [invertedRows],
  );

  /*
   * Most recently PINNED first, which is not the same as newest message first.
   *
   * > **Ordering by `seq` was wrong and looked like several separate bugs.** Pin six messages,
   * > unpin the first, pin it again: it is the most recent pin but the oldest message, so it went
   * > back to the end of the strip and a four-item cap dropped it immediately. It appeared in
   * > Highlights and nowhere else, and the notice showed the message's time rather than the pin's,
   * > because a pin time did not exist at all until `pinnedAt`.
   *
   * A tombstone is dropped outright: a deleted message is not worth keeping above the
   * conversation.
   */
  const pinnedRows = useMemo(() =>
    rows
    .flatMap((row) => (row.kind === "message" ? [row.message] : []))
    .filter(
      (message) =>
        message.pinned &&
        message.deletedAt === null &&
        !dismissedPins.has(message.seq),
    )
    .sort((a, b) => {
      // Null sorts last: a row cached before `pinnedAt` existed still has a place, just not
      // the front. It gains its real time on the next sync.
      const at = a.pinnedAt === null ? 0 : Date.parse(a.pinnedAt);
      const bt = b.pinnedAt === null ? 0 : Date.parse(b.pinnedAt);
      return bt - at;
    })
    /*
     * The strip is a RECENCY WINDOW, not the pin list.
     *
     * > **Nothing is unpinned by falling off the end.** A fifth pin pushes the oldest out of the
     * > strip and it stays pinned, stays in Highlights, and stays findable. An app that silently
     * > undid an admin's pin to make room would be destroying a decision to save four points of
     * > vertical space.
     *
     * Capped because the strip hangs over the conversation: past a handful the notices stop being
     * notices and become a second scrolling list on top of the first.
     */
      .slice(0, PINNED_STRIP_LIMIT),
    [rows, dismissedPins],
  );

  /**
   * Load the channel's title and whether the composer is live.
   *
   * One endpoint for all four scopes, so this screen stays a single implementation rather than
   * forking for DMs. A failure here is not fatal: history still renders from the local cache,
   * which is what makes the screen work in airplane mode.
   */
  const loadMeta = useCallback(async () => {
    if (!channelId) return;
    /*
     * The `@` pool, fetched once with the meta rather than per keystroke. It is a roster: it
     * changes when somebody joins a club, not while you are typing, and holding it locally is
     * what lets the list appear the instant `@` is pressed instead of after a round trip.
     *
     * Its own catch, because failing to load it must not cost the screen its meta - a chat with
     * no mention list still works.
     */
    void channelApi
      .mentionable(channelId)
      .then((data) => setMentionable(data.members))
      .catch(() => setMentionable([]));
    try {
      setMeta(await dmApi.meta(channelId));
    } catch {
      setMeta(null);
    } finally {
      /*
       * Settled, whether it worked or not.
       *
       * A null `meta` alone cannot tell "still loading" from "this read failed", and the header
       * needs the difference: while loading it renders nothing, because the name is milliseconds
       * away and a word that swaps looks like a glitch. Once the read has FAILED nothing is
       * coming, so a permanently blank header would read as broken - it falls back to "Chat".
       */
      setMetaResolved(true);
    }
  }, [channelId]);

  useEffect(() => {
    void loadMeta();
  }, [loadMeta, revision]);

  /**
   * Go to a message by seq, fetching the history around it if it is not loaded.
   *
   * > **This is what `GET /channels/:id/messages/around` exists for.** Highlights, a pinned-strip
   * > notice, a mention notification and now a tapped reply quote all name a specific `seq`, and
   * > paging backward from the tail until it appears cannot satisfy "jumps on the FIRST tap" - the
   * > message is not loaded yet, so a first tap could only start fetching.
   *
   * The window is written into the local store rather than held in this component, so it is cached
   * like every other page of history and a second jump to the same place needs no network at all.
   * Failing is survivable: the chat still renders its tail, which is the "realtime and paging are
   * enhancements" rule applied to navigation.
   *
   * **One jump, used by both callers.** The URL parameter below and the quote box are the same
   * gesture with a different trigger, and a second implementation of "get me to seq N" is how the
   * two would end up behaving differently.
   */
  const jumpTo = useCallback(
    async (target: number) => {
      if (!client || !channelId) return;
      try {
        const window = await channelApi.around(channelId, target);
        await client.store.upsert(window.messages);
        await refresh();
      } catch {
        // Leave the tail on screen. A jump that cannot load is a worse outcome than a jump that
        // does not happen, and the notice says which.
        setNotice("Could not open that message.");
      } finally {
        // Set even when the fetch failed: the message may well be loaded already, in which case
        // the scroll below finds it and nothing was needed. The effect clears it either way.
        setJumpedTo(target);
      }
    },
    [client, channelId, refresh],
  );

  /** The same jump, for a caller that cannot await - the quote box's tap. */
  const jumpToQuote = useCallback((seq: number) => void jumpTo(seq), [jumpTo]);

  /** A jump named in the URL, which is how Highlights and a notification arrive here. */
  useEffect(() => {
    const target = Number(around);
    if (!Number.isInteger(target) || target <= 0) return;
    void jumpTo(target);
  }, [around, jumpTo]);

  /**
   * Scroll the jumped-to message into view.
   *
   * Separate from the fetch because it has to run after the rows render - the index does not exist
   * until the window is in `rows`. `viewPosition: 0.5` puts the target in the middle rather than at
   * the top, so the messages around it are visible, which is the whole reason a window was fetched
   * instead of one message.
   */
  useEffect(() => {
    if (jumpedTo === null) return;
    // Against the INVERTED array, because that is what the list is indexing. Looking the target
    // up in `rows` would scroll to its mirror image - the right distance from the wrong end.
    const index = invertedRows.findIndex(
      (row) => row.kind === "message" && row.message.seq === jumpedTo,
    );
    // A target that is not in the list still has to clear the highlight, which is why this no
    // longer returns early.
    if (index >= 0) {
      listRef.current?.scrollToIndex({
        index,
        viewPosition: 0.5,
        animated: false,
      });
    }

    /*
     * > **Cleared once it has landed, and that is a bug fix rather than tidiness.**
     * >
     * > This effect depends on `rows`, and `jumpedTo` used to be set forever. So EVERY later
     * > change to the list re-ran it and yanked the reader back to a message they had jumped to
     * > minutes ago - most visibly on unpinning, which calls `refresh()` and therefore changes
     * > `rows`, making an unpin look like it was navigating somewhere on purpose.
     *
     * The delay is the highlight: `isJumpTarget` reads the same value, so clearing it instantly
     * would land the jump with no indication of which message was the target.
     */
    const settle = setTimeout(() => setJumpedTo(null), JUMP_HIGHLIGHT_MS);
    return () => clearTimeout(settle);
  }, [jumpedTo, invertedRows]);

  /**
   * The read cursor as it stood the moment this screen opened.
   *
   * > **Captured BEFORE the effect below marks the channel read**, which is the whole difficulty:
   * > opening a chat is what clears its unread count, so by the time anything else could ask,
   * > the answer is always "nothing unread". Effects run in declaration order, so this one being
   * > written above that one is load-bearing rather than stylistic.
   *
   * Null until the channel is known, which a cold open reaches before the channel list has
   * synced. The landing below treats null as "caught up" and stays at the newest message, which
   * is the right answer when we cannot prove otherwise - it is where chat opens anyway.
   */
  const entryLastReadRef = useRef<number | null>(null);
  useEffect(() => {
    if (entryLastReadRef.current !== null || !client || !channelId) return;
    const channel = client.channels.find((entry) => entry.id === channelId);
    if (channel) entryLastReadRef.current = channel.lastReadSeq;
  }, [client, channelId, revision]);

  /**
   * Decide where the rule goes, ONCE, as soon as there are rows and a cursor to decide from.
   *
   * Separate from the landing effect below, which is guarded the same way but has a different
   * job: that one places the reader and gives up the moment they touch the list, where this one
   * settles a fact about the conversation that must not change while they are looking at it.
   *
   * Deliberately does NOT decide while the cursor is unknown - a cold open reaches this screen
   * before the channel list has synced, and deciding then would answer "caught up" for every
   * conversation. Leaving the ref unset lets the next render try again.
   */
  const anchorDecidedRef = useRef(false);
  useEffect(() => {
    if (anchorDecidedRef.current || loading || rows.length === 0) return;
    const lastRead = entryLastReadRef.current;
    if (lastRead === null) return;
    anchorDecidedRef.current = true;
    setLastReadAnchor(decideLastReadAnchor(rows, lastRead));
  }, [loading, rows]);

  /**
   * Where the conversation opens: the first unread message, or the newest if there are none.
   *
   * > **Once, on arrival, and never again.** `landedRef` is not tidiness - this depends on
   * > `rows`, and without it every later change to the list would re-place the reader, which is
   * > the yanking bug that has already been fixed twice on this screen in different disguises.
   *
   * Nothing happens in the common case, and that is the point: an inverted list already opens at
   * the newest message, so a caught-up reader needs no scroll at all and sees no motion. Only an
   * unread channel moves, and it moves instantly rather than travelling.
   *
   * A `?around=` jump owns the position outright - it was asked for explicitly, and landing on
   * an unread message first would fight it.
   */
  const landedRef = useRef(false);
  /**
   * The row the arrival is still trying to hold at the top of the screen, while the rows around
   * it finish measuring. Null once it has settled or the reader has taken over.
   */
  const pendingLandingRef = useRef<Row | null>(null);
  /**
   * How many times a placement may be re-applied as the content settles.
   *
   * Bounded rather than time-based: a card that re-measures forever would otherwise pin the
   * reader in place indefinitely, and "a few layout passes" is what this is actually waiting for
   * rather than a duration.
   */
  const landingAttemptsRef = useRef(0);
  useEffect(() => {
    if (landedRef.current || loading || rows.length === 0) return;
    landedRef.current = true;

    /*
     * Nothing counts as "new" from here on until it actually arrives. Set even when the reader
     * is being placed among unread messages: those are what they came to read, and announcing
     * them in a control that offers to scroll to where they already are would be noise.
     */
    setSeenThrough(newestSeq);
    if (around !== undefined) return;

    const lastRead = entryLastReadRef.current;
    if (lastRead === null) return;
    const firstUnread = rows.find(
      (row) => row.kind === "message" && row.message.seq > lastRead,
    );
    if (!firstUnread) return;

    /*
     * > **Held, not just applied once, because the list is still measuring itself.**
     * >
     * > A card renders as an empty shell and grows ~180px when its fetch lands; a photo does the
     * > same when its bytes arrive. Placing the first unread message at the top of the screen the
     * > instant the rows exist therefore computes an offset against content that has not finished
     * > existing - and if the messages below it are still shells, the offset needed is larger than
     * > the content available, so it clamps to the bottom and stays there. Measured: the target
     * > resolved correctly to seq 11 and the list still sat at offset 0.
     *
     * So the target is remembered and re-applied as the content settles. `pendingLanding` is
     * cleared the moment the reader touches the list, which is what stops this from becoming the
     * yanking bug it is descended from: they always win.
     */
    /*
     * The DIVIDER is the landing target when there is one, not the message under it.
     *
     * Placing the first unread message at the top of the screen puts the rule that explains it
     * one row above the fold, so the reader arrives among new messages with the thing that says
     * so just out of sight. Landing on the rule itself is what makes it do its job, and it is
     * also the sturdier target: `LAST_READ_ROW` is a constant, so the re-application below cannot
     * lose it to a rebuilt row object the way a message can.
     */
    const target = invertedRows.includes(LAST_READ_ROW) ? LAST_READ_ROW : firstUnread;
    pendingLandingRef.current = target;
    placeAtTop(target);
  }, [loading, rows, invertedRows, around, newestSeq, placeAtTop]);

  /**
   * Keep "what the reader has seen" level with the conversation while they are at the bottom.
   *
   * The moment they scroll back into history this stops advancing, which is what freezes the
   * count for the control below. Nothing else has to know they left.
   */
  useEffect(() => {
    if (!atNewest) return;
    setSeenThrough((seen) => (newestSeq > seen ? newestSeq : seen));
  }, [atNewest, newestSeq]);

  /*
   * Opening a chat marks it read. That is the ONLY thing that clears its unread count - nothing
   * else does, including opening the notification inbox.
   *
   * > **Sent unconditionally, not only when the channel is already in the client's list.** It used
   * > to look the channel up first and skip the frame when it was missing, which is exactly the
   * > state a cold open leaves: a deep link, a notification tap or a refresh lands here before the
   * > channel list has synced, so the one case where the unread most needs clearing was the case
   * > that silently did nothing.
   *
   * The seq is a hint rather than the instruction: the server resolves the channel's own
   * `last_seq` and marks up to that, so a zero here still marks the whole channel read. Sending
   * the known value anyway keeps the frame honest about what this client had actually seen.
   */
  useEffect(() => {
    if (!client || !channelId) return;
    const channel = client.channels.find((entry) => entry.id === channelId);
    /*
     * The higher of what the channel list last reported and what this screen actually holds.
     *
     * The server resolves its own `last_seq` regardless, so this number does not decide what
     * gets marked - but it is also what the client records locally as "read through", and that
     * copy decides where a RE-ENTRY places the reader. Sending the stale channel-list value
     * alone would leave the local cursor behind the conversation and drop somebody back into
     * history they had already read.
     */
    client.markRead(channelId, Math.max(channel?.lastSeq ?? 0, newestSeq));
  }, [client, channelId, revision, newestSeq]);

  /*
   * The message the overlay is about, resolved from the seq the long-press recorded.
   *
   * Looked up rather than stored, so it stays current: a reaction or a pin landing while the menu
   * is open updates the copy on screen instead of freezing a stale one.
   */
  const selectedMessage = useMemo(
    () =>
      selected === null
        ? null
        : (rows.find(
            (row): row is { kind: "message"; message: MessageEnvelope } =>
              row.kind === "message" && row.message.seq === selected,
          )?.message ?? null),
    [rows, selected],
  );

  /** The message the composer is answering, resolved the same way and for the same reasons. */
  const replyingTo = useMemo(
    () =>
      replyingToSeq === null
        ? null
        : (rows.find(
            (row): row is { kind: "message"; message: MessageEnvelope } =>
              row.kind === "message" && row.message.seq === replyingToSeq,
          )?.message ?? null),
    [rows, replyingToSeq],
  );

  /*
   * The `@` list's contents, derived from the draft and the caret rather than held in state.
   *
   * Two pieces of state to keep in step would be one too many: every keystroke, every caret move
   * and every insertion would have to remember to update it, and the failure when one forgets is
   * a list showing the wrong people.
   */
  const mentionQuery = activeMentionQuery(draft, caret);
  const mentionMatches = useMemo(
    () => (mentionQuery === null ? [] : matchMentionables(mentionable, mentionQuery.query)),
    [mentionable, mentionQuery?.query],
  );

  /**
   * Toggle a reaction.
   *
   * Optimistic, and reconciled from the response rather than from a locally-guessed set: the
   * server returns the full resulting set, which is also what arrives over the socket for
   * everybody else. Two devices held by the same member therefore converge on the same answer
   * without either one having to have guessed right.
   */
  const react = useCallback(
    async (seq: number, emoji: ReactionEmoji) => {
      if (!client || !channelId) return;
      try {
        const result = await dmApi.reactionToggle(channelId, seq, emoji);
        await client.store.patch(channelId, seq, { reactions: result.reactions });
      } catch {
        // A refusal here is a blocked DM participant or a deleted message. Say so rather than
        // leaving a pill that silently did not stick.
        setNotice("Could not react to that message.");
      }
      await refresh();
    },
    [client, channelId, refresh],
  );

  const retry = useCallback(
    async (clientMsgId: string) => {
      if (!client) return;
      try {
        await client.flushOne(clientMsgId);
      } catch {
        /* stays failed, still visible */
      }
      await refresh();
    },
    [client, refresh],
  );

  const openProfile = useCallback(
    (memberId: string) => router.push(`/users/${memberId}`),
    [router],
  );

  /** Open the long-press menu on a message, from the bubble or from a card's dots. */
  const selectMessage = useCallback((seq: number) => {
    setSelected(seq);
    setConfirmingReport(null);
  }, []);

  /**
   * Open a photo full screen.
   *
   * The whole envelope is kept rather than the media id: the viewer's header draws the sender
   * and the date, and Reply and Report both need the `seq`. Held here rather than looked up
   * again on close, so the viewer cannot be left holding a message the list has since replaced.
   */
  const openPhoto = useCallback(
    (message: MessageEnvelope) => setViewingPhoto(message),
    [],
  );

  /*
   * Both list callbacks are hoisted out of the JSX and given stable identities.
   *
   * `renderItem` used to be a ~400-line inline closure, so it was a new function on every render
   * AND it rebuilt every row's subtree inline. `MessageRow` is memoized, which only works if what
   * it is handed stops changing - hence the `useCallback`s above, each taking a `seq` and closing
   * over nothing that moves per row.
   */
  const keyExtractor = useCallback((row: Row) => {
    switch (row.kind) {
      case "message":
        return `m-${row.message.seq}`;
      case "pending":
        return `p-${row.clientMsgId}`;
      case "day":
        return `d-${row.dateKey}`;
      case "lastRead":
        return "last-read";
    }
  }, []);

  const renderRow = useCallback(
    ({ item }: { item: Row }) => {
      if (item.kind === "day") {
        return (
          <View style={styles.dayRow}>
            <Text style={styles.dayLabel}>{formatDaySeparator(item.dateKey)}</Text>
          </View>
        );
      }
      if (item.kind === "lastRead") {
        return (
          <View
            style={styles.lastReadRow}
            accessibilityRole="header"
            accessibilityLabel="Last read. Everything below this is new."
          >
            <View style={styles.lastReadRule} />
            <Text style={styles.lastReadLabel}>Last read</Text>
            <View style={styles.lastReadRule} />
          </View>
        );
      }
      if (item.kind === "pending") {
        return (
          <PendingRow row={item} onRetry={retry} onJumpToQuote={jumpToQuote} />
        );
      }
      return (
        <MessageRow
          message={item.message}
          userId={userId}
          mine={item.message.senderId === userId}
          // Marked so a reader can see WHICH message a jump sent them to. Without it the screen
          // has silently scrolled somewhere and the target is indistinguishable from its
          // neighbours, which is most of the value of jumping.
          isJumpTarget={jumpedTo === item.message.seq}
          onSelect={selectMessage}
          onReact={react}
          onOpenProfile={openProfile}
          onJumpToQuote={jumpToQuote}
          onOpenPhoto={openPhoto}
        />
      );
    },
    [retry, userId, jumpedTo, selectMessage, react, openProfile, jumpToQuote, openPhoto],
  );

  /*
   * Every hook is above this line, and the two early exits are below it.
   *
   * > **They used to sit above `selectedMessage` and `mentionMatches`, which is a hook-order
   * > violation.** Rendering once while auth was still checking and again once it resolved would
   * > run a different NUMBER of hooks in the two renders, which React refuses with "rendered more
   * > hooks than during the previous render". It survived only because this screen happens not to
   * > be mounted during the checking state today - a fact no part of the file states or enforces,
   * > and one that stops being true the moment a route stops guarding it.
   */
  if (authState === "checking") {
    return (
      <View style={styles.centered}>
        <ActivityIndicator color={color.accent} />
      </View>
    );
  }
  if (authState === "signed-out") return <Redirect href="/sign-in" />;

  const canPost = meta === null ? true : meta.canPost;

  /** Insert the chosen name and remember who it was, so the send can claim them. */
  const pickMention = (member: Mentionable) => {
    if (mentionQuery === null) return;
    const next = applyMention(draft, mentionQuery.start, caret, member);
    setDraft(next.text);
    setCaret(next.caret);
    setMentionPicks((picks) =>
      picks.some((pick) => pick.userId === member.userId)
        ? picks
        : [...picks, { userId: member.userId, name: member.name }],
    );
  };

  const send = async () => {
    const body = draft.trim();
    if (body.length === 0 || !client || !channelId || !canPost) return;
    setDraft("");
    /*
      Sending is a deliberate return to the newest message, wherever the reader had scrolled to.
      Posting from halfway up the history and being left there, unable to see what you just
      said, is the one case where movement is what somebody wants.
    */
    scrollToNewest();
    // Disarmed as the message goes, so the NEXT one is an ordinary message. An announcement
    // toggle that stays armed is how somebody posts three of them by accident, and each one
    // notifies the whole space.
    const announcing = asAnnouncement;
    setAsAnnouncement(false);
    /*
     * Only the people the FINAL text still names. Picking a name and then deleting it before
     * sending must not notify them - see `mentionIdsInBody`. The server applies the same rule on
     * arrival and is the real enforcement; this keeps the honest case from ever claiming a lie.
     */
    const mentions = mentionIdsInBody(mentionPicks, body);
    setMentionPicks([]);
    /*
     * The reply is cleared as the message goes, like the announcement toggle above and for the
     * same reason: a composer that stayed pointed at one message would turn the next three
     * unrelated messages into replies to it.
     *
     * `replyingTo` rather than `replyingToSeq` alone, because the optimistic bubble needs the
     * quote to draw and the resolved message is what has it. Sending the seq and drawing from
     * the local copy is the split `MessageReplyRef` describes: the server joins the real quote
     * on read, and this copy only ever appears in the sender's own pending bubble.
     */
    const answering = replyingTo;
    setReplyingToSeq(null);
    try {
      await client.sendWithRetry(channelId, body, {
        ...(announcing ? { type: "announcement" as const } : {}),
        ...(mentions.length > 0 ? { mentions } : {}),
        ...(answering === null
          ? {}
          : { replyToSeq: answering.seq, replyTo: quoteOf(answering) }),
      });
    } catch {
      // The send failed VISIBLY: the entry stays in the outbox marked failed, and the
      // row below renders it with a retry affordance. It is never silently dropped.
    }
    await refresh();
  };

  /**
   * Pin or unpin, and delete.
   *
   * Both re-read afterwards rather than patching local state: pinning is a server fact that the
   * pinned strip, Highlights and every other connected client read independently, and a local
   * guess would be a second opinion about it.
   */
  /**
   * Open a pinned notice: always Highlights, never a jump into the conversation.
   *
   * > **A pin is something to READ, not somewhere to go.** Jumping dropped the reader into the
   * > middle of history with no clear way back to where they were, and whether it even worked
   * > depended on how far back the message happened to be. Highlights shows the pin in full,
   * > opens instantly whatever its age, and is the same answer every time.
   */
  const openPinned = () => {
    router.push(`/channels/${channelId}/highlights`);
  };

  const setPinned = async (seq: number, pinned: boolean) => {
    if (!channelId) return;
    setSelected(null);
    try {
      await channelApi.setPinned(channelId, seq, pinned);
      /*
       * No confirmation banner. The pinned strip appearing or losing a card IS the feedback, and
       * a second line announcing it covered the top of the conversation to say what was already
       * visible. Failures below still speak, because nothing else would say so.
       */
    } catch {
      setNotice("Could not change the pin. Try again.");
    }
    await refresh();
  };

  const removeMessage = async (seq: number) => {
    if (!channelId) return;
    setSelected(null);
    setConfirmingDelete(null);
    try {
      await channelApi.deleteMessage(channelId, seq);
      // A tombstone, not a disappearance: the row stays and reads as deleted, which is what
      // keeps the gapless sequence gapless - and is also why no banner is needed. The message
      // visibly becoming "This message was deleted" is the confirmation.
    } catch {
      setNotice("Could not delete that. Try again.");
    }
    await refresh();
  };

  /**
   * Report a message to whoever moderates this conversation.
   *
   * Reported by `seq` rather than by id, like every other message command here - the seq is the
   * channel-scoped address, and the server resolves it inside the channel it has already
   * authorized. Reporting the same message twice is not an error and says so.
   */
  const reportMessage = async (seq: number) => {
    if (!channelId) return;
    setConfirmingReport(null);
    setSelected(null);
    try {
      const result = await channelApi.report(channelId, seq);
      setNotice(
        result.alreadyReported
          ? "You already reported this message."
          : "Reported. The other person is not told.",
      );
    } catch {
      setNotice("Could not report that. Try again.");
    }
  };

  /**
   * Pick, upload, then send.
   *
   * The upload finishes BEFORE the message is enqueued, which is what makes the send safe to
   * retry from the outbox across a reconnect: the object is already durable and already
   * verified, so a retry re-sends an id rather than re-sending bytes.
   */
  const attach = async (
    pick: () => Promise<PickedAttachment | null>,
    // Narrower than `UploadKind`, which also covers avatars - a conversation has no use for one.
    kind: 'photo' | 'document',
  ) => {
    setAttachOpen(false);
    if (!client || !channelId || uploading) return;

    setUploading(true);
    try {
      const picked = await pick();
      // Dismissed. Not an error, and not worth a notice.
      if (!picked) return;

      const uploaded = await uploadAttachment(channelId, picked, kind);
      // Same deliberate return to the newest message as a typed send. See `send`.
      scrollToNewest();
      await client.sendWithRetry(channelId, "", {
        type: kind,
        mediaId: uploaded.mediaId,
        localUri: uploaded.localUri,
        ...(uploaded.name ? { documentName: uploaded.name } : {}),
        documentSize: uploaded.bytes,
      });
    } catch (error) {
      // PRD/05: an upload failure is surfaced and the message is NOT posted. Both halves
      // matter - a silent failure leaves the sender believing a photo arrived.
      setNotice(
        error instanceof UploadError
          ? error.message
          : "The attachment could not be sent. Try again.",
      );
    } finally {
      setUploading(false);
      await refresh();
    }
  };

  /**
   * The parent this screen falls back to.
   *
   * > **Never this conversation's own hub, for a race or an Eboard space.** Both hubs send a real
   * > member straight into chat, so a back control pointing at either would bounce hub to chat to
   * > hub forever for somebody arriving with no history. That is a hard rule, not a preference.
   *
   * So a race falls back to the **races list** and an Eboard space to the **club hub** - one
   * meaningful level up in each case, and neither is a screen that redirects back here. Club chat
   * has no such problem: the club hub is a real destination that does not forward.
   */
  const parent =
    meta === null
      ? "/clubs"
      : meta.scope === "dm"
        ? "/dm"
        : meta.scope === "club"
          ? `/clubs/${meta.scopeId}`
          : // Race and Eboard chat both fall back to the CLUB hub. Neither falls back to its own
            // hub, which would bounce - both hubs send a member straight into chat - and there is
            // no races list to fall back to, because the product does not have one.
            `/clubs/${meta.clubId}`;

  const parentLabel =
    meta === null
      ? "Clubs"
      : meta.scope === "dm"
        ? "Messages"
        : "Club";

  // One definition of "back" for the whole app: pop if there is history, use the declared
  // parent if there is not. See `useGoBack`.
  const goBack = useGoBack(parent);

  const act = async (run: () => Promise<unknown>, message: string) => {
    setMenuOpen(false);
    try {
      await run();
      setNotice(message);
      await loadMeta();
    } catch {
      setNotice("That did not work. Try again.");
    }
  };

  return (
    <KeyboardAvoidingView
      style={styles.flex}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      {/*
        Chat's own header. The back control ALWAYS renders and always has an explicit
        target: a control that only appears when history exists is a bug, because direct
        URL entry and page refresh leave no history on any screen.
      */}
      {/*
        The status-bar inset is padding on the header itself, not a wrapper.

        Without it this row started at y=0 and the clock, Dynamic Island and battery sat on top
        of the back control - which web never showed, because a browser has no status bar, and
        which Expo Go on the simulator hid behind its own chrome. Highlights, the screen this
        header is meant to match, had it from the start; chat is the copy that lost it.
      */}
      <BlurView
        intensity={80}
        tint="light"
        style={[styles.header, { paddingTop: insets.top + space.sm }]}
        onLayout={(event) => {
          const { y, height } = event.nativeEvent.layout;
          setHeaderBottom(y + height);
        }}
      >
        <Pressable
          onPress={goBack}
          accessibilityRole="button"
          accessibilityLabel={`Back to ${parentLabel}`}
          hitSlop={space.sm}
          style={styles.backButton}
        >
          <MaterialIcons
            name="arrow-back"
            size={20}
            color={color.textPrimary}
          />
        </Pressable>
        {/*
          The channel's own identity, not just its name: v1 pairs the avatar with a two-line
          column so a chat opened from a notification says what you are looking at without
          needing the screen behind it.
        */}
        {/*
          Nothing until the channel resolves, rather than the word "Chat" and a letter "C" that
          both swap a moment later. A placeholder that is visibly replaced reads as a glitch; a
          header that fills in reads as loading. The column keeps its height either way, so the
          controls beside it do not shift when the name arrives.
        */}
        {meta === null ? (
          <View style={styles.headerAvatarPlaceholder} />
        ) : (
          <Avatar
            name={meta.name}
            size={36}
            image={meta.image}
            // A DM is a person; a club, a race and the Eboard space are things.
            shape={meta.scope === "dm" ? "circle" : "square"}
          />
        )}
        {/*
          The title opens THIS conversation's own profile - the race's from a race chat, the
          space's from Eboard chat, the club's from club chat.

          It used to reach the club from all three, because the race and Eboard profiles did not
          exist and a link to nothing is worse than a link to the parent. Now that they do, sending
          a race chat to the club's profile would be the wrong screen with the right club on it:
          the roster, the gallery and the picture it shows would all belong to something else. A
          DM's title still goes nowhere at all - there is no space behind it.
        */}
        <Pressable
          style={styles.headerTitleColumn}
          disabled={meta === null}
          onPress={() => {
            if (meta === null) return;
            /*
              A DM now has a profile of its own - the shared clubs, this thread's gallery, and
              pin/block/delete chat. It could not before, which is why this used to be disabled
              for the scope: there was no space behind the name and the club would have been the
              wrong screen with the right person on it.
            */
            router.push(
              spaceScope === undefined
                ? `/dm/${meta.channelId}/profile`
                : spaceProfileHref(spaceScope, meta.scopeId),
            );
          }}
          accessibilityRole={meta === null ? undefined : "button"}
          accessibilityLabel={meta === null ? undefined : `${meta.name}. Open its profile`}
        >
          <Text style={styles.headerTitle} numberOfLines={1}>
            {meta?.name ?? (metaResolved ? "Chat" : "")}
          </Text>
          <Text style={styles.headerSubtitle} numberOfLines={1}>
            {meta === null ? "" : offline ? "Reconnecting" : "ClubChat"}
          </Text>
        </Pressable>
        {/*
          Highlights is a filled pill and everything else hides behind the grid, which is v1's
          weighting: Highlights is the one destination somebody reaches for repeatedly, and the
          rest are occasional. A DM has neither - it gets the options sheet instead, because mute
          and block are the only things hanging off a conversation with no club around it.
        */}
        {meta !== null && meta.scope !== "dm" && (
          <>
            <Pressable
              onPress={() => router.push(`/channels/${channelId}/highlights`)}
              accessibilityRole="button"
              accessibilityLabel="Highlights"
              style={styles.highlightsPill}
            >
              <MaterialIcons name="bolt" size={16} color={color.onAccent} />
              <Text style={styles.highlightsPillLabel}>Highlights</Text>
            </Pressable>
            {/*
              Three dots, not a grid. A grid says "a set of things laid out"; three dots is the
              one glyph a phone user reads as "there is more behind this" without being taught,
              and it is what every other menu in this app already uses.
            */}
            <Pressable
              onPress={() => setGridOpen((open) => !open)}
              accessibilityRole="button"
              accessibilityLabel="This conversation's screens"
              hitSlop={space.sm}
              style={styles.headerAction}
            >
              <MaterialIcons name="more-vert" size={20} color={color.textPrimary} />
            </Pressable>
          </>
        )}
        {meta?.scope === "dm" && (
          <Pressable
            onPress={() => setMenuOpen((open) => !open)}
            accessibilityRole="button"
            accessibilityLabel="Conversation options"
            hitSlop={space.sm}
            style={styles.headerAction}
          >
            {/* Vertical, like the group header beside it: one corner, one glyph, whatever the
                conversation is. It held the horizontal pair while the group chats held a grid. */}
            <MaterialIcons name="more-vert" size={20} color={color.textPrimary} />
          </Pressable>
        )}
      </BlurView>

      {/*
        The dropdown: where this conversation's other screens live.

        Anchored under the header rather than shown as a permanent strip, because these are places
        you go occasionally and a row of six chips above every conversation spends the screen's
        most valuable space on navigation.

        > **`top` is measured, and leaving it unset was the whole bug.** An absolutely positioned
        > view with no `top` lays out at the top of its container, which here is the screen - so
        > the panel opened OVER the status bar and the header, clipping the title and the back
        > button into what looked like a divided header. The comment above already said "anchored
        > under the header"; the anchor itself was never written, and nothing failed because a
        > menu in the wrong place still renders and still works.
      */}
      {gridOpen && meta !== null && meta.scope !== "dm" && (
        <>
          <Pressable
            style={styles.gridScrim}
            onPress={() => setGridOpen(false)}
            accessibilityRole="button"
            accessibilityLabel="Close"
          />
          <View style={[styles.gridMenu, { top: headerBottom + space.xs }]}>
            {scopeLinks(meta.scope, meta).map((item) => (
              <Pressable
                key={item.href}
                style={styles.gridRow}
                onPress={() => {
                  setGridOpen(false);
                  router.push(item.href);
                }}
                accessibilityRole="button"
                accessibilityLabel={item.label}
              >
                <MaterialIcons name={item.icon} size={18} color={color.accent} />
                <Text style={styles.gridRowLabel}>{item.label}</Text>
              </Pressable>
            ))}
          </View>
        </>
      )}

      {/*
        v1's floating pinned strip.

        The point of a pin is that it stays reachable without scrolling, and Highlights alone does
        not do that: it is a screen you have to go to. Horizontal, because a channel can carry
        several notices and stacking them would eat the conversation.
      */}
      {pinnedRows.length > 0 && (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={[styles.pinnedStrip, !pinnedStripVisible && styles.pinnedStripFaded]}
          contentContainerStyle={styles.pinnedStripContent}
          /*
            Faded out, it must not intercept taps meant for the messages behind it - a strip you
            cannot see but can still press is worse than one that is simply there.
          */
          pointerEvents={pinnedStripVisible ? "auto" : "none"}
        >
          {pinnedRows.map((message) => (
            <BlurView
              key={message.seq}
              intensity={60}
              tint="light"
              style={styles.pinnedCard}
            >
              <Pressable
                style={styles.pinnedCardBody}
                onPress={openPinned}
                accessibilityRole="button"
                accessibilityLabel="Open this pinned message in Highlights"
              >
                <View style={styles.pinnedIcon}>
                  <MaterialIcons
                    name="push-pin"
                    size={16}
                    color={color.accent}
                  />
                </View>
                <View style={styles.pinnedTextColumn}>
                  <Text style={styles.pinnedLabel}>Notice</Text>
                  <Text style={styles.pinnedText} numberOfLines={1}>
                    {pinnedPreview(message)}
                  </Text>
                </View>
              </Pressable>
              <Pressable
                onPress={() =>
                  setDismissedPins((prev) => new Set(prev).add(message.seq))
                }
                accessibilityRole="button"
                accessibilityLabel="Dismiss this notice"
                hitSlop={space.sm}
                style={styles.pinnedDismiss}
              >
                <MaterialIcons
                  name="close"
                  size={16}
                  color={color.textSecondary}
                />
              </Pressable>
            </BlurView>
          ))}
        </ScrollView>
      )}

      {/*
        An in-app sheet rather than a platform Alert. A confirmation dialog can report success,
        log nothing and do nothing where a platform stubs out the dialog API - and react-native-web
        is exactly such a platform, which would make block and mute silently no-op on the surface
        this project develops on.
      */}
      {menuOpen && (
        <View style={styles.sheet}>
          <Pressable
            style={styles.sheetRow}
            onPress={() =>
              void act(
                () =>
                  meta?.muted
                    ? dmApi.unmute(channelId!)
                    : dmApi.mute(channelId!),
                meta?.muted
                  ? "Unmuted."
                  : "Muted. You will still see unread counts.",
              )
            }
            accessibilityRole="button"
            accessibilityLabel={
              meta?.muted
                ? "Unmute this conversation"
                : "Mute this conversation"
            }
          >
            <Text style={styles.sheetLabel}>
              {meta?.muted ? "Unmute conversation" : "Mute conversation"}
            </Text>
            <Text style={styles.sheetHint}>
              {meta?.muted
                ? "Notifications on again"
                : "No notifications, unread still counts"}
            </Text>
          </Pressable>

          {meta?.peer && (
            <Pressable
              style={styles.sheetRow}
              onPress={() =>
                void act(
                  () =>
                    meta.peer!.blockedByMe
                      ? dmApi.unblock(meta.peer!.userId)
                      : dmApi.block(meta.peer!.userId),
                  meta.peer!.blockedByMe
                    ? `Unblocked ${meta.peer!.name}.`
                    : `Blocked ${meta.peer!.name}. History stays visible to you both.`,
                )
              }
              accessibilityRole="button"
              accessibilityLabel={
                meta.peer.blockedByMe
                  ? `Unblock ${meta.peer.name}`
                  : `Block ${meta.peer.name}`
              }
            >
              <Text
                style={[
                  styles.sheetLabel,
                  !meta.peer.blockedByMe && styles.destructive,
                ]}
              >
                {meta.peer.blockedByMe
                  ? `Unblock ${meta.peer.name}`
                  : `Block ${meta.peer.name}`}
              </Text>
              <Text style={styles.sheetHint}>
                {meta.peer.blockedByMe
                  ? "You will both be able to send again"
                  : "Instant. Nobody reviews it, and they are not told"}
              </Text>
            </Pressable>
          )}

          <Pressable
            style={styles.sheetRow}
            onPress={() => setMenuOpen(false)}
            accessibilityRole="button"
            accessibilityLabel="Close options"
          >
            <Text style={styles.sheetLabel}>Close</Text>
          </Pressable>
        </View>
      )}

      {/*
        Says so, rather than looking broken. History below is real - it comes from the local
        cache - and a send will queue rather than fail, so the honest message is "offline",
        not "error".
      */}
      {offline && (
        <View style={styles.offlineBanner}>
          <Text style={styles.offlineText}>
            Offline. Showing saved messages.
          </Text>
        </View>
      )}

      {notice !== null && (
        <Pressable
          style={styles.notice}
          onPress={() => setNotice(null)}
          accessibilityRole="button"
          accessibilityLabel="Dismiss message"
        >
          <Text style={styles.noticeText}>{notice}</Text>
        </Pressable>
      )}

      {loading ? (
        // The composer is not shown until the channel resolves, so nobody types into a
        // chat that has not loaded.
        <View style={styles.centered}>
          <ActivityIndicator color={color.accent} />
        </View>
      ) : (
        <FlatList
          ref={listRef}
          /*
            > **Inverted, which is what makes chat open AT the newest message rather than
            > scrolling to it.**
            >
            > It used to render oldest-first and chase the bottom with `scrollToEnd` on every
            > content size change, and that failed in two visible ways at once. Measured on
            > opening this channel: the list mounted at offset 0, jumped to 302 when the content
            > was 1144 tall, and then **stayed at 302 while the content grew to 3177** - so the
            > reader watched it scroll and still did not land at the bottom. The scroll it
            > performed itself fired `onScroll`, which measured `fromBottom` against the
            > half-rendered list, concluded the reader had left the tail, and switched off
            > follow-the-tail for the rest of the session.
            >
            > Inverting removes the chase rather than tuning it. Offset 0 IS the newest message,
            > so arrival needs no scroll at all, and a message arriving while the reader is up in
            > history extends the list away from them instead of moving them.

            The data is reversed rather than the store's order changed: `rows` stays oldest-first
            for the pinned strip, which sorts by pin time, and for everything else that reasons
            about history in the order it happened.
          */
          inverted
          data={invertedRows}
          keyExtractor={keyExtractor}
          contentContainerStyle={styles.list}
          /*
            The ONLY thing that reacts to the content growing, and it is bounded three ways: it
            runs only while an arrival placement is outstanding, only a handful of times, and
            never once the reader has touched the list. The unbounded version of this - scroll to
            the end on every content size change - is the bug this screen was rebuilt to remove.
          */
          onContentSizeChange={() => {
            const target = pendingLandingRef.current;
            if (!target) return;
            if (landingAttemptsRef.current >= 8) {
              pendingLandingRef.current = null;
              return;
            }
            landingAttemptsRef.current += 1;
            placeAtTop(target);
          }}
          /*
            The reader takes over. From the first drag the screen stops trying to place them
            anywhere, permanently - an arrival that is still settling must never fight a finger.
          */
          onScrollBeginDrag={() => {
            pendingLandingRef.current = null;
          }}
          scrollEventThrottle={16}
          onScroll={(event) => {
            /*
              In an inverted list the offset is measured FROM THE BOTTOM, so this is the distance
              back into history directly - no arithmetic against a content height that is still
              growing, which is precisely what the old calculation got wrong.
            */
            const fromBottom = event.nativeEvent.contentOffset.y;
            /*
              Whether the reader is at the newest message, which decides both whether an arriving
              message counts as new and whether the control announcing them is shown. The
              threshold is deliberately not zero: a list settles a pixel or two off its own end
              after a layout pass, and "near enough" is what a reader experiences as being there.
            */
            const near = fromBottom <= TAIL_SLACK;
            setAtNewest((current) => (current === near ? current : near));
            /*
             * The strip fades once the reader has left the live tail.
             *
             * A pin is a shortcut back to something recent, so it earns its place over the
             * conversation while you are AT the conversation. Reading back through history it is
             * covering the thing you went looking for, so it gets out of the way and returns when
             * you come forward again.
             *
             * State rather than a ref, because this one has to re-render - and set only when it
             * actually flips, so a scroll does not re-render the screen on every frame.
             */
            const shouldShow = fromBottom <= PINNED_STRIP_FADE_AFTER;
            setPinnedStripVisible((visible) =>
              visible === shouldShow ? visible : shouldShow,
            );
          }}
          /*
            A row whose height has not been measured yet cannot be scrolled to, which is exactly the
            case a jump hits - the target is far from the tail. The list reports the failure instead
            of throwing, so the recovery is to scroll to the offset it managed and try the index
            again once that render has measured it.
          */
          onScrollToIndexFailed={(info) => {
            listRef.current?.scrollToOffset({
              offset: info.averageItemLength * info.index,
              animated: false,
            });
            setTimeout(() => {
              if (jumpedTo !== null) {
                listRef.current?.scrollToIndex({
                  index: info.index,
                  viewPosition: 0.5,
                  animated: false,
                });
              }
            }, 50);
          }}
          ListEmptyComponent={
            /*
              Flipped back upright. `inverted` is a `scaleY(-1)` on the list which each CELL
              undoes for itself - and the empty component is not a cell, so without this counter
              transform the empty state renders upside down.
            */
            <View style={[styles.empty, styles.unflip]}>
              <Text style={styles.emptyTitle}>No messages yet</Text>
              <Text style={styles.emptyBody}>
                Say something to get started.
              </Text>
            </View>
          }
          renderItem={renderRow}
        />
      )}

      {/*
        The attach menu. PRD/05 rule 11: Photos, Camera and Document for anybody who can post,
        plus the admin-gated create actions for whatever the scope supports.

        The two axes are independent and are kept independent here. `createActions` answers
        "what does this scope have" from the scope alone; `meta.canAnnounce` answers "may this
        person create things here" - one channel-admin question the server already resolved per
        scope, rather than three role rules restated in the client.
      */}
      {attachOpen && canPost && (
        <View style={styles.attachGrid}>
          {/*
            v1's grid of circular tiles, not a list of rows. Each is one tap and the icons carry
            the recognition, which is what makes "+" feel like a menu of things you can send
            rather than a settings list.

            Photos, Camera and Document are for anybody who can post. The create actions below
            them are gated on `canAnnounce` - one channel-admin question the server already
            resolves per scope - and on what the scope actually HAS. The two are independent:
            Event is club-only and Meeting is Eboard-only, and neither absence is a permission.
          */}
          {(
            [
              ["Photos", "photo-library", color.accent, pickPhoto, "photo"],
              ["Camera", "photo-camera", color.secondary, takePhoto, "photo"],
              ["Document", "insert-drive-file", color.tertiary, pickDocument, "document"],
            ] as const
          ).map(([label, icon, tint, pick, kind]) => (
            <Pressable
              key={label}
              style={styles.attachTile}
              onPress={() => void attach(pick, kind)}
              accessibilityRole="button"
              accessibilityLabel={label}
            >
              <View style={[styles.attachTileIcon, { backgroundColor: tint }]}>
                <MaterialIcons name={icon} size={24} color={color.onAccent} />
              </View>
              <Text style={styles.attachTileLabel}>{label}</Text>
            </Pressable>
          ))}

          {meta !== null &&
            meta.canAnnounce &&
            createActions(meta).map((action) => (
              <Pressable
                key={action.label}
                style={styles.attachTile}
                onPress={() => {
                  setAttachOpen(false);
                  router.push(action.href);
                }}
                accessibilityRole="button"
                accessibilityLabel={action.label}
              >
                <View style={[styles.attachTileIcon, { backgroundColor: action.tint }]}>
                  <MaterialIcons name={action.icon} size={24} color={color.onAccent} />
                </View>
                <Text style={styles.attachTileLabel}>{action.label}</Text>
              </Pressable>
            ))}
        </View>
      )}

      {/*
        The long-press overlay.

        > **Rendered at screen level, not inside the message row.** The row lives in a FlatList
        > cell that clips its children and scrolls with the list, so a menu drawn there is cut off
        > at the cell boundary and slides away under a finger. Lifting it out is what lets the
        > backdrop cover the conversation and the message float above it.
        >
        > It also means exactly one of these exists rather than one per row.
      */}
      {selectedMessage !== null &&
        confirmingDelete === null &&
        confirmingReport === null && (
          <MessageActions
            message={selectedMessage}
            mine={selectedMessage.senderId === userId}
            canPin={meta?.canPin === true}
            canReport={meta?.canReport === true}
            canDelete={
              selectedMessage.senderId === userId || meta?.canDeleteAnyMessage === true
            }
            onDismiss={() => setSelected(null)}
            onReact={(emoji) => {
              setSelected(null);
              void react(selectedMessage.seq, emoji);
            }}
            onReply={() => {
              setReplyingToSeq(selectedMessage.seq);
              setSelected(null);
            }}
            onCopy={() => {
              void Clipboard.setStringAsync(selectedMessage.body ?? "");
              setSelected(null);
            }}
            onPin={() => {
              void setPinned(selectedMessage.seq, !selectedMessage.pinned);
              setSelected(null);
            }}
            onReport={() => setConfirmingReport(selectedMessage.seq)}
            onDelete={() => setConfirmingDelete(selectedMessage.seq)}
          />
        )}

      {/*
        Delete, as a centred dialog rather than a row in the conversation.

        It used to render inline where the message sat, which pushed the surrounding messages
        around at the exact moment somebody is deciding something irreversible - and on a long
        chat it could land off screen entirely. A dialog stops the world, which is the right
        weight for the one action here that cannot be undone.
      */}
      {confirmingDelete !== null && (
        <View style={styles.dialogBackdrop}>
          <Pressable
            style={StyleSheet.absoluteFill}
            onPress={() => {
              setConfirmingDelete(null);
              setSelected(null);
            }}
            accessibilityRole="button"
            accessibilityLabel="Keep this message"
          />
          <View style={styles.dialog}>
            <Text style={styles.dialogTitle}>Delete Message</Text>
            {/* Names what happens and does not pretend it can be undone. */}
            <Text style={styles.dialogBody}>
              This message will be removed for everyone in this chat. It is replaced by "This
              message was deleted" and cannot be brought back.
            </Text>
            <View style={styles.dialogActions}>
              <Pressable
                style={styles.dialogButton}
                onPress={() => {
                  setConfirmingDelete(null);
                  setSelected(null);
                }}
                accessibilityRole="button"
                accessibilityLabel="No, keep this message"
              >
                <Text style={styles.dialogButtonLabel}>No</Text>
              </Pressable>
              <Pressable
                style={styles.dialogButton}
                onPress={() => void removeMessage(confirmingDelete)}
                accessibilityRole="button"
                accessibilityLabel="Yes, delete this message"
              >
                <Text style={[styles.dialogButtonLabel, styles.destructive]}>Yes</Text>
              </Pressable>
            </View>
          </View>
        </View>
      )}

      {/*
        Report, as the same centred dialog delete uses.

        It used to render inline in the conversation, where the message sat, which is the shape
        delete was moved out of for the same two reasons: it pushed the surrounding messages
        around while somebody was deciding, and on a long chat the message being reported could
        be anywhere - including off screen behind the thing asking about it.
      */}
      {confirmingReport !== null && (
        <View style={styles.dialogBackdrop}>
          <Pressable
            style={StyleSheet.absoluteFill}
            onPress={() => {
              setConfirmingReport(null);
              setSelected(null);
            }}
            accessibilityRole="button"
            accessibilityLabel="Cancel reporting"
          />
          <View style={styles.dialog}>
            <Text style={styles.dialogTitle}>Report a concern</Text>
            <Text style={styles.dialogBody}>
              {meta?.scope === "dm"
                ? // No club admin ever sees the contents of a DM, so say where it actually goes.
                  "This message goes to ClubChat moderators, who can read the messages around it. The other person is not told."
                : "This message goes to the admins of this space, who can read the messages around it. The sender is not told."}
            </Text>
            <View style={styles.dialogActions}>
              <Pressable
                style={styles.dialogButton}
                onPress={() => {
                  setConfirmingReport(null);
                  setSelected(null);
                }}
                accessibilityRole="button"
                accessibilityLabel="Cancel reporting"
              >
                <Text style={styles.dialogButtonLabel}>Cancel</Text>
              </Pressable>
              <Pressable
                style={styles.dialogButton}
                onPress={() => void reportMessage(confirmingReport)}
                accessibilityRole="button"
                accessibilityLabel="Confirm report"
              >
                <Text style={[styles.dialogButtonLabel, styles.destructive]}>Report</Text>
              </Pressable>
            </View>
          </View>
        </View>
      )}

      {/*
        A photo, full screen.

        Last in the tree and absolutely positioned, so it covers the conversation, the pinned
        strip and the composer rather than appearing inside them. The same component the gallery
        uses - the only difference is that this one's first menu item is Reply, because here you
        are already in the conversation the photo was posted in.
      */}
      {viewingPhoto !== null && viewingPhoto.mediaId !== null && (
        <PhotoViewer
          mediaId={viewingPhoto.mediaId}
          senderName={viewingPhoto.senderName}
          senderImage={viewingPhoto.senderImage}
          takenAt={viewingPhoto.createdAt}
          contextAction={{
            label: "Reply",
            icon: "reply",
            onPress: () => {
              setReplyingToSeq(viewingPhoto.seq);
              setViewingPhoto(null);
            },
          }}
          {...(viewingPhoto.senderId !== userId && meta?.canReport === true
            ? {
                report: {
                  body:
                    meta?.scope === "dm"
                      ? // No club admin ever sees the contents of a DM, so say where it goes.
                        "This photo goes to ClubChat moderators, who can read the messages around it. The other person is not told."
                      : "This photo goes to the admins of this space, who can read the messages around it. The sender is not told.",
                  run: async () => {
                    const result = await channelApi.report(channelId!, viewingPhoto.seq);
                    return result.alreadyReported
                      ? "You already reported this photo."
                      : "Reported. The sender is not told.";
                  },
                },
              }
            : {})}
          onClose={() => setViewingPhoto(null)}
        />
      )}

      {/*
        The `@` list, sitting directly above the composer.

        Rendered only while a mention is being typed, and only when something matches - an empty
        panel hovering over the conversation is worse than no panel. It is a plain View rather
        than a modal so the keyboard stays up and typing keeps narrowing it.
      */}
      {canPost && mentionMatches.length > 0 && (
        <View style={styles.mentionBar}>
          <ScrollView
            keyboardShouldPersistTaps="always"
            showsVerticalScrollIndicator={false}
          >
            {mentionMatches.map((member) => (
              <Pressable
                key={member.userId}
                style={styles.mentionRow}
                onPress={() => pickMention(member)}
                accessibilityRole="button"
                accessibilityLabel={`Mention ${member.name}`}
              >
                <Avatar name={member.name} image={member.image} size={28} />
                <Text style={styles.mentionName}>{member.name}</Text>
              </Pressable>
            ))}
          </ScrollView>
        </View>
      )}

      {/*
        "3 new messages", while the reader is back in history.

        > **This is the whole reason arriving messages no longer move anybody.** Being yanked to
        > the bottom mid-sentence is the failure; being told, and choosing, is the fix. So the
        > conversation stays exactly where it is and this appears instead.

        Tapping lands on the FIRST of them rather than the newest, so the reader reads forward
        through what they missed instead of arriving after it and scrolling back up. The count
        then clears: they have been taken to where the new messages start, and leaving it up
        would have it follow them down the screen saying the same thing.
      */}
      {!atNewest && newSinceSeen > 0 && (
        <Pressable
          style={styles.newMessages}
          onPress={() => {
            placeAtTop(
              rows.find(
                (row) => row.kind === "message" && row.message.seq > seenThrough,
              ),
            );
            setSeenThrough(newestSeq);
          }}
          accessibilityRole="button"
          accessibilityLabel={
            newSinceSeen === 1
              ? "1 new message. Go to it"
              : `${newSinceSeen} new messages. Go to the first one`
          }
        >
          <MaterialIcons name="arrow-downward" size={16} color={color.onAccent} />
          <Text style={styles.newMessagesLabel}>
            {newSinceSeen === 1 ? "1 new message" : `${newSinceSeen} new messages`}
          </Text>
        </Pressable>
      )}

      {/*
        The quote sitting over the composer while a reply is being written.

        Directly above the input rather than inside it, so it reads as context for what is being
        typed and has room for the same box the bubble will eventually draw. It carries its own
        cancel, because arming a reply by long-pressing is easy to do by accident and a reply you
        cannot get out of is worse than no reply at all.
      */}
      {canPost && replyingTo !== null && (
        <View style={styles.replyBar}>
          <View style={styles.replyBarQuote}>
            <QuotedMessage
              quote={quoteOf(replyingTo)}
              mine={false}
              // Tapping the quote here would scroll the conversation out from under the
              // composer mid-sentence. In the bubble it is a jump; here it is just context.
              onJump={() => undefined}
            />
          </View>
          <Pressable
            onPress={() => setReplyingToSeq(null)}
            accessibilityRole="button"
            accessibilityLabel="Cancel this reply"
            hitSlop={space.sm}
            style={styles.replyBarCancel}
          >
            <MaterialIcons name="close" size={18} color={color.textSecondary} />
          </Pressable>
        </View>
      )}

      {canPost ? (
        <View style={styles.composer}>
          {/*
            The "+". Disabled while bytes are in flight rather than hidden, so a second tap
            cannot start a concurrent upload and the reason is visible.
          */}
          <Pressable
            style={[styles.attachButton, uploading && styles.sendDisabled]}
            onPress={() => setAttachOpen((open) => !open)}
            disabled={uploading}
            accessibilityRole="button"
            accessibilityLabel={
              uploading ? "Uploading an attachment" : "Attach a photo or file"
            }
          >
            {uploading ? (
              <ActivityIndicator color={color.accent} />
            ) : (
              <Text style={styles.attachLabel}>+</Text>
            )}
          </Pressable>
          <TextInput
            style={styles.input}
            placeholder={asAnnouncement ? "Announcement" : "Message"}
            placeholderTextColor={color.textSecondary}
            value={draft}
            onChangeText={setDraft}
            /*
              The caret drives the `@` list, so it has to be tracked rather than assumed to be at
              the end - somebody editing a name in the middle of a finished sentence is exactly
              when the list is most useful.
            */
            onSelectionChange={(event) =>
              setCaret(event.nativeEvent.selection.end)
            }
            multiline
            accessibilityLabel={asAnnouncement ? "Announcement" : "Message"}
            onSubmitEditing={() => void send()}
          />
          {/*
            The announcement toggle, for an admin of this space.

            A compact armed control rather than a persistent banner, which is what v1 landed on
            after the banner ate the top of the conversation. The filled state is the whole
            signal that the next send notifies everybody, so it has to be unmistakable - an
            announcement posted by accident cannot be recalled.
          */}
          {meta?.canAnnounce === true && (
            <Pressable
              style={[
                styles.announceButton,
                asAnnouncement && styles.announceButtonArmed,
              ]}
              onPress={() => setAsAnnouncement((armed) => !armed)}
              accessibilityRole="button"
              accessibilityState={{ selected: asAnnouncement }}
              accessibilityLabel={
                asAnnouncement
                  ? "Send as an announcement, on. This notifies everybody here"
                  : "Send as an announcement, off"
              }
            >
              <MaterialIcons
                name="campaign"
                size={20}
                color={asAnnouncement ? color.onAccent : color.textSecondary}
              />
            </Pressable>
          )}
          <Pressable
            style={[
              styles.sendButton,
              draft.trim().length === 0 && styles.sendDisabled,
            ]}
            onPress={() => void send()}
            disabled={draft.trim().length === 0}
            accessibilityRole="button"
            accessibilityLabel="Send message"
          >
            <Text style={styles.sendLabel}>Send</Text>
          </Pressable>
        </View>
      ) : (
        /*
          A disabled composer that STATES ITS REASON, rather than an input that silently
          rejects. History above is fully readable, which is the point: blocking and losing the
          last shared club both make a thread read-only rather than deleting it.
        */
        <View style={styles.composerDisabled}>
          <Text style={styles.composerDisabledText}>
            {DENIED_TEXT[meta?.postDeniedReason ?? "unavailable"]}
          </Text>
        </View>
      )}
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  /**
   * The row a jump landed on.
   *
   * v1's treatment: a brief tinted wash behind the whole row rather than a rule beside it, so the
   * eye lands on the message itself. `secondaryContainer` at 50/255 alpha, which is v1's own value.
   */
  jumpTarget: {
    backgroundColor: color.secondaryContainer + "50",
    borderRadius: radius.lg,
    marginHorizontal: -space.sm,
    paddingHorizontal: space.sm,
    paddingVertical: space.xs,
  },
  flex: { flex: 1, backgroundColor: color.appBackground },
  centered: { flex: 1, alignItems: "center", justifyContent: "center" },
  list: {
    padding: space.md,
    gap: space.sm,
    /*
     * No `flexGrow` and no `justifyContent` here, and their absence is deliberate.
     *
     * They existed to anchor a short conversation to the bottom rather than leaving it stranded
     * under a screen of empty space. An inverted list does that by construction - its content
     * starts at the visual bottom and grows upward - and `justifyContent: 'flex-end'` inside a
     * flipped container means the visual TOP, which put a two-message chat back under the header
     * with the gap beneath it.
     */
  },
  /** Undo the list's `scaleY(-1)` for a child that is not a cell. See `ListEmptyComponent`. */
  unflip: { transform: [{ scaleY: -1 }] },

  /*
   * The "N new messages" control.
   *
   * Sits just above the composer and centred, so it reads as belonging to the conversation
   * rather than to the chrome, and lands under the thumb on a phone. Deliberately small and
   * filled: it has to be noticeable enough to answer "did I miss something" at a glance without
   * competing with the messages themselves, which are what the reader is actually here for.
   */
  newMessages: {
    position: "absolute",
    bottom: 84,
    alignSelf: "center",
    flexDirection: "row",
    alignItems: "center",
    gap: space.xs,
    paddingVertical: space.xs + 2,
    paddingHorizontal: space.md,
    borderRadius: radius.pill,
    backgroundColor: color.accent,
    zIndex: 20,
    shadowColor: "#000",
    shadowOpacity: 0.18,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 4 },
    elevation: 4,
  },
  newMessagesLabel: { ...type.label, color: color.onAccent, textTransform: "none" },
  empty: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: space.sm,
  },
  emptyTitle: { ...type.title, color: color.textPrimary },
  emptyBody: { ...type.bodySmall, color: color.textSecondary },
  // v1's bubble metrics, verbatim: 82% max width, 12px padding, and one small corner per bubble
  // where its tail would be. The sent bubble carries no backgroundColor because its fill is the
  // gradient in BubbleContainer.
  bubble: { padding: space.sm + 4, gap: space.xs },
  /*
   * v1's announcement card, which is deliberately not a bubble.
   *
   * Full width and unsided, because an announcement is addressed to the room rather than said to
   * it - so there is no avatar and no mine/theirs distinction. The left border and the accent bar
   * beside the headline are what carry "this is different" at a glance down a scrolling list; the
   * oversized INFO is clipped texture rather than a label anyone is meant to read.
   */
  announcementWrap: { alignItems: "center", paddingHorizontal: space.sm, paddingVertical: space.xs },
  announcementCard: {
    width: "100%",
    maxWidth: 420,
    backgroundColor: color.card,
    borderLeftWidth: 4,
    borderLeftColor: color.accent,
    borderRadius: radius.lg,
    padding: space.md,
    overflow: "hidden",
    shadowColor: "#000",
    shadowOpacity: 0.1,
    shadowRadius: 20,
    shadowOffset: { width: 0, height: 8 },
    elevation: 3,
  },
  announcementWatermark: {
    position: "absolute",
    right: -10,
    bottom: -20,
    ...type.display,
    fontSize: 80,
    lineHeight: 88,
    color: "rgba(255,77,0,0.05)",
  },
  announcementHeadlineRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm,
    marginBottom: space.sm,
  },
  announcementAccentBar: { width: 4, height: 28, backgroundColor: color.accent },
  announcementHeadline: {
    ...type.headline,
    fontSize: 18,
    color: color.textPrimary,
    textTransform: "uppercase",
    fontStyle: "italic",
    flexShrink: 1,
  },
  announcementSender: { ...type.bodySmall, fontSize: 13, color: color.textSecondary },
  announcementTime: { ...type.bodySmall, fontSize: 11, color: color.textSecondary },

  /*
   * A mention, in somebody else's bubble and in your own.
   *
   * Two styles because your own bubble is filled with the accent, so accent-on-accent would be
   * invisible. There it goes semibold and opaque white against the tint instead - the same "this
   * is a person, not prose" signal carried by weight rather than by colour.
   */
  mentionInTheirs: { color: color.accent, fontFamily: fontFamily.bodyBold },
  mentionInMine: { color: color.onAccent, fontFamily: fontFamily.bodyBold },

  /*
   * The quote box, inside the bubble of the reply that carries it.
   *
   * A tinted block with an accent rule down its left edge, which is the shape every messenger
   * uses for this and the reason it reads as quoted rather than as the message's own first line.
   * Two variants because a sent bubble is filled with the accent: a light block would vanish into
   * it, so there the block is translucent white and the rule is white too.
   */
  quote: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm,
    borderRadius: radius.sm,
    padding: space.xs + 2,
    marginBottom: space.xs,
    overflow: "hidden",
    /*
     * Full bubble width, not the width of the quoted text.
     *
     * Sized to its content it stopped wherever the preview happened to end - which, against a
     * tinted block with a clipped corner, reads as a box that has been cut off rather than one
     * that is simply short. Stretching costs nothing and is what every messenger does.
     */
    alignSelf: "stretch",
  },
  quoteTheirs: { backgroundColor: color.appBackground },
  quoteMine: { backgroundColor: "rgba(255,255,255,0.18)" },
  quoteBar: {
    alignSelf: "stretch",
    width: 3,
    minHeight: 28,
    borderRadius: radius.pill,
    backgroundColor: color.accent,
  },
  quoteBarMine: { backgroundColor: color.onAccent },
  quoteThumb: { width: 32, height: 32, borderRadius: radius.xs },
  quoteDocIcon: {
    width: 32,
    height: 32,
    borderRadius: radius.xs,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: color.card,
  },
  // `flex: 1` with `minWidth: 0`: the column takes whatever is left after the rule and any
  // thumbnail, and the zero minimum is what lets a long preview wrap and ellipsize inside it
  // rather than forcing the row wider than the bubble.
  quoteColumn: { flex: 1, minWidth: 0, gap: 1 },
  quoteSender: { ...type.label, fontSize: 10, color: color.accent },
  quoteSenderMine: { color: color.onAccent, opacity: 0.9 },
  quotePreview: { ...type.bodySmall, fontSize: 12, color: color.textSecondary },
  quotePreviewMine: { color: color.onAccent, opacity: 0.85 },
  quoteDeleted: { fontStyle: "italic" },

  /*
   * The reply bar over the composer. Same chrome as the `@` list below it, so the two stack as
   * one surface attached to the input rather than as two floating panels.
   */
  replyBar: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm,
    paddingHorizontal: space.sm,
    paddingTop: space.sm,
    backgroundColor: color.chrome,
    borderTopWidth: 1,
    borderTopColor: color.divider,
  },
  replyBarQuote: { flex: 1 },
  replyBarCancel: { padding: space.xs },

  /*
   * The `@` list. Capped in height so a big club cannot cover the conversation, and anchored to
   * the composer rather than floating, so it reads as part of what is being typed.
   */
  mentionBar: {
    maxHeight: 200,
    backgroundColor: color.chrome,
    borderTopWidth: 1,
    borderTopColor: color.divider,
    paddingHorizontal: space.sm,
  },
  mentionRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm + 2,
    paddingVertical: space.sm,
    paddingHorizontal: space.sm,
  },
  mentionName: { ...type.body, color: color.textPrimary },

  /*
   * The long-press overlay.
   *
   * Covers the whole screen including the composer and the header, which is deliberate: while the
   * menu is open the conversation is not interactive, and a header still tappable behind a blur
   * invites a tap that dismisses nothing.
   */
  overlay: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    zIndex: 50,
    justifyContent: "center",
  },
  overlayContent: { padding: space.md, gap: space.sm, alignItems: "center" },
  overlayEmojiBar: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.xs,
    backgroundColor: color.card,
    borderRadius: radius.pill,
    paddingHorizontal: space.sm,
    paddingVertical: space.sm,
    shadowColor: "#000",
    shadowOpacity: 0.12,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 6 },
    elevation: 4,
  },
  overlayEmojiButton: {
    width: 44,
    height: 44,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radius.pill,
  },
  overlayBubble: {
    alignSelf: "flex-start",
    maxWidth: "88%",
    backgroundColor: color.card,
    borderRadius: radius.lg,
    padding: space.md,
    gap: space.xs,
  },
  overlayBubbleMine: { alignSelf: "flex-end", backgroundColor: color.accent },
  overlayBubbleSender: { ...type.label, color: color.textSecondary, textTransform: "none" },
  overlayBubbleBody: { ...type.body, color: color.textPrimary },
  overlayMenu: {
    width: "100%",
    maxWidth: 340,
    backgroundColor: color.card,
    borderRadius: radius.lg,
    overflow: "hidden",
    shadowColor: "#000",
    shadowOpacity: 0.12,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 6 },
    elevation: 4,
  },
  overlayMenuItem: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: space.md,
    paddingVertical: space.md,
  },
  overlayMenuItemDivided: { borderTopWidth: 1, borderTopColor: color.cardSunken },
  overlayMenuLabel: { ...type.body, color: color.textPrimary },

  /* A centred confirmation, for the one action in chat that cannot be undone. */
  dialogBackdrop: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    zIndex: 60,
    alignItems: "center",
    justifyContent: "center",
    padding: space.lg,
    backgroundColor: "rgba(0,0,0,0.35)",
  },
  dialog: {
    width: "100%",
    maxWidth: 320,
    backgroundColor: color.card,
    borderRadius: radius.xl,
    padding: space.lg,
    gap: space.sm,
  },
  dialogTitle: { ...type.headline, fontSize: 20, color: color.textPrimary },
  dialogBody: { ...type.body, color: color.textSecondary },
  dialogActions: { flexDirection: "row", gap: space.sm, marginTop: space.sm },
  dialogButton: {
    flex: 1,
    alignItems: "center",
    paddingVertical: space.sm + 4,
    borderRadius: radius.pill,
    backgroundColor: color.cardSunken,
  },
  dialogButtonLabel: { ...type.headline, color: color.textPrimary },

  /**
   * v1's message row: avatar and bubble side by side, bottom-aligned so the avatar sits level
   * with the last line of a multi-line bubble rather than floating beside its first.
   *
   * `messageRowMine` only sets `justifyContent`. It deliberately does NOT reverse the direction,
   * so your own avatar stays to the left of your own bubble and the pair moves right as a unit -
   * v1's arrangement, and the reason the bubble wrappers below no longer need `alignSelf`.
   */
  messageRow: {
    flexDirection: "row",
    alignItems: "flex-end",
    gap: space.sm,
    marginBottom: space.xs,
    /*
     * Wraps, so the reaction row drops BELOW the bubble instead of beside it.
     *
     * This row is a horizontal flex of avatar-then-bubble, and the pill row is its third child -
     * so without wrapping it became a third column and the pills sat out to the side of the
     * message, which reads as unrelated to it. Giving the pill row a full-width basis pushes it
     * onto its own line under both.
     */
    flexWrap: "wrap",
  },
  messageRowMine: { justifyContent: "flex-end" },
  avatarSpacer: { width: 32, height: 32 },
  /** v1's treatment: 10px Inter in the accent colour, above the body. */
  senderName: { ...type.label, fontSize: 10, color: color.accent },
  /** The same label on your own bubble, over the accent fill rather than under it. */
  senderNameMine: {
    ...type.label,
    fontSize: 10,
    color: color.onAccent,
    opacity: 0.85,
  },
  bubbleHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.xs,
    marginBottom: space.xs,
  },
  bubbleWrapMine: { maxWidth: "82%" },
  bubbleWrapTheirs: { maxWidth: "82%" },
  sent: {
    borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg,
    borderBottomLeftRadius: radius.xs,
    borderBottomRightRadius: radius.lg,
  },
  received: {
    backgroundColor: "rgba(255,255,255,0.9)",
    borderWidth: 1,
    borderColor: "rgba(0,0,0,0.05)",
    borderTopLeftRadius: radius.xs,
    borderTopRightRadius: radius.lg,
    borderBottomLeftRadius: radius.lg,
    borderBottomRightRadius: radius.lg,
  },
  pending: { opacity: 0.6 },
  pendingLabel: { ...type.label, color: color.onAccent },
  failed: {
    ...type.label,
    color: color.onAccent,
    textDecorationLine: "underline",
  },
  sentText: { ...type.body, fontSize: 15, color: color.onAccent },
  receivedText: { ...type.body, fontSize: 15, color: color.textPrimary },
  sentMeta: { ...type.label, color: color.onAccent, opacity: 0.8 },
  receivedMeta: { ...type.label, color: color.textSecondary },
  systemRow: { alignItems: "center", paddingVertical: space.xs },
  /*
    The "Last read" rule: a line through the conversation with the label sitting in it.

    In the accent rather than in a neutral, and that is the point of it - it is the one horizontal
    line in the conversation that means something, and a grey rule between two messages reads as a
    separator rather than as a place. It gets more vertical room than a system line for the same
    reason: it is a boundary between two states of the conversation, not a remark inside it.
  */
  lastReadRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm,
    paddingHorizontal: space.md,
    paddingVertical: space.sm + 2,
  },
  lastReadRule: { flex: 1, height: 1, backgroundColor: color.accent },
  lastReadLabel: { ...type.label, color: color.accent, textTransform: "none" },
  /*
    A day heading: a centred chip, not a full-width rule.

    Deliberately quieter than the "Last read" line above, and the contrast is the point - a date
    tells you where you are in the conversation, where the rule tells you where to start reading.
    Two full-width lines in the same list would compete, and the one that matters would lose.
  */
  dayRow: { alignItems: "center", paddingVertical: space.sm },
  dayLabel: {
    ...type.label,
    color: color.textSecondary,
    textTransform: "none",
    backgroundColor: color.cardSunken,
    borderRadius: radius.pill,
    paddingHorizontal: space.sm + 4,
    paddingVertical: space.xs,
    overflow: "hidden",
  },
  /* Full width under the sentence, so the options are real targets rather than a preview. */
  cardWrap: { alignSelf: "stretch", paddingHorizontal: space.md, paddingTop: space.sm },
  cardMenu: { alignSelf: "flex-end", paddingTop: space.xs, paddingHorizontal: space.xs },
  systemText: {
    ...type.bodySmall,
    color: color.textSecondary,
    textAlign: "center",
  },
  tombstone: {
    ...type.bodySmall,
    color: color.textSecondary,
    fontStyle: "italic",
    textAlign: "center",
  },
  composer: {
    flexDirection: "row",
    alignItems: "flex-end",
    gap: space.sm,
    padding: space.sm,
    backgroundColor: color.chrome,
    borderTopWidth: 1,
    borderTopColor: color.divider,
  },
  composerDisabled: {
    padding: space.md,
    backgroundColor: color.chrome,
    borderTopWidth: 1,
    borderTopColor: color.divider,
    alignItems: "center",
  },
  composerDisabledText: {
    ...type.bodySmall,
    color: color.textSecondary,
    textAlign: "center",
  },
  input: {
    flex: 1,
    maxHeight: 120,
    backgroundColor: color.card,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: color.divider,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    ...type.body,
    color: color.textPrimary,
  },
  sendButton: {
    backgroundColor: color.accent,
    borderRadius: radius.md,
    paddingHorizontal: space.md,
    paddingVertical: space.md,
  },
  sendDisabled: { opacity: 0.4 },
  attachButton: {
    width: 44,
    height: 44,
    borderRadius: radius.pill,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: color.card,
    borderWidth: 1,
    borderColor: color.divider,
  },
  // Same footprint as the "+", so the composer's two flanking controls line up.
  announceButton: {
    width: 44,
    height: 44,
    borderRadius: radius.pill,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: color.card,
    borderWidth: 1,
    borderColor: color.divider,
  },
  announceButtonArmed: {
    backgroundColor: color.accent,
    borderColor: color.accent,
  },
  // Optically centred: the glyph's own line height sits high in the box.
  attachLabel: {
    fontSize: 24,
    lineHeight: 28,
    color: color.accent,
    marginTop: -2,
  },
  sendLabel: {
    ...type.label,
    color: color.onAccent,
    textTransform: "uppercase",
  },
  /**
   * v1's glass header.
   *
   * The blur is the point: it is what separates chat from the flat chrome every other screen
   * uses, and v1 leans on it hard. Kept IN FLOW rather than absolutely positioned as v1 has it -
   * v1's list is inverted, so its content padding falls at the visual top for free, and getting
   * the same effect here would mean padding the list and the quick-nav around a floating element
   * for a difference visible only while scrolling.
   *
   * `backgroundColor` still carries the chrome tint, because react-native-web renders BlurView as
   * a plain View: without it this reads as a transparent strip on the surface it develops on.
   */
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    backgroundColor: color.chrome,
    borderBottomWidth: 1,
    borderBottomColor: "rgba(0,0,0,0.05)",
  },
  /** v1's circular back control: 36px, a faint wash, and an icon rather than a word. */
  backButton: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(0,0,0,0.05)",
  },
  // Same footprint as the avatar, so the row does not jump when the real one replaces it.
  headerAvatarPlaceholder: {
    width: 36,
    height: 36,
    borderRadius: radius.pill,
    backgroundColor: color.cardSunken,
  },
  headerTitleColumn: { flex: 1, minWidth: 0 },
  /*
   * The accent, matching the club's identity everywhere outside chat.
   *
   * A conversation's name is the same kind of thing as the club name in every other header - the
   * subject of the screen - so it wears the same colour. Rendering it in body black made chat the
   * one place the product's own title stopped looking like a title.
   */
  headerTitle: { ...type.headerTitle, color: color.accent },
  /** 9px, v1's value. Doubles as the connection state, which chat is the one screen to care. */
  headerSubtitle: { ...type.label, fontSize: 9, color: color.textSecondary },
  attachGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: space.md,
    padding: space.md,
    backgroundColor: color.chrome,
    borderTopWidth: 1,
    borderTopColor: color.divider,
  },
  attachTile: { alignItems: 'center', gap: space.xs, width: 72 },
  attachTileIcon: {
    width: 56,
    height: 56,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
  },
  attachTileLabel: { ...type.bodySmall, color: color.textPrimary },

  highlightsPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.xs,
    backgroundColor: color.accent,
    borderRadius: radius.pill,
    paddingHorizontal: space.sm + 4,
    paddingVertical: space.xs + 2,
  },
  highlightsPillLabel: { ...type.label, color: color.onAccent, textTransform: 'none' },

  // Full-bleed, so a tap anywhere outside the card closes it.
  gridScrim: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, zIndex: 60 },
  /** `top` is supplied at render from the measured header, and is not optional - see the note there. */
  gridMenu: {
    position: 'absolute',
    right: space.md,
    zIndex: 61,
    backgroundColor: color.card,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: color.hairline,
    paddingVertical: space.sm,
    minWidth: 220,
  },
  gridRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingHorizontal: space.md,
    paddingVertical: space.sm + 2,
  },
  gridRowLabel: { ...type.body, color: color.textPrimary },

  headerAction: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(0,0,0,0.05)",
  },
  /** v1's pinned notice strip. `flexGrow: 0` keeps the row from claiming the list's height. */
  pinnedStrip: {
    flexGrow: 0,
    paddingHorizontal: space.md,
    paddingTop: space.sm,
  },
  /* Faded rather than unmounted, so it returns without the strip jumping back into layout. */
  pinnedStripFaded: { opacity: 0 },
  pinnedStripContent: { gap: space.sm, alignItems: "center" },
  pinnedCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm,
    width: 300,
    borderRadius: radius.lg,
    padding: space.sm + 4,
    borderWidth: 1,
    // v1's value: the accent at 15% alpha, so the card reads as a notice without shouting.
    borderColor: "rgba(255,77,0,0.15)",
    backgroundColor: color.card,
    overflow: "hidden",
  },
  pinnedCardBody: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm,
  },
  pinnedIcon: {
    width: 32,
    height: 32,
    borderRadius: radius.sm,
    backgroundColor: "rgba(255,77,0,0.1)",
    alignItems: "center",
    justifyContent: "center",
  },
  pinnedTextColumn: { flex: 1 },
  pinnedLabel: { ...type.label, fontSize: 9, color: color.accent },
  pinnedText: { ...type.body, fontSize: 12, color: color.textPrimary },
  pinnedDismiss: { padding: space.xs },
  offlineBanner: {
    backgroundColor: color.fallback,
    paddingVertical: space.sm,
    paddingHorizontal: space.md,
    alignItems: "center",
  },
  offlineText: {
    ...type.label,
    color: color.textSecondary,
    textTransform: "uppercase",
  },
  sheet: {
    backgroundColor: color.card,
    borderBottomWidth: 1,
    borderBottomColor: color.divider,
  },
  sheetRow: {
    paddingHorizontal: space.md,
    paddingVertical: space.md,
    gap: space.xs,
    borderBottomWidth: 1,
    borderBottomColor: color.divider,
  },
  sheetLabel: { ...type.body, color: color.textPrimary },
  sheetHint: { ...type.bodySmall, color: color.textSecondary },
  destructive: { color: color.error },
  notice: {
    backgroundColor: color.fallback,
    paddingVertical: space.sm,
    paddingHorizontal: space.md,
  },
  noticeText: {
    ...type.bodySmall,
    color: color.textPrimary,
    textAlign: "center",
  },
  emojiGlyph: { fontSize: 24, lineHeight: 30 },
  pillRow: {
    flexDirection: "row",
    gap: space.xs,
    flexWrap: "wrap",
    marginTop: -space.xs,
    // Full width is what makes the wrapping row above break BEFORE this, putting the pills on
    // their own line rather than alongside the bubble.
    width: "100%",
  },
  /*
   * Aligned under the bubble they belong to, on whichever side it sits. `justifyContent` rather
   * than `alignSelf`, because at full width there is no free space for `alignSelf` to move into.
   * Theirs is inset past the avatar so the pills line up with the bubble's left edge, not the
   * avatar's.
   */
  pillRowMine: { justifyContent: "flex-end" },
  pillRowTheirs: { justifyContent: "flex-start", paddingLeft: 32 + space.sm },
  pill: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.xs,
    paddingHorizontal: space.sm,
    paddingVertical: space.xs,
    borderRadius: radius.pill,
    backgroundColor: color.card,
    borderWidth: 1,
    borderColor: color.divider,
  },
  // The viewer's own reaction is outlined in the accent, so "did I react" is visible without
  // counting or tapping.
  pillMine: { borderColor: color.accent, backgroundColor: color.appBackground },
  pillEmoji: { fontSize: 14, lineHeight: 18 },
  pillCount: { ...type.label, color: color.textSecondary },
  pillCountMine: { color: color.accent },
});
