import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Animated,
  Dimensions,
  FlatList,
  Keyboard,
  LayoutAnimation,
  Platform,
  Pressable,
  Modal,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import { Redirect, useLocalSearchParams, useRouter } from "expo-router";
import { useDeclareSpace } from "../../src/current-space.tsx";
import {
  quoteOf,
  quickReactions,
  reactionSummary,
  VISIBLE_REACTION_PILLS,
  SYSTEM_ACTOR_ID,
  type MessageEnvelope,
  type MessageReaction,
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
import { channelApi, dmApi, pollApi, type ChannelMeta } from "../../src/api.ts";
import { DocumentBubble, PhotoBubble, RemoteImage } from "../../src/media-bubble.tsx";
import { PhotoViewer } from "../../src/photo-viewer.tsx";
import {
  pickDocument,
  pickPhoto,
  takePhoto,
  uploadAttachment,
  UploadError,
  type PickedAttachment,
} from "../../src/upload.ts";
import * as Clipboard from "expo-clipboard";
import { BlurView } from "expo-blur";
import { longPressFeedback } from "../../src/haptics.ts";
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
import { Avatar, Tabs, useRisingSheet } from "../../src/ui.tsx";
import { ChatEventCard } from "../../src/screens/events.tsx";
import { ChatMeetingCard } from "../../src/screens/meetings.tsx";
import { ChatPollCard } from "../../src/screens/polls.tsx";
import { EmojiPicker } from "../../src/emoji-picker.tsx";
import { spaceProfileHref, useGoBack } from "../../src/nav.tsx";
import { useLoad } from "../../src/use-load.ts";
import { KeyboardAvoider } from "../../src/keyboard-avoider.tsx";
import { hrefForCard } from "../../src/notification-href.ts";
import { color, fontFamily, radius, space, type } from "../../src/theme.ts";

/**
 * How many pinned notices hang above the conversation.
 *
 * A window on the most recent, not the whole pin list - everything pinned stays in Highlights.
 * Four fits the strip without it becoming a second scrolling list on top of the first.
 */
const PINNED_STRIP_LIMIT = 4;

/**
 * How far the finger must travel before the pinned strip reacts, in points.
 *
 * > **This replaced a distance from the tail, and the two answer different questions.** The old
 * > rule showed the strip while the reader was within 400pt of the newest message, which meant a
 * > reader 3,000pt back in history could flick downward and see nothing happen - the strip only
 * > returned after 2,600pt of travel. Nothing about that number was tunable, because the number
 * > was not the problem: "are you near the bottom" is not the question a reader is asking. The
 * > question is **"am I moving away from the conversation, or back toward it"**, and that is a
 * > direction rather than a position.
 *
 * Small enough that a deliberate nudge registers immediately, large enough that a finger wobble
 * or the rubber-band bounce at the end of the list does not flip it back and forth.
 */
const PINNED_STRIP_DEADZONE = 6;

/**
 * How long the strip takes to slide out of the way, in milliseconds.
 *
 * Fast enough to read as a response to the finger rather than as an animation being played at
 * you, slow enough that the conversation reclaiming the space is legible as motion rather than a
 * jump. The tab bar's pill learned the same lesson from the other side - see HISTORY 2026-08-09,
 * where ~400ms read as lag behind a screen that had already changed.
 */
const PINNED_STRIP_SLIDE_MS = 180;

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
 * Keep the visible content where it is when something above it resizes.
 *
 * A module constant rather than an inline object because this is a NATIVE prop: a fresh literal
 * every render is a new value crossing the bridge every render, for a setting that never changes.
 */
const KEEP_VISIBLE_ANCHOR = { minIndexForVisible: 0 } as const;

/** Where a pressed message sits on screen, so the menu can open beside it. */
type MessageAnchor = { y: number; height: number };

/**
 * The reaction bar's height, which the overlay has to know before it has drawn anything.
 *
 * A 44pt button in `space.sm` of padding, top and bottom. Stated because positioning the group
 * means placing the MESSAGE at the anchor, and the message sits one bar plus one gap below the
 * group's top - a measurement that would otherwise need a second layout pass to discover.
 */
const REACTION_BAR_HEIGHT = 44 + space.sm * 2;

/**
 * The sender's face beside a message.
 *
 * > **One constant because THREE things have to agree**, and they were three separate `32`s: the
 * > avatar itself, the spacer that stands in for it on an optimistic row so the bubble does not
 * > jump sideways when the ack lands, and the left inset that lines the meta row up with the
 * > bubble's edge rather than the avatar's. Changing the size in one place and not the others is a
 * > misalignment that only shows up on a message that has reactions.
 */
const AVATAR_SIZE = 40;

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
 * `PRD/15` gives club chat "Members · Poll · Meetups · Events" and race chat "Members · Meet
 * Information · Polls · Car Assignments and Groups", and Eboard chat "Members · Meetings · Polls".
 * Built from the channel's scope rather than forked per scope: one list function, three answers.
 *
 * Every target is addressed by the SCOPE id, which is why the channel meta carries it.
 */
function scopeLinks(
  scope: "club" | "race" | "eboard",
  meta: { scopeId: string; clubId: string | null; channelId: string },
): Array<{ href: string; label: string; icon: MaterialIconName }> {
  /*
   * **Highlights leads the menu, having been a filled pill in the header until 2026-08-11.**
   *
   * The note that stood here said the pill was v1's weighting - Highlights is the destination
   * somebody reaches for repeatedly and the rest are occasional - and that reasoning is still
   * true. What changed is what it cost. This header carries six things where every other header
   * in the app carries three, and the pill was the widest of them at around 100pt; with it there
   * the conversation's own name rendered as "Bingha...". A title that cannot say which
   * conversation you are in is a worse loss than a second tap to a screen.
   *
   * So it keeps its weighting where weighting is now expressed: first in the list, and the only
   * entry whose destination is the conversation itself rather than one of its features.
   */
  const highlights = {
    href: `/channels/${meta.channelId}/highlights`,
    label: "Highlights",
    icon: "bolt" as MaterialIconName,
  };

  if (scope === "club") {
    return [
      highlights,
      { href: `/clubs/${meta.scopeId}/members`, label: "Members", icon: "group" },
      { href: `/clubs/${meta.scopeId}/polls`, label: "Poll", icon: "how-to-vote" },
      { href: `/clubs/${meta.scopeId}/weekly-meetups`, label: "Meetups", icon: "calendar-view-week" },
      { href: `/clubs/${meta.scopeId}/events`, label: "Events", icon: "event" },
    ];
  }
  if (scope === "race") {
    return [
      highlights,
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
    highlights,
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
  poll,
  anchor,
  onDismiss,
  onReact,
  onPickMore,
  onReply,
  onCopy,
  onPin,
  onReport,
  onDelete,
  onSetPollClosed,
  onDeletePoll,
}: {
  message: MessageEnvelope;
  mine: boolean;
  canPin: boolean;
  /** Whether this conversation has reporting at all. False for the whole Eboard scope. */
  canReport: boolean;
  canDelete: boolean;
  /**
   * The poll this card is about, when the viewer is the one who asked it.
   *
   * Null for every other message, and null for a poll somebody else created - `PRD/11` rule 7
   * gives close, reopen and delete to the creator alone, in every scope, including a club admin
   * who did not create it. So the flag is `isCreator` from the server and never a role.
   */
  poll: { closed: boolean } | null;
  /** Where the pressed message is on screen. Null means centre it, as it always did. */
  anchor: MessageAnchor | null;
  onDismiss: () => void;
  onReact: (emoji: ReactionEmoji) => void;
  /** Opens the full catalog. See `EmojiPicker`. */
  onPickMore: () => void;
  onReply: () => void;
  onCopy: () => void;
  onPin: () => void;
  onReport: () => void;
  onDelete: () => void;
  onSetPollClosed: (closed: boolean) => void;
  onDeletePoll: () => void;
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
    /*
      The creator's poll controls, which used to be two filled buttons on the card itself.

      Above `Delete` rather than below it, because "Delete" here means the MESSAGE and
      "Delete poll" means the poll and every vote in it - two destructive items that read
      similarly, so the more specific one is named in full and they are never adjacent by
      accident. A creator who is not an admin sees only the poll pair.
    */
    ...(poll === null
      ? []
      : [
          {
            label: poll.closed ? "Reopen poll" : "Close poll",
            icon: poll.closed ? ("lock-open" as const) : ("lock" as const),
            onPress: () => onSetPollClosed(!poll.closed),
          },
          {
            label: "Delete poll",
            icon: "delete-forever" as const,
            onPress: onDeletePoll,
            destructive: true,
          },
        ]),
    ...(canDelete
      ? [{ label: "Delete", icon: "delete" as const, onPress: onDelete, destructive: true }]
      : []),
  ];

  /*
   * Where the group sits, so it opens beside the message rather than in the middle of the screen.
   *
   * The MESSAGE is what should land on the anchor, and the message sits one reaction bar plus one
   * gap below the group's top - hence the subtraction. Then clamped into the safe area, because a
   * message near either edge would otherwise push the menu off screen.
   *
   * `height` is measured on the first layout and the group is invisible until it is: positioning
   * needs to know how tall the thing is, and one invisible frame is imperceptible where a jump
   * from centred to anchored would not be. With no anchor - the web dots, or a measurement that
   * did not come back - it stays centred, which is what it always did.
   */
  const insets = useSafeAreaInsets();
  const [contentHeight, setContentHeight] = useState<number | null>(null);
  const screenHeight = Dimensions.get('window').height;

  const anchoredTop =
    anchor === null || contentHeight === null
      ? null
      : Math.min(
          Math.max(anchor.y - REACTION_BAR_HEIGHT - space.sm, insets.top + space.sm),
          screenHeight - contentHeight - insets.bottom - space.sm,
        );

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

      <View
        style={[
          styles.overlayContent,
          anchor !== null && styles.overlayContentAnchored,
          anchoredTop !== null && { top: anchoredTop },
          // Invisible for the one frame between rendering and knowing how tall it is.
          anchor !== null && contentHeight === null && styles.overlayContentMeasuring,
        ]}
        onLayout={(event) => {
          const measured = event.nativeEvent.layout.height;
          setContentHeight((held) => (held === measured ? held : measured));
        }}
        pointerEvents="box-none"
      >
        <View style={[styles.overlayEmojiBar, mine && styles.overlaySideMine]}>
          {quickReactions.map((emoji) => (
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
          {/*
            The rest of the catalog. Six quick taps plus a way to everything is what `PRD/05`
            settled on - the quick row is not a shortlist to be replaced, it is the common case.
          */}
          <Pressable
            style={[styles.overlayEmojiButton, styles.overlayEmojiMore]}
            onPress={onPickMore}
            accessibilityRole="button"
            accessibilityLabel="More emoji"
          >
            <MaterialIcons name="add" size={22} color={color.textPrimary} />
          </Pressable>
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

        {/* Icon then label, and no dividers: at this size the rows read as a list without them. */}
        <View style={[styles.overlayMenu, mine && styles.overlaySideMine]}>
          {items.map((item) => (
            <Pressable
              key={item.label}
              style={styles.overlayMenuItem}
              onPress={item.onPress}
              accessibilityRole="button"
              accessibilityLabel={item.label}
            >
              <MaterialIcons
                name={item.icon}
                size={19}
                color={item.destructive === true ? color.error : color.textPrimary}
              />
              <Text
                style={[
                  styles.overlayMenuLabel,
                  item.destructive === true && styles.destructive,
                ]}
              >
                {item.label}
              </Text>
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

  /*
   * The WHOLE quote jumps, not two of the words in it.
   *
   * > **The thumbnail was not a target**, and it is the biggest thing in the quote - so replying
   * > to a photo produced a quote whose picture did nothing while its name and its label both
   * > worked. Reported as "the reply for chat is perfect... but picture is not doing it", which is
   * > exactly right: the gesture was hung on two `Text` nodes rather than on the object.
   *
   * `link` rather than `button`, deliberately: this sits inside the bubble's own pressable, which
   * react-native-web renders as a real `<button>`, and a nested button is failure mode 17. A link
   * is what the two Texts already declared, so this is one interactive element where there were
   * two rather than a new kind of nesting.
   */
  return (
    <Pressable
      style={[styles.quote, mine ? styles.quoteMine : styles.quoteTheirs]}
      onPress={jump}
      accessibilityRole="link"
      accessibilityLabel={`Replying to ${quote.senderName ?? "a deleted member"}: ${label}. Go to that message`}
    >
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
            color={color.secondary}
          />
        </View>
      )}
      {/* Plain text now. The press belongs to the quote, not to the words inside it. */}
      <View style={styles.quoteColumn}>
        <Text
          style={[styles.quoteSender, mine && styles.quoteSenderMine]}
          numberOfLines={1}
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
        >
          {label}
        </Text>
      </View>
    </Pressable>
  );
}

/**
 * The bubble shell.
 *
 * > **The sent bubble was an Energetic-Orange-to-rust diagonal gradient carrying white text**,
 * > ported verbatim from v1, and this component existed to keep `renderItem` from switching
 * > element types between a `View` and a `LinearGradient` mid-list - the kind of change that makes
 * > a virtualised list drop its recycling. Both branches are plain Views since 2026-08-12, so that
 * > hazard is gone rather than merely managed.
 *
 * **It is still one component, and that is now the more important half.** Sent and received differ
 * only in fill and in which corner is small, and the two fills have to be picked as a pair: they
 * are both light, so every piece of text in either one is dark. A branch here is the only place
 * that stays true. See `color.bubbleSent`.
 *
 * The asymmetric corners are v1's: each bubble has one small corner where its tail would be.
 */
function BubbleContainer({
  mine,
  pending,
  bare = false,
  children,
}: {
  mine: boolean;
  pending?: boolean;
  /**
   * No fill, no padding - the content is the whole object.
   *
   * For a photo sent without a caption. A picture already has an edge of its own, and a tinted
   * frame around it is a second one saying nothing: the founder's "boundary shades", stacked with
   * the grey matte the photo used to be letterboxed onto. A photo WITH a caption keeps its bubble,
   * because the words need a surface to sit on.
   */
  bare?: boolean;
  children: React.ReactNode;
}) {
  return (
    <View
      style={[
        styles.bubble,
        !bare && (mine ? styles.sent : styles.received),
        bare && styles.bubbleBare,
        mine && pending === true && styles.pending,
      ]}
    >
      {children}
    </View>
  );
}

/** The `All` chip's key. Not an emoji, so it cannot collide with one. */
const ALL_REACTIONS = "all";

/**
 * Everyone who reacted to one message, one person per row.
 *
 * **A person is the unit here, not an emoji.** It listed each emoji with its reactors' names
 * joined by commas until 2026-08-13, which answers "who liked this" only by making you read a
 * sentence, and answers "is that Emma or Emma R" not at all. The founder asked for the shape
 * WhatsApp and GroupMe both use: chips across the top to filter, and beneath them a face and a
 * name per row with the emoji that person chose at the end of it.
 *
 * **Two sources, deliberately.** The emoji, the counts and who used what come from the live
 * envelope the row is already drawing, so the chips are right the instant the sheet opens and
 * stay right while it is open. Only the names and pictures are fetched, because putting a name
 * under every emoji on every message in a page of history is the one thing the envelope must
 * not carry - see `readReactions`.
 *
 * Ordered by the same `reactionSummary` the pill row uses, so the chips read in the order the
 * pills did. A second ordering rule here would drift from the first.
 */
function ReactorSheet({
  channelId,
  seq,
  reactions,
  viewerId,
  onToggle,
  onDismiss,
}: {
  channelId: string;
  seq: number;
  /** The live set from the envelope. The sheet's own read supplies names, never counts. */
  reactions: readonly MessageReaction[];
  viewerId: string | null;
  /** Remove the viewer's own reaction. Only their row offers it. */
  onToggle: (emoji: ReactionEmoji) => void;
  onDismiss: () => void;
}) {
  const insets = useSafeAreaInsets();
  const [filter, setFilter] = useState<string>(ALL_REACTIONS);

  /*
   * Re-read when the set changes, so somebody reacting while the sheet is open gets a name
   * rather than a missing row. The key is built from the envelope, never from the response, so
   * this cannot chase its own tail.
   */
  const setKey = reactions.map((r) => `${r.emoji}:${r.userIds.join(",")}`).join("|");
  const load = useLoad(() => dmApi.reactionsFor(channelId, seq), [channelId, seq, setKey]);
  const people = useMemo(
    () => new Map((load.data?.people ?? []).map((p) => [p.userId, p])),
    [load.data],
  );

  const summary = reactionSummary(reactions, viewerId);
  const total = summary.reduce((sum, entry) => sum + entry.count, 0);

  /*
   * A filter whose emoji has just gone falls back to All rather than to an empty list, which is
   * exactly what happens when you filter to your own reaction and then remove it.
   */
  const active = summary.some((entry) => entry.emoji === filter) ? filter : ALL_REACTIONS;

  const listed = summary
    .filter((entry) => active === ALL_REACTIONS || entry.emoji === active)
    .flatMap((entry) =>
      (reactions.find((r) => r.emoji === entry.emoji)?.userIds ?? []).map((userId) => ({
        key: `${entry.emoji}-${userId}`,
        emoji: entry.emoji,
        mine: userId === viewerId,
        person: people.get(userId) ?? null,
      })),
    )
    // A reactor whose name has not arrived yet is left out rather than drawn nameless. The
    // fetch above runs again on every change to the set, so this is a blink, not a hole.
    .filter((row): row is typeof row & { person: { name: string; image: string | null } } =>
      row.person !== null,
    );

  /*
   * The two halves of the entrance, animated separately.
   *
   * > **`animationType="slide"` translates the WHOLE modal, scrim included**, so the dimming
   * > arrived as a shaded band sweeping up the screen with a hard edge across the middle of the
   * > conversation - reported from the device on 2026-08-13 as "the shade going up and down".
   * > What every other app does, and what the founder pointed at, is to dim the screen where it
   * > stands and move only the panel.
   *
   * So the modal itself animates nothing (`none`) and these two do the work: `dim` fades the
   * scrim in place, `rise` slides the sheet up from below its own bottom edge. Both run on the
   * native driver, which is what keeps them smooth while the list behind them is still settling.
   */
  /*
   * The sheet's own height is measured rather than given, because it hugs its content: a sheet
   * listing three people and one listing thirty are different distances from off-screen, and a
   * constant would make the short one crawl and the tall one snap.
   *
   * > **Both halves used to live here**, and moved into `useRisingSheet` on 2026-08-14 when the
   * > member card needed the same entrance. The durations and easings are one definition now:
   * > two panels rising at different speeds is the kind of drift nobody files and everybody feels.
   */
  const { dim, rise, sheetHeight, setSheetHeight, close } = useRisingSheet(onDismiss);

  /*
   * The last reaction going away takes the sheet with it: there is nothing left to list, and the
   * pill that opened it is gone from the row underneath.
   */
  useEffect(() => {
    if (total === 0) close();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [total]);

  return (
    <Modal visible transparent animationType="none" onRequestClose={close}>
      <View style={styles.reactorBackdrop}>
        {/*
          The scrim is a sibling filling the screen, never a wrapper: a Pressable around the
          sheet would put every row inside another press target, which is failure mode 17.
        */}
        <Animated.View
          style={[styles.reactorScrim, { opacity: dim }]}
          pointerEvents="none"
          accessibilityElementsHidden
          importantForAccessibility="no"
        />
        <Pressable
          style={StyleSheet.absoluteFill}
          onPress={close}
          accessibilityRole="button"
          accessibilityLabel="Close"
        />
        {/* The home indicator is the phone's, not ours: the last row stops above it. */}
        <Animated.View
          onLayout={(event) => setSheetHeight(event.nativeEvent.layout.height)}
          style={[
            styles.reactorSheet,
            {
              paddingBottom: insets.bottom + space.sm,
              // Hidden until it has been measured, so it never appears at its resting place
              // for the one frame before the animation can know how far it has to travel.
              opacity: sheetHeight === 0 ? 0 : 1,
              transform: [
                {
                  translateY: rise.interpolate({
                    inputRange: [0, 1],
                    outputRange: [sheetHeight, 0],
                  }),
                },
              ],
            },
          ]}
        >
          <View style={styles.reactorGrabber} />
          <View style={styles.reactorHead}>
            <Text style={styles.dialogTitle}>{`Reactions (${total})`}</Text>
            <Pressable
              onPress={close}
              hitSlop={space.sm}
              accessibilityRole="button"
              accessibilityLabel="Close"
            >
              <MaterialIcons name="close" size={22} color={color.textPrimary} />
            </Pressable>
          </View>

          {/*
            The filter chips. `All` first, then every emoji in the pill row's own order, so the
            two rows read the same way round - one horizontal strip because twenty distinct
            emoji is a supported message (`PRD/05` rule R4) and wrapping them would push the
            people off the bottom of the sheet.
          */}
          <ScrollView horizontal showsHorizontalScrollIndicator={false}>
            <Tabs
              variant="chip"
              active={active}
              onChange={setFilter}
              tabs={[
                { key: ALL_REACTIONS, label: "All", count: total },
                ...summary.map((entry) => ({
                  key: entry.emoji,
                  label: entry.emoji,
                  count: entry.count,
                })),
              ]}
            />
          </ScrollView>

          <ScrollView>
            {listed.length === 0 ? (
              load.state === "loading" ? (
                <ActivityIndicator style={styles.reactorBusy} color={color.accent} />
              ) : (
                <Text style={styles.reactorEmpty}>
                  {load.state === "error"
                    ? "Could not load who reacted."
                    : "Nobody has reacted to this yet."}
                </Text>
              )
            ) : (
              listed.map((row) => (
                <Pressable
                  key={row.key}
                  style={styles.reactorRow}
                  // Only your own reaction is yours to remove, so only your own row is a
                  // button. Everybody else's is a fact about them.
                  disabled={!row.mine}
                  onPress={() => onToggle(row.emoji)}
                  accessibilityRole={row.mine ? "button" : "text"}
                  accessibilityLabel={
                    row.mine
                      ? `You reacted with ${row.emoji}. Remove it`
                      : `${row.person.name} reacted with ${row.emoji}`
                  }
                >
                  <Avatar name={row.person.name} image={row.person.image} size={36} />
                  <View style={styles.reactorText}>
                    <Text style={styles.reactorName} numberOfLines={1}>
                      {row.person.name}
                    </Text>
                    {row.mine && <Text style={styles.reactorHint}>Tap to remove</Text>}
                  </View>
                  <Text style={styles.reactorEmoji}>{row.emoji}</Text>
                </Pressable>
              ))
            )}
          </ScrollView>
        </Animated.View>
      </View>
    </Modal>
  );
}

/**
 * The reaction pills under a message.
 *
 * **One component for both branches**, the bubble's and the card's, which drew the identical row
 * twice until this existed - the shape of failure mode 9, where the second copy of a thing is
 * where a rule quietly stops applying to half the product.
 *
 * `PRD/05` rule R2: at most four, most-reacted first, then a `+N` chip for the rest. The chip is
 * what makes the cap honest - a row that just stopped at four would hide somebody's reaction with
 * no way to know it was there, including your own.
 *
 * **A pill taps to join and holds to ask who.** Both gestures on the one target, which is the
 * split the message bubble already uses: the tap acts, the hold explains. The `+N` chip has no
 * reaction of its own, so a tap on it goes straight to the list.
 */
function ReactionRow({
  summary,
  seq,
  style,
  onReact,
  onShowAll,
}: {
  summary: ReturnType<typeof reactionSummary>;
  seq: number;
  style: StyleProp<ViewStyle>;
  onReact: (seq: number, emoji: ReactionEmoji) => void;
  onShowAll: (seq: number) => void;
}) {
  const visible = summary.slice(0, VISIBLE_REACTION_PILLS);
  const hidden = summary.length - visible.length;

  return (
    <View style={style}>
      {visible.map((entry) => (
        <Pressable
          key={entry.emoji}
          style={[styles.pill, entry.mine && styles.pillMine]}
          onPress={() => onReact(seq, entry.emoji)}
          onLongPress={() => {
            // The buzz lands before the sheet does, for the reason `longPressFeedback` gives:
            // a hold has no visual progress, so the acknowledgement has to be felt.
            longPressFeedback();
            onShowAll(seq);
          }}
          accessibilityRole="button"
          accessibilityLabel={
            entry.mine
              ? `Remove your ${entry.emoji} reaction, ${entry.count} total. Hold to see who reacted`
              : `React with ${entry.emoji}, ${entry.count} total. Hold to see who reacted`
          }
        >
          <Text style={styles.pillEmoji}>{entry.emoji}</Text>
          <Text style={[styles.pillCount, entry.mine && styles.pillCountMine]}>{entry.count}</Text>
        </Pressable>
      ))}
      {hidden > 0 && (
        <Pressable
          style={styles.pill}
          onPress={() => onShowAll(seq)}
          accessibilityRole="button"
          accessibilityLabel={`${hidden} more ${hidden === 1 ? 'reaction' : 'reactions'}. See everyone who reacted`}
        >
          <Text style={styles.pillCount}>{`+${hidden}`}</Text>
        </Pressable>
      )}
    </View>
  );
}

/**
 * How tall the attachment panel is before this app has ever seen the keyboard.
 *
 * Only ever used for the first "+" of a session where nobody has typed yet: one keyboard event
 * replaces it with the real number, per device and per keyboard. A wrong guess costs a single
 * settle of the composer on that one occasion, which is why a plain constant is enough - and why
 * it is deliberately close to a stock iPhone keyboard rather than round.
 */
const KEYBOARD_FALLBACK_HEIGHT = 291;

/**
 * The composer bar's tint, and its top edge.
 *
 * A wash of the accent rather than a panel colour: the founder asked for WhatsApp's translucent
 * bar in our own colour. Stated here as literals rather than in `theme.ts` because they are the
 * accent **at an alpha**, and the token module holds solid colours - the day it grows an alpha
 * helper these move into it.
 *
 * A tenth is the whole judgement. Below that it reads as a grey bar somebody spilled something
 * on; above it, it starts competing with the accent controls sitting in the same row.
 */
const COMPOSER_WASH = "rgba(255,77,0,0.07)";
const COMPOSER_WASH_EDGE = "rgba(255,77,0,0.14)";

/**
 * The height of everything in the composer row that is not the message itself.
 *
 * One number for the "+", the announcement toggle, the send disc and the input's own minimum, so
 * the row is a line of equal objects rather than four sizes agreeing by coincidence. Smaller than
 * the 44 they each used to carry: that size is the accessibility floor for a *tap target*, which
 * these still meet through their spacing, and it made the bar as tall as two rows of text.
 */
const COMPOSER_CONTROL = 36;

/**
 * The message a piece of screen state names by `seq`.
 *
 * **Looked up rather than stored**, so it stays current: a reaction or a pin landing while a
 * sheet is open updates the copy on screen instead of freezing a stale one. That is the whole
 * reason these hold a number and not an envelope.
 *
 * Extracted at the third caller - the long-press menu, the reply preview and the reactor sheet
 * all ask this identical question, and a hand-copied `find` is failure mode 9 in miniature.
 */
function messageAt(rows: readonly Row[], seq: number | null): MessageEnvelope | null {
  if (seq === null) return null;
  return (
    rows.find(
      (row): row is { kind: "message"; message: MessageEnvelope } =>
        row.kind === "message" && row.message.seq === seq,
    )?.message ?? null
  );
}

/**
 * Who posted this, above whatever they posted.
 *
 * **One component for messages AND cards**, which is the point of it: the two were drawn
 * separately for a few hours on 2026-08-13 and had already disagreed about the name's colour by
 * the time anybody looked at them side by side. A card is introduced exactly the way a message is.
 *
 * > **The avatar moved out from beside the bubble.** v1 put it in a column to the left, on both
 * > sides, and the founder asked for the face and the name together above the content instead.
 *
 * **The line follows its own bubble, and mirrors when it does.** On a received message the avatar
 * hangs in the left gutter with the name beside it; on your own it hangs in the right gutter with
 * the name to ITS left. Either way the name's outer edge lines up with the edge of the box
 * beneath it and the face hangs past both.
 *
 * The mirroring is the part that had to be chosen rather than derived - an author line pinned to
 * the left above a right-aligned bubble leaves the name introducing nothing, with a column of
 * empty space between them. `AVATAR_SIZE` plus the gap is what the bubble is inset by on its own
 * side, which is why `authorIndent` reads them from here rather than restating the number.
 */
function AuthorLine({
  name,
  image,
  mine = false,
  onPress,
}: {
  name: string;
  image: string | null;
  mine?: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      style={[styles.authorLine, mine && styles.authorLineMine]}
      onPress={onPress}
      hitSlop={space.xs}
      accessibilityRole="button"
      accessibilityLabel={`Open ${name}'s profile`}
    >
      <Avatar name={name} image={image} size={AVATAR_SIZE} />
      <Text style={styles.authorName}>{name}</Text>
    </Pressable>
  );
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
        A spacer the exact height of an author line, not an author line. The client knows its own
        user id but not its own name, so there is no name to write and no initial to draw; leaving
        the slot empty instead would let the bubble jump upward by a whole avatar the moment the
        ack arrives and the real line takes the space.
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
  onShowReactors,
  onOpenProfile,
  onJumpToQuote,
  onOpenPhoto,
}: {
  message: MessageEnvelope;
  /** The viewer, for marking their own reactions. Null only before auth resolves. */
  userId: string | null;
  mine: boolean;
  isJumpTarget: boolean;
  /**
   * Open the long-press menu for this message. The card's own dots call it too.
   *
   * `anchor` is where the pressed row sits on screen, so the menu can appear beside it rather
   * than in the middle of the conversation. Null when it could not be measured, and from the
   * web dots, where there is no press location to speak of - the overlay centres itself then.
   */
  onSelect: (seq: number, anchor: MessageAnchor | null) => void;
  onReact: (seq: number, emoji: ReactionEmoji) => void;
  /**
   * Open the sheet listing everyone who reacted and what they picked.
   *
   * **A long press on any pill reaches it**, and a tap on the `+N` chip, which has no reaction
   * of its own to toggle. Tapping a pill still joins or leaves that reaction - the founder was
   * explicit that the one-tap gesture stays, so the list is the held gesture on the same target
   * rather than a replacement for it. That is the same tap-acts / hold-explains split the
   * message bubble itself already uses.
   */
  onShowReactors: (seq: number) => void;
  onOpenProfile: (userId: string) => void;
  onJumpToQuote: (seq: number) => void;
  /** Open the full-screen viewer. Only ever reached from a photo message. */
  onOpenPhoto: (message: MessageEnvelope) => void;
}) {
  /*
   * Where this row is on screen, measured at the moment it is held.
   *
   * Measured rather than remembered: the list scrolls, so a position captured at layout is stale
   * by the time anybody presses anything. One ref serves both branches because exactly one of
   * them renders per row.
   *
   * **The selection happens inside the callback, and falls back if there is nothing to measure.**
   * A menu that fails to open because a measurement did not come back would be a far worse bug
   * than a menu that opens in the middle of the screen.
   */
  const holdRef = useRef<View>(null);
  const measureThenSelect = () => {
    const node = holdRef.current;
    if (node === null) {
      onSelect(message.seq, null);
      return;
    }
    node.measureInWindow((_x, y, _width, height) => {
      onSelect(message.seq, Number.isFinite(y) ? { y, height } : null);
    });
  };

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

  /*
   * What a card draws when its object will not load, and why it cannot be nothing.
   *
   * > **The body sentence is suppressed for every card-carrying message, whether or not the card
   * > rendered.** Each card returned `null` on a pending or failed read, believing that left the
   * > message "reading as it did before cards existed" - but with the sentence already suppressed
   * > there was nothing left to read, so the whole message went invisible while still counting
   * > towards the unread badge. That is the "notification says something is in the chat, but the
   * > chat is empty" report.
   *
   * Built here rather than inside the cards because only this component knows whether the bubble
   * is the reader's own, which is what picks the text style. `MentionedBody` is deliberately not
   * used: a card's sentence is server-composed and carries no mentions.
   */
  const cardFallback =
    message.body !== null && message.body.length > 0 ? (
      <Text style={mine ? styles.sentText : styles.receivedText}>{message.body}</Text>
    ) : null;

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

  /*
   * A card, drawn full width with no bubble and no avatar.
   *
   * > **It used to sit inside its creator's bubble**, at 82% width and on a tinted fill. The
   * > founder's 2026-08-13 mockup takes all three cards out of the bubble layout, and it is the
   * > same reasoning the announcement branch above already runs on: a poll is put to the room
   * > rather than said to it. The practical half is that a poll's option bars are meant to be
   * > compared by length, and 82% of the column minus an avatar is not much to compare in.
   *
   * Attribution is not lost - it moved into the card's own meta line, which is where the mockup
   * puts it and where a poll's "Coach Dana" now lives.
   *
   * Everything the bubble was carrying for a card is carried here instead: the long press that
   * opens the react/report sheet on native, the dots that stand in for it on web, the pin marker,
   * the jump highlight and the reaction row. The one thing deliberately dropped is the timestamp,
   * per the mockup - a card is a thing that exists, not a thing said at a moment.
   */
  if (cardId !== null) {
    /*
     * The hold, handed to whichever element can actually receive it.
     *
     * > **An event card could never be held, and it took a founder on a phone to find it.** The
     * > row wraps every card in a pressable to catch the gesture, which works for a poll - its
     * > card is a plain View with non-pressable space to grab. The event and meeting cards ARE
     * > pressables, so on native they become the responder and the wrapper never sees the hold.
     * > Nothing was nested illegally and nothing threw; the gesture simply had nowhere to land.
     *
     * So it goes to both: the wrapper still catches it for the poll card, and the two navigating
     * cards take it on their own pressable. Native only, exactly as before - on web it is not
     * attached and the dots below stand in for it, both keyed off the one constant.
     */
    const holdToSelect = CARDS_ARE_LONG_PRESSABLE
      ? () => {
          longPressFeedback();
          measureThenSelect();
        }
      : undefined;

    return (
      <View style={[styles.cardRow, isJumpTarget && styles.jumpTarget]}>
        {/*
          Null when the message was cached before this column existed. It renders unattributed
          rather than blank-labelled, and the next sync fills it in.
        */}
        {message.senderName !== null && (
          <AuthorLine
            name={message.senderName}
            image={message.senderImage}
            onPress={() => onOpenProfile(message.senderId)}
          />
        )}
        <Pressable
          ref={holdRef}
          onLongPress={holdToSelect}
          delayLongPress={400}
          /*
            `none`, and it is what keeps the nesting legal: react-native-web renders a Pressable
            as a real <button> only when its role says so, and the event and meeting cards inside
            are buttons themselves. `disabled` was tried once and was worse than the bug - it
            disables descendants, so every poll option went dead.
          */
          accessibilityRole="none"
        >
          {/* A property of the message rather than of who sent it, so it travels with the card. */}
          {message.pinned && (
            <View style={styles.cardPin}>
              <MaterialIcons name="push-pin" size={12} color={color.accent} />
            </View>
          )}
          {message.linkedPollId !== null ? (
            <ChatPollCard pollId={message.linkedPollId} fallback={cardFallback} />
          ) : message.linkedEventId !== null ? (
            <ChatEventCard
              eventId={message.linkedEventId}
              fallback={cardFallback}
              onLongPress={holdToSelect}
            />
          ) : (
            /* A meeting card. The event card's twin, and navigates the same way. */
            <ChatMeetingCard
              meetingId={cardId}
              fallback={cardFallback}
              onLongPress={holdToSelect}
            />
          )}
          {!CARDS_ARE_LONG_PRESSABLE && (
            <Pressable
              style={styles.cardMenu}
              // The dots go through the same measurement, so the menu opens beside the card here
              // too rather than only when the gesture is a hold.
              onPress={measureThenSelect}
              hitSlop={space.sm}
              accessibilityRole="button"
              accessibilityLabel={
                mine ? "React to your card" : "React to or report this card"
              }
            >
              <MaterialIcons name="more-vert" size={18} color={color.textSecondary} />
            </Pressable>
          )}
        </Pressable>

        {summary.length > 0 && (
          <ReactionRow
            summary={summary}
            seq={message.seq}
            style={[styles.metaRow, styles.metaRowTheirs]}
            onReact={onReact}
            onShowAll={onShowReactors}
          />
        )}
      </View>
    );
  }

  return (
    <View
      style={[
        styles.messageRow,
        mine && styles.messageRowMine,
        isJumpTarget && styles.jumpTarget,
      ]}
    >
      {/*
        The face and the name together, above the bubble - the same line a card gets, from the
        same component, so the two cannot drift again.

        Null when the message was cached before this column existed. It renders unattributed
        rather than blank-labelled, and the next sync fills it in. Shown on BOTH sides:
        attribution on your own messages is not redundant, or an own bubble would be the only
        unlabelled thing on screen.
      */}
      {message.senderName !== null && (
        <AuthorLine
          name={message.senderName}
          image={message.senderImage}
          mine={mine}
          onPress={() => onOpenProfile(message.senderId)}
        />
      )}
      <Pressable
        ref={holdRef}
        // Long press, not a visible button: reporting is rare and a tap target on
        // every bubble would be noise. Own messages are excluded because nobody can
        // report themselves.
        //
        // Unconditional here. The platform split lives in the card branch above, which is
        // the only place that ever needed it.
        onLongPress={() => {
          // A tap you can feel, before anything appears on screen. Shared with the two
          // list screens so one gesture has one feel - see `longPressFeedback`.
          longPressFeedback();
          measureThenSelect();
        }}
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
        // Always a button now that cards do not come through here. The `none` role that
        // kept a card's own controls legal moved with them, into the branch above.
        accessibilityRole="button"
        accessibilityLabel={
          mine
            ? "Press and hold to react to your message"
            : "Press and hold to react to or report this message"
        }
        // The gesture stays on the OUTERMOST element and the fill sits inside it, so the
        // bubble can be styled freely without the pressable becoming the styled thing -
        // and without nesting a second pressable (failure mode 16).
        /*
          Inset from its OWN side, so the bubble's outer edge lines up with the name above it and
          the avatar hangs past both. Mirrored for your own messages, like the line itself.
        */
        style={
          mine
            ? [styles.bubbleWrapMine, styles.authorIndentMine]
            : [styles.bubbleWrapTheirs, styles.authorIndent]
        }
      >
        <BubbleContainer
          mine={mine}
          /*
            A photo with nothing said alongside it wears no bubble. The caption is the test rather
            than the type: with words there is something that needs a surface, without them the
            picture is the message and a tinted frame is just an outline around an outline.
          */
          bare={
            message.type === "photo" &&
            message.mediaId !== null &&
            (message.body === null || message.body.length === 0)
          }
        >
          {/*
            The pin marker stays INSIDE. It is a property of the message rather than of
            who sent it, so it travels with the words and not with the attribution.
          */}
          {message.pinned && (
            <View style={styles.pinRow}>
              <MaterialIcons name="push-pin" size={12} color={color.accent} />
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
            A photo may carry a caption, and usually does not.

            No card branch here: a card message returns above, full width and outside the
            bubble layout entirely. See the block over `styles.cardRow`.
          */}
          {message.body !== null && message.body.length > 0 && (
            <Text style={mine ? styles.sentText : styles.receivedText}>
              <MentionedBody
                body={message.body}
                mentions={message.mentions}
                mine={mine}
                onOpenProfile={onOpenProfile}
              />
            </Text>
          )}
          {/*
            The time, in the bubble's bottom-right corner.

            > It spent an hour beneath the bubble, next to the reactions. Back inside on
            > 2026-08-12, in the corner rather than under the body where it started - the
            > cost of it living here is that it claims a line of its own, which is the
            > reason the padding around it came down at the same time.

            `alignSelf` on the last child of the bubble's column: that is what "bottom
            right" means here, and it needs no second style for `mine` because both
            bubbles put it in the same corner.
          */}
          <Text style={styles.bubbleTime}>
            {new Date(message.createdAt).toLocaleTimeString([], {
              hour: "2-digit",
              minute: "2-digit",
            })}
          </Text>
        </BubbleContainer>
      </Pressable>

      {/*
        The reaction row, beneath the bubble.

        > **Conditional again, now that the time has gone back inside.** While the two shared
        > this row it was rendered unconditionally, because the time always exists. An
        > always-rendered empty row carries its own top margin, which is a gap under every
        > unreacted message in the conversation - the same class of bug as `DESIGN/03` rule 4,
        > where a hidden thing kept occupying room.

        > **Inside the bubble's own column, not a sibling of it.** The message row is a
        > horizontal flex - avatar, then bubble - so this row added there became a
        > THIRD column and sat beside the bubble rather than beneath it. What belongs to a
        > message has to read that way, which is why the row takes a full-width basis and
        > the wrap above breaks before it.

        Only emoji anyone actually used, most-reacted first, at most four with a `+N` chip for
        the rest - `PRD/05` rules R2 and R3, drawn by the one `ReactionRow` the card branch uses.
      */}
      {summary.length > 0 && (
        <ReactionRow
          style={[
            styles.metaRow,
            mine ? styles.metaRowMine : styles.metaRowTheirs,
            /* Under the bubble it belongs to, inset past the hanging avatar on the same side. */
            mine ? styles.authorIndentMine : styles.authorIndent,
          ]}
          seq={message.seq}
          summary={summary}
          onReact={onReact}
          onShowAll={onShowReactors}
        />
      )}
    </View>
  );
});

export default function ChatScreen() {
  const { channelId, around } = useLocalSearchParams<{
    channelId: string;
    around?: string;
  }>();
  const { authState, client, userId, revision, offline, notifyChanged } = useSession();
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
  /**
   * Offer to block, straight after a DM report lands.
   *
   * > **Reporting is reviewed; blocking is instant and self-service**, and the two used to live on
   * > opposite sides of the screen - Report on the message menu, Block on the conversation header.
   * > Somebody who has just been frightened enough to report should not then have to go and find
   * > the control that actually stops it. This is the one moment we know they want it.
   *
   * DM only, because there is nobody to block in a club chat that removing the person would not
   * handle better, and blocking a clubmate does not stop them posting in the room you share.
   */
  const [offerBlock, setOfferBlock] = useState<{ userId: string; name: string } | null>(null);
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
   * The poll being deleted, by id.
   *
   * A separate piece of state from `confirmingDelete` although both are "are you sure" - they ask
   * about different objects and one is not a special case of the other. Deleting the MESSAGE
   * leaves a tombstone; deleting the POLL takes every vote with it and its card leaves the
   * conversation entirely.
   */
  const [confirmingPollDelete, setConfirmingPollDelete] = useState<string | null>(null);
  /** The message whose reactions are listed in full, by seq. A held pill or the `+N` chip sets it. */
  const [showingReactorsFor, setShowingReactorsFor] = useState<number | null>(null);
  /** True while the full emoji catalog is open over the long-press menu. */
  const [pickingEmoji, setPickingEmoji] = useState(false);
  /** Where the held message sat when it was held, so the menu opens beside it. */
  const [selectedAnchor, setSelectedAnchor] = useState<MessageAnchor | null>(null);
  /**
   * Whether the next send goes out as an announcement.
   *
   * A compact armed toggle beside the composer rather than a permanent banner, which is what v1
   * settled on after the banner ate the top of the conversation. It disarms on send.
   */
  const [asAnnouncement, setAsAnnouncement] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  /**
   * True while the attachment panel stands in the keyboard's place.
   *
   * The two are alternatives, never both: this is a *mode* of the same strip of screen, which is
   * why the "+" becomes a keyboard glyph rather than a second control appearing beside it.
   */
  const [attachOpen, setAttachOpen] = useState(false);
  /**
   * How tall the keyboard is, remembered from the last time it appeared.
   *
   * The panel has to be exactly this tall or the composer moves when they swap, which is the
   * whole illusion. Remembered rather than measured on demand because the keyboard is **gone** by
   * the time the panel is drawn - and it is per device and per keyboard, so a constant would be
   * wrong on most phones and wrong again the moment somebody enables a third-party keyboard.
   */
  const [keyboardHeight, setKeyboardHeight] = useState(0);

  /**
   * How the keyboard moves: the duration and curve iOS reports with each event.
   *
   * `KeyboardAvoidingView` animates its own padding with exactly these values, so borrowing them
   * is what keeps the panel's growth and the keyboard's exit on one clock. A hand-picked duration
   * would drift against the real one and the composer would visibly stagger.
   */
  const keyboardMove = useRef<{ duration: number; easing: string }>({
    duration: 250,
    easing: "keyboard",
  });
  /** The composer's field, so the keyboard glyph can put the keyboard back by focusing it. */
  const inputRef = useRef<TextInput>(null);
  /**
   * Whether the keyboard is on screen right now, and whether a "+" is waiting for it to leave.
   *
   * > **The swap has to happen inside a keyboard event, and these are what make that possible.**
   * > Opening the panel the moment "+" is pressed puts the panel's height on screen while the
   * > keyboard's is still there, and for the two or three frames before the keyboard begins to
   * > leave, the composer carries both - it jumps up and then eases back down. Reported from the
   * > device as "a split second render where it just pops above, like how it used to do".
   *
   * So the press only *asks*: it dismisses the keyboard and leaves `wantsPanel` set, and the
   * panel is opened by `keyboardWillHide`, in the same commit that removes the keyboard's own
   * height. Closing works the same way in reverse, driven by `keyboardWillShow`.
   *
   * Refs rather than state because a listener registered once has to read the current value, and
   * because nothing renders from them.
   */
  const keyboardUp = useRef(false);
  const wantsPanel = useRef(false);
  /** The panel's open state, for the same listener to read without re-subscribing. */
  const attachOpenNow = useRef(attachOpen);
  useEffect(() => {
    attachOpenNow.current = attachOpen;
  }, [attachOpen]);

  /**
   * Animate the next layout change the way the keyboard animates.
   *
   * The panel appearing and the keyboard leaving are two separate changes to the same strip of
   * screen. Run on one duration and one curve they read as a single swap; run on two they read
   * as the composer being shoved.
   */
  const animateWithKeyboard = useCallback(() => {
    const { duration, easing } = keyboardMove.current;
    /*
     * The event's easing is a name, and the one the keyboard reports on iOS is `keyboard`, which
     * is a type this API has. Anything else it might report falls back to that same curve rather
     * than to a default the keyboard does not use.
     */
    const named = LayoutAnimation.Types[easing as keyof typeof LayoutAnimation.Types];
    LayoutAnimation.configureNext({
      // The floor is RCTLayoutAnimation's, not ours: it refuses anything shorter.
      duration: Math.max(duration, 10),
      update: {
        duration: Math.max(duration, 10),
        type: named ?? LayoutAnimation.Types.keyboard,
      },
    });
  }, []);

  /**
   * Swap the keyboard for the attachment panel, or the panel back for the keyboard.
   *
   * **This mostly does not change anything itself.** Where a keyboard is involved it asks the
   * keyboard to move and lets the keyboard's own event flip the panel, so the two heights are
   * never on screen at once - see `keyboardUp`. It acts directly in exactly the two cases where
   * no keyboard event is coming: opening with the keyboard already down, and web, which has no
   * software keyboard to swap with at all.
   */
  const toggleAttach = useCallback(() => {
    if (attachOpen) {
      if (Platform.OS === "web" || !inputRef.current) {
        animateWithKeyboard();
        setAttachOpen(false);
        return;
      }
      // Focusing raises the keyboard; `keyboardWillShow` closes the panel as it arrives.
      inputRef.current.focus();
      return;
    }

    if (keyboardUp.current) {
      wantsPanel.current = true;
      Keyboard.dismiss();
      return;
    }

    animateWithKeyboard();
    setAttachOpen(true);
  }, [attachOpen, animateWithKeyboard]);

  useEffect(() => {
    /*
     * `will` on iOS, `did` on Android: iOS reports the coming change before it animates, which is
     * what allows anything to move WITH the keyboard rather than after it. Android has no
     * equivalent, so it gets the honest late one.
     */
    const showing = Keyboard.addListener(
      Platform.OS === "ios" ? "keyboardWillShow" : "keyboardDidShow",
      (event) => {
        keyboardUp.current = true;
        /*
         * The same number every time after the first, so React bails out and nothing re-renders.
         * That is deliberate: see `composerFloor` for why a keyboard event must not touch state
         * this screen draws from.
         */
        setKeyboardHeight(event.endCoordinates.height);
        if (event.duration) {
          keyboardMove.current = {
            duration: event.duration,
            easing: event.easing ?? "keyboard",
          };
        }
        /*
         * The panel closes HERE, as the keyboard arrives, so its height leaves in the same commit
         * that the keyboard's height lands. One place decides that the keyboard beats the panel,
         * rather than every control that might raise one - tapping the message field while the
         * panel is open therefore does the right thing without knowing the panel exists.
         */
        if (attachOpenNow.current) {
          animateWithKeyboard();
          setAttachOpen(false);
        }
      },
    );
    const hiding = Keyboard.addListener(
      Platform.OS === "ios" ? "keyboardWillHide" : "keyboardDidHide",
      (event) => {
        keyboardUp.current = false;
        if (event.duration) {
          keyboardMove.current = {
            duration: event.duration,
            easing: event.easing ?? "keyboard",
          };
        }
        // And the panel opens HERE, for the mirror-image reason.
        if (wantsPanel.current) {
          wantsPanel.current = false;
          animateWithKeyboard();
          setAttachOpen(true);
        }
      },
    );
    return () => {
      showing.remove();
      hiding.remove();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
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
  /** Whether the pinned strip is showing. Follows the direction the reader is travelling. */
  const [pinnedStripVisible, setPinnedStripVisible] = useState(true);
  /**
   * The last scroll offset seen, so the next one can be read as a direction.
   *
   * A ref rather than state: this changes on every scroll frame and nothing renders off it, so
   * holding it in state would re-render the whole log sixty times a second to store a number
   * that only the next scroll event reads.
   */
  const lastOffsetRef = useRef(0);
  /**
   * The strip's natural height, measured once.
   *
   * Needed because the container animates between that height and zero, and a collapsing box has
   * to know what it is collapsing FROM. Measured from the content rather than hardcoded, since
   * the card's height comes from its type scale and would drift the day somebody changes it.
   */
  const [pinnedStripHeight, setPinnedStripHeight] = useState(0);
  /** 1 showing, 0 hidden. Drives both the container's height and the slide. */
  const pinnedSlide = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    Animated.timing(pinnedSlide, {
      toValue: pinnedStripVisible ? 1 : 0,
      duration: PINNED_STRIP_SLIDE_MS,
      /*
       * Height is a layout property and cannot be driven natively, so this runs on the JS thread.
       * Acceptable here and worth stating: it fires only when the direction actually CHANGES,
       * not per scroll frame, and it is 180ms. A native-driven `translateY` alone would not let
       * the conversation reclaim the space, which is the half of this that makes it feel like
       * the strip left rather than merely became invisible.
       */
      useNativeDriver: false,
    }).start();
  }, [pinnedStripVisible, pinnedSlide]);
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

  /*
   * Subscribe to and backfill this conversation on arrival.
   *
   * > **Without this, a channel gained during the session never got its history.** The client's
   * > channel list is fixed at `auth.ok` and `syncAll` walks exactly that list, so a race you
   * > had just joined, been added to, or created was not in it. Joining a race redirects
   * > straight into its chat, so the screen opened on "No messages yet" over a channel the
   * > server had already written "X joined the race" into, and only a reload showed it.
   *
   * Runs for every channel rather than only unknown ones: syncing one already in hand is the
   * cheap case, and a condition here would be a rule to get wrong.
   */
  useEffect(() => {
    if (!client || !channelId) return;
    void client
      .openChannel(channelId)
      // Local history still renders and the socket still delivers what arrives next, so a
      // failed backfill degrades to what this screen did before rather than to an error.
      .catch((error) => console.warn('[chat] backfill on open failed', error));
  }, [client, channelId]);

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
  const selectedMessage = useMemo(() => messageAt(rows, selected), [rows, selected]);

  /**
   * The message whose reactor sheet is open, for the same reason and by the same lookup.
   *
   * The sheet reads its emoji and counts from this live envelope rather than from its own fetch,
   * so removing your reaction redraws the chips the moment the store patches - and somebody
   * else's reaction landing over the socket appears in the open sheet instead of behind it.
   */
  const reactorsMessage = useMemo(
    () => messageAt(rows, showingReactorsFor),
    [rows, showingReactorsFor],
  );

  /*
   * The poll behind a selected card, loaded only while its sheet is open.
   *
   * **The sheet knows a `seq` and nothing else**, so whether to offer Close and Delete cannot be
   * answered from the message: it needs `isCreator`, which is the server's answer and lives on
   * the poll. Fetched on demand rather than held, because this is one small read behind a long
   * press and the alternative is every card publishing its state upward into a screen that has
   * no other reason to know about polls.
   *
   * Null unless the viewer created it, so the sheet's own logic stays a null check.
   */
  const selectedPollId = selectedMessage?.linkedPollId ?? null;
  const selectedPoll = useLoad(
    async () => (selectedPollId === null ? null : await pollApi.detail(selectedPollId)),
    [selectedPollId],
  );
  const pollControls =
    selectedPoll.data?.poll.isCreator === true ? { closed: selectedPoll.data.poll.closed } : null;

  /** The message the composer is answering, resolved the same way and for the same reasons. */
  const replyingTo = useMemo(() => messageAt(rows, replyingToSeq), [rows, replyingToSeq]);

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
  const selectMessage = useCallback((seq: number, anchor: MessageAnchor | null) => {
    setSelected(seq);
    setSelectedAnchor(anchor);
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
          onShowReactors={setShowingReactorsFor}
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
    } catch (error) {
      /*
       * The content filter refused it.
       *
       * > **Give the words back.** `ChatClient` has already dropped the optimistic bubble,
       * > because a retry of the same body can only be refused again - so without this the
       * > member watches their message vanish with no explanation and no way to recover what
       * > they typed. Restoring the draft makes the refusal an edit rather than a loss.
       *
       * The notice says what happened and not which word did it. Naming the term turns the
       * filter into a puzzle with the answer printed on it, and the reasoning is recorded
       * with the wire code in `protocol.ts`.
       */
      if (error instanceof Error && error.message === "content_refused") {
        setDraft(body);
        if (answering !== null) setReplyingToSeq(answering.seq);
        setAsAnnouncement(announcing);
        setMentionPicks(mentionPicks);
        setNotice(
          "That message was not sent. It contains language this app does not allow. Edit it and try again.",
        );
      }
      // Anything else failed VISIBLY: the entry stays in the outbox marked failed, and the
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
   * Open a pinned notice.
   *
   * > **A pin is something to READ, not somewhere to go** - which is why this never jumps back
   * > into the conversation. Jumping dropped the reader into the middle of history with no clear
   * > way back, and whether it worked at all depended on how far back the message happened to be.
   *
   * **Unless the pin IS somewhere to go.** A poll, event or meeting card is pinned precisely
   * because somebody should act on it, and sending them to Highlights to look at a picture of the
   * card leaves them to find the poll themselves - the dead end this strip exists to prevent.
   * So a card opens the thing it stands for and everything else opens Highlights.
   *
   * The route comes from `hrefForCard`, which builds the same target a notification about that
   * poll would carry, so tapping the pin and tapping the notification land in the same place by
   * construction rather than by two lists of routes agreeing.
   *
   * A card whose object was deleted cannot reach here: the cascade soft-deletes the card and
   * clears its pin in one statement, and `pinnedRows` drops both tombstones and unpinned rows.
   */
  const openPinned = (message: MessageEnvelope) => {
    const card = hrefForCard(message);
    router.push(card ?? `/channels/${channelId}/highlights`);
  };

  const setPinned = async (seq: number, pinned: boolean) => {
    if (!channelId) return;
    setSelected(null);
    try {
      const result = await channelApi.setPinned(channelId, seq, pinned);
      /*
       * The response is stored rather than discarded, and this is NOT the local guess the
       * comment on this function warns about - it is the server's own answer, which was already
       * on the wire and was being thrown away in favour of re-reading a cache that did not have
       * it yet.
       *
       * What it buys is the pinner's own view. Everyone else learns the new pin time from the
       * socket update, but the person who pinned races their own request: `refresh` reads local
       * storage, and if the update has not landed yet they see the strip reorder a moment later.
       * Writing the response first removes the race for the one client that already has the
       * answer in its hand.
       *
       * No confirmation banner. The pinned strip appearing or losing a card IS the feedback, and
       * a second line announcing it covered the top of the conversation to say what was already
       * visible. Failures below still speak, because nothing else would say so.
       */
      if (client) await client.store.upsert([result.message]);
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

      /*
       * Then offer the thing that actually stops it.
       *
       * Only in a DM, only for somebody else's message, and only if they are not already blocked -
       * offering a control that would be a no-op is worse than not offering it. `meta.peer` is the
       * other participant, which exists only in this scope.
       */
      const peer = meta?.peer;
      if (meta?.scope === "dm" && peer && peer.blockedByMe !== true) {
        setOfferBlock({ userId: peer.userId, name: peer.name });
      }
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
      : /*
         * A DM falls back to the CHATS list, which is where DMs live now.
         *
         * > It pointed at `/dm`, the standalone Messages list, and that had become the only way to
         * > reach that screen. Opening a conversation from the person+ flow crosses navigators with
         * > a `replace`, so the chat has no history to pop and this fallback is what actually runs -
         * > every new DM ended on a list the product had already replaced. Reported as "instead of
         * > coming to the main page, it's taking me to the message page".
         */
        meta.scope === "dm"
        ? "/clubs"
        : meta.scope === "club"
          ? `/clubs/${meta.scopeId}`
          : // Race and Eboard chat both fall back to the CLUB hub. Neither falls back to its own
            // hub, which would bounce - both hubs send a member straight into chat - and there is
            // no races list to fall back to, because the product does not have one.
            `/clubs/${meta.clubId}`;

  const parentLabel = meta === null ? "Clubs" : meta.scope === "dm" ? "Chats" : "Club";

  // One definition of "back" for the whole app: pop if there is history, use the declared
  // parent if there is not. See `useGoBack`.
  const goBack = useGoBack(parent);

  /**
   * How much bar there is beneath the message field.
   *
   * **The home indicator's space belongs to the composer**, which is what every other app's bar
   * does and what ours did not: the field ended a few points off the bottom edge with the
   * indicator through it.
   *
   * > **It does not change when the keyboard does, and that is the point.** It used to drop to a
   * > hairline while the keyboard was up, so the bar changed height in the middle of the
   * > keyboard's animation - one more thing moving in the frames where the conversation is
   * > already moving. `keyboardVerticalOffset` on the `KeyboardAvoidingView` pays for the floor
   * > instead: the padding it adds is the keyboard minus this, so the field still lands exactly
   * > on the keyboard's top edge and the bar never resizes.
   *
   * The panel is the one exception, because it supplies that space itself - and unlike the
   * keyboard it is a deliberate, occasional swap that is already animating.
   */
  const composerFloor = attachOpen ? space.sm : Math.max(insets.bottom, space.sm);

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
    <KeyboardAvoider
      style={styles.flex}
      /*
        The composer already holds the home indicator's space, so the padding needed here is the
        keyboard MINUS that - otherwise the two stack and the bar floats above the keys. See
        `composerFloor`, which is the same number seen from the other side.
      */
      offset={insets.bottom}
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
            size={22}
            // The accent, which is what the system draws inside its capsule and what every
            // native header in this app therefore shows. Black was the tell that this one was
            // hand-made.
            color={color.accent}
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
            // A DM is a person; a club, a race and the Eboard space are things. Said once:
            // `Avatar` takes the roundness from this, so the header cannot end up square with
            // a letter in it - which is what it drew before, having named the shape and not
            // the kind.
            kind={meta.scope === "dm" ? "person" : "group"}
            tintId={meta.channelId}
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
          Everything this conversation owns is behind the one glyph, Highlights included.

          It was a filled pill beside the title until 2026-08-11, on v1's weighting that
          Highlights is reached for repeatedly while the rest are occasional. The pill was the
          widest thing in the row at around 100pt, and this header carries six items where every
          other header in the app carries three - so the name of the conversation you are in
          rendered as "Bingha...". It leads the menu now instead. See `scopeLinks`.

          A DM gets the options sheet rather than this, because mute and block are the only
          things hanging off a conversation with no club around it.

          Three dots, not a grid glyph. A grid says "a set of things laid out"; three dots is the
          one glyph a phone user reads as "there is more behind this" without being taught, and it
          is what every other menu in this app already uses.
        */}
        {meta !== null && meta.scope !== "dm" && (
          <Pressable
            onPress={() => setGridOpen((open) => !open)}
            accessibilityRole="button"
            accessibilityLabel="This conversation's screens"
            hitSlop={space.sm}
            style={styles.headerAction}
          >
            <MaterialIcons name="more-vert" size={20} color={color.accent} />
          </Pressable>
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
            <MaterialIcons name="more-vert" size={20} color={color.accent} />
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
        /*
          Two nested boxes, and both are load-bearing.

          The OUTER one owns the height and clips. Animating it from the measured height to zero
          is what hands the space back to the conversation - the previous version set `opacity: 0`
          and left the strip sitting in the layout, so there was a permanent empty band under the
          header whether anything was pinned-and-visible or not.

          The INNER one slides. Collapsing the height alone would wipe the strip away from its
          bottom edge, which reads as a squash; translating the content up by the same amount as
          the height it is losing makes it travel under the header instead. The two interpolations
          are deliberately the same distance for that reason - change one and the other has to
          follow, or the strip drifts against its own clip.

          Height is measured rather than assumed, and only once it is non-zero: an early layout
          pass reports 0, and adopting that would collapse the strip permanently.
        */
        <Animated.View
          style={[
            styles.pinnedStripClip,
            pinnedStripHeight > 0
              ? {
                  height: pinnedSlide.interpolate({
                    inputRange: [0, 1],
                    outputRange: [0, pinnedStripHeight],
                  }),
                }
              : null,
          ]}
          /*
            Hidden, it must not intercept taps meant for the messages behind it - a strip you
            cannot see but can still press is worse than one that is simply there. On the clip
            rather than the scroller, so a partially slid strip is untappable throughout the
            transition rather than only at the end of it.
          */
          pointerEvents={pinnedStripVisible ? "auto" : "none"}
        >
        <Animated.View
          /*
            Measured EXACTLY ONCE, on the pass before anything constrains it.

            > **The node being measured is inside the box whose height is animated, so it can
            > measure itself mid-collapse.** Accepting any non-zero value looked like a sufficient
            > guard and is not: as the clip travels 76 -> 0 the child is squeezed, fires `onLayout`
            > with whatever it has been squashed to, and the strip adopts that as its full height.
            > Observed on the device settling at **8 points** - so the strip went on showing and
            > hiding correctly, at a height nobody could see, which reads exactly like the feature
            > never shipped.

            The first pass is the trustworthy one precisely because `pinnedStripHeight` is still 0
            there, so no `height` style is applied yet and the strip lays out naturally. Every
            later pass happens under an explicit animated height and can only report the clip.

            Safe to freeze because the height genuinely is constant: the card is a fixed 300 wide
            with `numberOfLines={1}`, so no pin can make the strip taller than another.
          */
          onLayout={(event) => {
            if (pinnedStripHeight > 0) return;
            const measured = event.nativeEvent.layout.height;
            if (measured > 0) setPinnedStripHeight(measured);
          }}
          style={{
            transform: [
              {
                translateY: pinnedSlide.interpolate({
                  inputRange: [0, 1],
                  outputRange: [-pinnedStripHeight, 0],
                }),
              },
            ],
          }}
        >
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={styles.pinnedStrip}
          contentContainerStyle={styles.pinnedStripContent}
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
                onPress={() => openPinned(message)}
                accessibilityRole="button"
                /*
                  The label names the actual destination, which now differs per notice. A screen
                  reader announcing "in Highlights" on a poll card would be describing the old
                  behaviour to the one person who cannot see where they landed.
                */
                accessibilityLabel={
                  hrefForCard(message) === null
                    ? 'Open this pinned message in Highlights'
                    : `Open the pinned ${message.type}`
                }
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
        </Animated.View>
        </Animated.View>
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
            **Suspended while a jump is in flight**, because the two want opposite things.

            > **This broke tapping a reply's photo to reach the original**, reported the same
            > afternoon it was added, and it broke ONLY on the device. `scrollToIndex` puts the
            > viewport somewhere deliberately; the anchor then sees the cells around the target
            > settling - a poll card loading, a photo measuring - and compensates by moving the
            > offset back, so the jump lands and is then quietly undone.

            `jumpedTo` is exactly "a jump is in flight" and clears itself when the highlight does,
            so the anchor is off for that half second and on for everything else.
          */
          maintainVisibleContentPosition={jumpedTo === null ? KEEP_VISIBLE_ANCHOR : undefined}
          /*
            **What the reader is looking at stays where it is, whatever resizes around it.**

            > Reported as "for the last 40 or 50 messages it is smooth, and as we reach poll event
            > pics old messages it is bugging" - which is the diagnosis, not just the symptom. The
            > recent tail is plain text: measured once, never changes. Older history is where the
            > cards and the photos are, and **every one of those changes height after it renders**.
            > A poll card draws its fallback sentence, fetches the poll, and becomes three hundred
            > points of options; a photo draws a square and then becomes its true shape, because
            > nothing on the wire says how tall a picture is. Each of those resizes shifts
            > everything after it, and the list lurches under the finger.

            This prop is the standing answer to that: it anchors the first visible cell and lets
            layout changes above it push content the other way, rather than moving the viewport.
            It is not a tuning value - without it, ANY asynchronous height in a scrollback is felt
            by the reader, so this stays even if today's particular offenders are made to settle
            faster.

            **It does not exist in react-native-web**, so nothing about it can be checked in a
            browser - the prop is silently ignored there. See failure mode 28.
          */
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
             * The strip follows the DIRECTION of travel, not the distance from the tail.
             *
             * A pin is a shortcut back to something recent, so it earns its place while you are
             * at the conversation and is in the way while you are reading back through history.
             * What tells you which of those is happening is which way the finger just moved -
             * moving away hides it, moving back brings it, from anywhere in the log.
             *
             * The list is INVERTED, so the offset grows as the reader goes back in time: a
             * rising offset is travelling away from the newest message, which is an upward
             * swipe, which hides. Getting that backwards is the easy mistake here, and it is
             * invisible in a diff - it looks correct either way and is simply inverted on a
             * device.
             *
             * State rather than a ref, because this has to re-render - and set only when it
             * actually flips, so a scroll does not re-render the screen on every frame.
             */
            const previous = lastOffsetRef.current;
            lastOffsetRef.current = fromBottom;
            const delta = fromBottom - previous;

            const shouldShow = near
              ? // Arriving at the newest message always shows it, whichever way the last few
                // points of travel went. Without this, easing into the tail from above ends with
                // the reader at the conversation and the strip hidden, which is the one place it
                // is unambiguously wanted.
                true
              : Math.abs(delta) < PINNED_STRIP_DEADZONE
                ? // Too small to be a decision. Hold whatever is on screen rather than flipping
                  // on a wobble or on the bounce at the end of the list.
                  pinnedStripVisible
                : delta < 0;

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
            /*
              The menu stays open behind the picker rather than being dismissed, so cancelling
              the picker returns you to where you were instead of back to the conversation.
            */
            onPickMore={() => setPickingEmoji(true)}
            anchor={selectedAnchor}
            poll={pollControls}
            onSetPollClosed={(closed) => {
              const pollId = selectedMessage.linkedPollId;
              setSelected(null);
              if (pollId === null) return;
              /*
                `notifyChanged` AFTER the write lands, never beside it - the provider's own rule,
                and the reason it exists. The card watching this poll re-reads on the bump; bumping
                first would race the write and re-read the state being replaced.
              */
              void pollApi.setClosed(pollId, closed).then(notifyChanged, notifyChanged);
            }}
            onDeletePoll={() => setConfirmingPollDelete(selectedMessage.linkedPollId)}
          />
        )}

      {/* The whole catalog, over the menu. `PRD/05` rule R1. */}
      {pickingEmoji && selectedMessage !== null && (
        <EmojiPicker
          onDismiss={() => setPickingEmoji(false)}
          onPick={(emoji) => {
            setPickingEmoji(false);
            setSelected(null);
            void react(selectedMessage.seq, emoji);
          }}
        />
      )}

      {/* Everyone who reacted, behind a held pill or the `+N` chip. `PRD/05` rule R2. */}
      {showingReactorsFor !== null && reactorsMessage !== null && (
        <ReactorSheet
          channelId={channelId}
          seq={showingReactorsFor}
          reactions={reactorsMessage.reactions}
          viewerId={userId}
          onToggle={(emoji) => void react(showingReactorsFor, emoji)}
          onDismiss={() => setShowingReactorsFor(null)}
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
        Deleting the poll, which is a bigger thing than deleting the message that announced it.

        The same centred dialog, and deliberately so: two destructive confirmations that look
        alike are safer than two that do not, because the words are what the reader is meant to
        be reading rather than the shape.
      */}
      {confirmingPollDelete !== null && (
        <View style={styles.dialogBackdrop}>
          <Pressable
            style={StyleSheet.absoluteFill}
            onPress={() => {
              setConfirmingPollDelete(null);
              setSelected(null);
            }}
            accessibilityRole="button"
            accessibilityLabel="Keep this poll"
          />
          <View style={styles.dialog}>
            <Text style={styles.dialogTitle}>Delete Poll</Text>
            <Text style={styles.dialogBody}>
              The poll and every vote cast in it go with it, and its card disappears from this
              conversation. This cannot be undone.
            </Text>
            <View style={styles.dialogActions}>
              <Pressable
                style={styles.dialogButton}
                onPress={() => {
                  setConfirmingPollDelete(null);
                  setSelected(null);
                }}
                accessibilityRole="button"
                accessibilityLabel="No, keep this poll"
              >
                <Text style={styles.dialogButtonLabel}>No</Text>
              </Pressable>
              <Pressable
                style={styles.dialogButton}
                onPress={() => {
                  const pollId = confirmingPollDelete;
                  setConfirmingPollDelete(null);
                  setSelected(null);
                  // After the write lands, as with closing. See `onSetPollClosed`.
                  void pollApi.remove(pollId).then(notifyChanged, notifyChanged);
                }}
                accessibilityRole="button"
                accessibilityLabel="Yes, delete this poll"
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
        Straight after a DM report: the control that actually stops it.

        Reporting is reviewed and blocking is instant, and until now the two lived on opposite
        sides of the screen - Report on the message menu, Block on the conversation header. The
        moment somebody has just reported is the one moment we know they want the other one, so it
        is offered here rather than left to be found.

        Dismissing is a real answer, not a failure: the report stands either way, and somebody may
        well want it looked at without cutting the person off. So the dismiss reads "No thanks"
        rather than "Cancel", which would imply it undid the report.
      */}
      {offerBlock !== null && (
        <View style={styles.dialogBackdrop}>
          <Pressable
            style={StyleSheet.absoluteFill}
            onPress={() => setOfferBlock(null)}
            accessibilityRole="button"
            accessibilityLabel="Do not block"
          />
          <View style={styles.dialog}>
            <Text style={styles.dialogTitle}>
              Block {offerBlock.name.split(" ")[0] ?? "them"}?
            </Text>
            <Text style={styles.dialogBody}>
              They will not be able to message you, and neither of you will appear in the other's
              search. You keep this conversation and can unblock any time.
            </Text>
            <View style={styles.dialogActions}>
              <Pressable
                style={styles.dialogButton}
                onPress={() => setOfferBlock(null)}
                accessibilityRole="button"
                accessibilityLabel="Do not block"
              >
                <Text style={styles.dialogButtonLabel}>No thanks</Text>
              </Pressable>
              <Pressable
                style={styles.dialogButton}
                onPress={() => {
                  const target = offerBlock.userId;
                  setOfferBlock(null);
                  void dmApi
                    .block(target)
                    .then(() => setNotice("Blocked. They cannot message you."))
                    .catch(() => setNotice("Could not block them. Try again."));
                }}
                accessibilityRole="button"
                accessibilityLabel={`Block ${offerBlock.name}`}
              >
                <Text style={[styles.dialogButtonLabel, styles.destructive]}>Block</Text>
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
        /*
          A `BlurView`, like the header and the pinned strip, so the bar is a translucent layer
          rather than a painted one - the chrome of this screen is glass at the top and now at the
          bottom too, instead of glass at one end and a slab at the other.
        */
        <BlurView intensity={60} tint="light" style={styles.composerBar}>
          {/*
            The accent wash is this View, between the blur and the row.

            > **Not a `backgroundColor` on the `BlurView`, and not an absolutely-positioned overlay
            > inside it.** The first is invisible - the blur material is drawn over the host view's
            > own background, so the colour ends up behind the frosting. The second paints over its
            > own siblings on web, where CSS puts positioned elements above static ones, while on
            > native it sits behind them: the same code, two results, and the web one turned the
            > message field peach.
            >
            > A parent cannot have that argument with its children. It tints, they draw on top.
          */}
          <View style={[styles.composer, { paddingBottom: composerFloor }]}>
          {/*
            The "+", which becomes a keyboard while the panel is standing in for one.

            **One control with two modes, not two controls.** The panel occupies the keyboard's
            space, so the way back to typing has to be where the way out of typing was - and the
            glyph naming its destination is the only thing that says the panel is a mode you can
            leave rather than a menu that ate the keyboard.

            Disabled while bytes are in flight rather than hidden, so a second tap cannot start a
            concurrent upload and the reason is visible.
          */}
          <Pressable
            style={[styles.attachButton, uploading && styles.sendDisabled]}
            onPress={toggleAttach}
            disabled={uploading}
            accessibilityRole="button"
            accessibilityState={{ expanded: attachOpen }}
            accessibilityLabel={
              uploading
                ? "Uploading an attachment"
                : attachOpen
                  ? "Show the keyboard"
                  : "Attach a photo or file"
            }
          >
            {uploading ? (
              <ActivityIndicator color={color.accent} />
            ) : attachOpen ? (
              <MaterialIcons name="keyboard" size={24} color={color.accent} />
            ) : (
              <Text style={styles.attachLabel}>+</Text>
            )}
          </Pressable>
          <TextInput
            ref={inputRef}
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
            /*
              One row until there is more than one row of text.

              This is a `<textarea>` on web, whose default is **two** rows - so the empty field
              came up a whole line taller than the field it is a copy of on the device, and the
              bar with it. It is Android-only on native, which is to say a no-op on the platform
              this is drawn for, and the fix for the one where it is visible.
            */
            numberOfLines={1}
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
          {/*
            Send appears when there is something to send, and is a disc rather than a word.

            > **It used to be a permanent SEND slab**, greyed out for the whole time somebody was
            > reading rather than typing - a control in its loudest colour, occupying the corner,
            > doing nothing. The founder pointed at WhatsApp: nothing there until you type, then a
            > filled disc with an arrow in it.

            Nothing takes its place when it is gone: the row simply gets shorter, which is what
            makes the bar read as lean.
          */}
          {draft.trim().length > 0 && (
            <Pressable
              style={styles.sendButton}
              onPress={() => void send()}
              accessibilityRole="button"
              accessibilityLabel="Send message"
            >
              <MaterialIcons name="send" size={18} color={color.onAccent} />
            </Pressable>
          )}
          </View>
        </BlurView>
      ) : (
        /*
          A disabled composer that STATES ITS REASON, rather than an input that silently
          rejects. History above is fully readable, which is the point: blocking and losing the
          last shared club both make a thread read-only rather than deleting it.
        */
        <View style={[styles.composerDisabled, { paddingBottom: composerFloor }]}>
          <Text style={styles.composerDisabledText}>
            {DENIED_TEXT[meta?.postDeniedReason ?? "unavailable"]}
          </Text>
        </View>
      )}

      {/*
        Everything the "+" can send, in the keyboard's place - `DESIGN/08` rule 1.

        > **Below the composer, which is the whole point.** It used to open above it, which pushed
        > the composer up the screen and left the keyboard underneath, so the conversation lost two
        > bands of itself at once. Standing where the keyboard stood costs nothing that was not
        > already spent, and the composer does not move at all.

        Its height is the keyboard's own, so the swap is invisible; see `keyboardHeight`. The grid
        scrolls because a scope with polls, events and meetings has more tiles than a short
        keyboard has room for, and a tile nobody can reach is a feature nobody has.
      */}
      {attachOpen && canPost && (
        <View
          style={[
            styles.attachPanel,
            { height: keyboardHeight > 0 ? keyboardHeight : KEYBOARD_FALLBACK_HEIGHT },
          ]}
        >
          <ScrollView
            contentContainerStyle={[styles.attachGrid, { paddingBottom: insets.bottom }]}
          >
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
          </ScrollView>
        </View>
      )}
    </KeyboardAvoider>
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
     * The newest message clears the composer by more than the gutter, so it reads as sitting
     * above the bar rather than tucked beneath it.
     *
     * **This is `paddingTop` and it lands at the BOTTOM**, because the list is inverted: its
     * content starts at the visual bottom, so the padding before the first item is the gap under
     * the newest message. The gutter alone left the last bubble almost touching the composer,
     * reported from the device as the bottom message "getting cut" against it.
     */
    paddingTop: space.lg,
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
  /*
    Tightened 2026-08-12: padding 12 -> 8, and the gap between stacked children 4 -> 2.

    The bubble has to hold the time now as well as the words, and the time claims a line of its
    own. Trading padding for that line is what keeps a short message from growing - the relationship
    to hold is that **the bubble stays close to the size of what it contains**, so if the time ever
    moves back out, this padding should come back up rather than staying tight by inertia.
  */
  bubble: { padding: space.sm, gap: 2 },
  /* Cancels the padding too: a frame of empty space is as much a frame as a tinted one. */
  bubbleBare: { padding: 0, backgroundColor: "transparent" },
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
  mentionInMine: { color: color.accent, fontFamily: fontFamily.bodyBold },

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
    /*
     * **A floor, because a quote cannot widen the bubble it is inside.**
     *
     * A short reply - "Yay", "Haaan" - gives the bubble a tiny content width, and the quote is
     * stretched to whatever that turns out to be. Its text column then has nothing to work with
     * and the quoted name wraps a word at a time: "Par... / Parks / RP...". Measured on web at
     * 79pt of column for a 158pt bubble.
     *
     * The reason it cannot push back was checked rather than assumed: both Texts inside carry
     * `numberOfLines`, which react-native-web implements as `overflow: hidden` plus
     * `max-width: 100%`, and a subtree of those contributes no intrinsic width to an auto-sized
     * ancestor. Forcing a definite width on the wrapper in the browser expanded the column from
     * 79 to 221, which is what identified the sizing rather than the styling as the cause.
     *
     * So the quote states a minimum instead. It stays under the bubble's own 82% cap on the
     * narrowest phone this targets, which is the relationship to preserve if the number moves.
     */
    minWidth: 200,
  },
  quoteTheirs: { backgroundColor: color.appBackground },
  /*
    A white inset rather than the 18%-white wash it was.

    That wash existed to lighten an orange gradient from inside. Over `bubbleSent` it is very
    nearly the fill itself, so the quote box would stop having an edge at all. `card` is the one
    surface that reads as inset on the warmer of the two fills.
  */
  quoteMine: { backgroundColor: color.card },
  quoteBar: {
    alignSelf: "stretch",
    width: 3,
    minHeight: 28,
    borderRadius: radius.pill,
    backgroundColor: color.accent,
  },
  /*
    Identical to `quoteBar` now, and the key is kept on purpose rather than deleted.

    Every one of these `*Mine` overrides existed because the sent bubble was dark. With both fills
    light they collapse onto their `theirs` counterpart - but the sent bubble is expected to get its
    own treatment again, so the seam stays where the call sites already reach for it.
  */
  quoteBarMine: { backgroundColor: color.accent },
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
  /*
    `flexGrow` and `flexShrink`, never the `flex: 1` shorthand.

    > **`flex: 1` is `flexBasis: 0%`, which is the column telling the layout its natural width is
    > nothing.** That was survivable while the message row was a horizontal flex - a bubble measured
    > along the MAIN axis takes its content's max width, and the quote inherited a definite width to
    > divide up. The row became a column when the avatar moved above the bubble, so the bubble's
    > width is now a CROSS-axis fit-content measurement, and a zero-basis child contributes zero to
    > it. Every reply collapsed to the width of its own body text and wrapped the quoted name one
    > letter at a time: "Par... / Parks / RP...".

    Growing and shrinking with an `auto` basis is what was always meant: contribute your content's
    width to the bubble, then be willing to give it back so `numberOfLines` truncates.
  */
  quoteColumn: { flexGrow: 1, flexShrink: 1, minWidth: 0, gap: 1 },
  quoteSender: { ...type.label, fontSize: 10, color: color.accent },
  quoteSenderMine: { color: color.accent },
  quotePreview: { ...type.bodySmall, fontSize: 12, color: color.textSecondary },
  quotePreviewMine: { color: color.textSecondary },
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
  /*
    Not `alignItems: center`.

    > **Everything used to be centred and the menu was full width**, which made a menu of four
    > short words occupy the middle of the screen and read as a modal page rather than as
    > something attached to the message you are holding. The founder's reference is WhatsApp's:
    > each panel sized to its own content and sitting on the message's own side.

    Children pick their side with `alignSelf`, which is why this stretches rather than centring.
  */
  overlayContent: { padding: space.md, gap: space.sm },
  /* Absolute once anchored, so `top` can place it against the message it belongs to. */
  overlayContentAnchored: { position: "absolute", left: 0, right: 0 },
  overlayContentMeasuring: { opacity: 0 },
  overlayEmojiBar: {
    flexDirection: "row",
    alignItems: "center",
    /* Sized to the emoji, on the message's side. */
    alignSelf: "flex-start",
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
  /* Filled, so the way to everything else reads as a control rather than a seventh emoji. */
  overlayEmojiMore: { backgroundColor: color.cardSunken },
  overlayBubble: {
    alignSelf: "flex-start",
    maxWidth: "88%",
    backgroundColor: color.card,
    borderRadius: radius.lg,
    padding: space.md,
    gap: space.xs,
  },
  /* The held-message preview has to be the bubble you are holding, so it tracks the same fill. */
  overlayBubbleMine: { alignSelf: "flex-end", backgroundColor: color.bubbleSent },
  overlayBubbleSender: { ...type.label, color: color.textSecondary, textTransform: "none" },
  overlayBubbleBody: { ...type.body, color: color.textPrimary },
  /*
    Sized to its longest label rather than to the screen.

    `minWidth` so a two-item menu is still a menu rather than a pair of chips, and `maxWidth` so a
    long label wraps instead of reaching the far edge. No `width`, which is the whole change.
  */
  overlayMenu: {
    alignSelf: "flex-start",
    minWidth: 190,
    maxWidth: 260,
    backgroundColor: color.card,
    borderRadius: radius.lg,
    overflow: "hidden",
    shadowColor: "#000",
    shadowOpacity: 0.12,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 6 },
    elevation: 4,
  },
  /* Icon then label, reading order, as the reference has it - and tighter than a form row. */
  overlayMenuItem: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm + 4,
    paddingHorizontal: space.md,
    paddingVertical: space.sm + 4,
  },
  /* On its own side, so the menu hangs under the bubble it belongs to rather than mid-screen. */
  overlaySideMine: { alignSelf: "flex-end" },
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
  /*
    Everyone who reacted, arriving from the bottom edge rather than in the middle of the screen.

    **The same presentation as the emoji picker**, deliberately: both open from the reaction row,
    and one sliding up while the other appeared centred read as two unrelated surfaces built by
    two different people. It hugs its content up to a cap, so three reactors get a short sheet
    and thirty get a scrolling one.
  */
  reactorBackdrop: { flex: 1, justifyContent: "flex-end" },
  /*
    The dimming, as its own layer rather than a colour on the backdrop.

    It has to be able to fade on its own: the sheet slides and the shade does not, and the two
    sharing a view is precisely what made the dimming travel up the screen with the panel.
  */
  reactorScrim: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: "rgba(0,0,0,0.35)",
  },
  reactorSheet: {
    maxHeight: "70%",
    backgroundColor: color.card,
    borderTopLeftRadius: radius.xl,
    borderTopRightRadius: radius.xl,
    paddingHorizontal: space.md,
    paddingTop: space.sm,
    gap: space.sm,
  },
  /* The grabber says "this came from the edge" before a word of it has been read. */
  reactorGrabber: {
    alignSelf: "center",
    width: 36,
    height: 4,
    borderRadius: radius.pill,
    backgroundColor: color.fallback,
  },
  reactorHead: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  reactorRow: { flexDirection: "row", alignItems: "center", gap: space.md, paddingVertical: space.sm },
  reactorText: { flex: 1, gap: 2 },
  reactorName: { ...type.headline, color: color.textPrimary },
  /* Only your own row says this, because only your own row does anything when tapped. */
  reactorHint: { ...type.bodySmall, color: color.textSecondary },
  /*
    The emoji this person used, at the end of their row.

    Larger than the pill's copy of the same character: a pill is a count with a glyph on it and
    this is the answer to "which one did they pick", read down a column of faces.
  */
  reactorEmoji: { fontSize: 20, lineHeight: 26 },
  reactorEmpty: { ...type.bodySmall, color: color.textSecondary, paddingVertical: space.md },
  reactorBusy: { paddingVertical: space.lg },

  /**
   * The message row: an author line, then the bubble, then any reactions.
   *
   * > **It was a horizontal flex of avatar-then-bubble**, v1's arrangement, wrapping so the
   * > reaction pills fell underneath rather than becoming a third column. The founder moved the
   * > avatar up beside the name on 2026-08-13, which leaves nothing to sit beside - so this is a
   * > plain column and the wrap it needed is gone with the layout that needed it.
   *
   * `alignItems` is what sides a message now. It has to be stated in BOTH directions: the default
   * is `stretch`, which would pull every bubble out to its 82% maximum and make a one-word message
   * as wide as a paragraph.
   */
  messageRow: { alignItems: "flex-start", marginBottom: space.xs },
  messageRowMine: { alignItems: "flex-end" },
  /*
    A spacer the height of an author line, for a row that has none yet.

    > **It was the width of an avatar**, holding the bubble's left edge still while the avatar sat
    > in a column beside it. The jump it exists to prevent is vertical now: an optimistic row gains
    > its author line the moment the ack lands, and without this the bubble slides up by the height
    > of a face as it does.
  */
  avatarSpacer: { height: AVATAR_SIZE + space.sm },
  /** Was `bubbleHeader`, when the name shared this row. It holds the pin marker alone now. */
  pinRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.xs,
    marginBottom: space.xs,
  },
  bubbleWrapMine: { maxWidth: "82%" },
  bubbleWrapTheirs: { maxWidth: "82%" },
  /*
    Both fills are LIGHT, and everything below this line follows from that one fact.

    The sent bubble carried white on an orange gradient, so every `mine` variant in this file was
    picked to survive on it. With the fill light, each of those is unreadable rather than merely
    off, which is why this is a block of changes and not a background swap.

    The received bubble drops the hairline border it had over near-white. `bubbleReceived` is
    translucent grey on `appBackground`, which separates it from the page on its own; a border on
    top of a fill that already reads is a second edge doing the first one's job.
  */
  sent: {
    backgroundColor: color.bubbleSent,
    borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg,
    borderBottomLeftRadius: radius.xs,
    borderBottomRightRadius: radius.lg,
  },
  received: {
    backgroundColor: color.bubbleReceived,
    borderTopLeftRadius: radius.xs,
    borderTopRightRadius: radius.lg,
    borderBottomLeftRadius: radius.lg,
    borderBottomRightRadius: radius.lg,
  },
  pending: { opacity: 0.6 },
  pendingLabel: { ...type.label, color: color.textSecondary },
  /* Was white-on-orange. `error` is the token that already means this, and it reads on both. */
  failed: {
    ...type.label,
    color: color.error,
    textDecorationLine: "underline",
  },
  sentText: { ...type.body, fontSize: 15, color: color.textPrimary },
  receivedText: { ...type.body, fontSize: 15, color: color.textPrimary },
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
  /*
    A card row: full width, no bubble, no avatar.

    > **Cards used to be drawn inside their creator's bubble**, which is what they are - a thing
    > somebody posted. The founder's 2026-08-13 mockup takes them out of it, and the reason holds:
    > a poll is addressed to the room rather than said to it, exactly like an announcement, and
    > the 82% bubble width was squeezing option bars whose whole job is to be comparable lengths.
    > Attribution did not go anywhere - it moved into the card's own meta line, which is where the
    > mockup puts it.

    A plain column, unlike `messageRow` - which is a horizontal flex of avatar-then-bubble and
    needs `flexWrap` to stop the reaction pills becoming a third column. With no avatar there is
    nothing to sit beside, so the pills stack underneath on their own.
  */
  cardRow: { marginBottom: space.xs },
  /*
    Who posted it, above the card rather than inside it.

    > **Attribution started in the card's own meta line** when cards left the bubble on
    > 2026-08-13, and came back out the same day at the founder's request: a card should be
    > introduced the way a message is. The difference from `messageRow` is that the avatar sits
    > ABOVE the card beside the name rather than to the left of it - a card is full width, so
    > there is no column beside it for a face to stand in.

    The card no longer says who made it, so this row is the only attribution and cannot be
    dropped for space.
  */
  authorLine: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm,
    paddingBottom: space.sm,
    alignSelf: "flex-start",
  },
  /*
    Mirrored, not merely moved: `row-reverse` puts the face in the right-hand gutter with the name
    inboard of it, so your own attribution is the reflection of everybody else's rather than the
    same arrangement shunted across.
  */
  authorLineMine: { alignSelf: "flex-end", flexDirection: "row-reverse" },
  /*
    How far the content sits in from its own edge: exactly past the hanging avatar.

    Two styles, one number, because the bubble and the reaction row beneath it have to agree with
    each other and with the name above them. Restating it is how the reaction row ended up 48pt
    off the bubble it belonged to once already.
  */
  authorIndent: { marginLeft: AVATAR_SIZE + space.sm },
  authorIndentMine: { marginRight: AVATAR_SIZE + space.sm },
  authorName: {
    ...type.bodySmallStrong,
    /*
      The primary text colour, at the founder's request.

      > It briefly took the time's `textSecondary` on the reasoning that the name and the time were
      > a matched pair bracketing the bubble. That was true while the time sat outside; the time is
      > back in the corner now, so the name is the darkest thing above the content rather than half
      > of a pair. The card's copy of this line was written in `textSecondary` and had to be
      > corrected, which is why there is now one line rather than two.
    */
    color: color.textPrimary,
  },
  cardPin: { flexDirection: "row", alignItems: "center", paddingBottom: space.xs },
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
  /*
    The composer bar: blurred, with a wash of the accent rather than a flat panel colour.

    The founder asked for WhatsApp's translucency in our own colour. It is a *wash*, a few percent
    of the accent, because this bar sits under every conversation all day: enough to tint the
    light coming through it, nowhere near enough to compete with a message bubble or with the Send
    control, which are the two things in this row that are supposed to be seen.
  */
  composerBar: {
    borderTopWidth: 1,
    // The hairline is the same accent, a shade stronger, so the bar has an edge without a rule
    // drawn across the screen in a colour that belongs to nothing else.
    borderTopColor: COMPOSER_WASH_EDGE,
  },
  composer: {
    flexDirection: "row",
    alignItems: "flex-end",
    gap: space.xs,
    paddingHorizontal: space.sm,
    paddingTop: space.sm,
    // `paddingBottom` is supplied at render: it is the home indicator's, not a constant.
    backgroundColor: COMPOSER_WASH,
  },
  /* The same bar in a read-only conversation, so losing the ability to post does not also
     change what the bottom of the screen is made of. */
  composerDisabled: {
    paddingHorizontal: space.md,
    paddingTop: space.md,
    backgroundColor: COMPOSER_WASH,
    borderTopWidth: 1,
    borderTopColor: COMPOSER_WASH_EDGE,
    alignItems: "center",
  },
  composerDisabledText: {
    ...type.bodySmall,
    color: color.textSecondary,
    textAlign: "center",
  },
  /*
    A pill, and the only filled shape in the row when nothing is being sent.

    Rounded to its own height rather than to a radius token, so it stays a pill as it grows with
    a long message instead of turning into a rounded box at three lines.
  */
  input: {
    flex: 1,
    maxHeight: 120,
    minHeight: COMPOSER_CONTROL,
    backgroundColor: color.card,
    borderRadius: COMPOSER_CONTROL / 2,
    borderWidth: 1,
    borderColor: color.divider,
    paddingHorizontal: space.md,
    // Enough to clear one line of `body` and no more: the padding is what decides whether the
    // field reads as a pill beside the send disc or as a box that dwarfs it.
    paddingVertical: space.xs + 1,
    ...type.body,
    color: color.textPrimary,
  },
  sendButton: {
    width: COMPOSER_CONTROL,
    height: COMPOSER_CONTROL,
    borderRadius: COMPOSER_CONTROL / 2,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: color.accent,
  },
  sendDisabled: { opacity: 0.4 },
  /*
    The flanking controls are glyphs, not chips.

    They wore a white disc with a hairline, which made three framed objects in a row that is
    mostly one input - the founder's word for the bar he wanted was "leaner". The tap target keeps
    its full size; only the paint is gone.
  */
  attachButton: {
    width: COMPOSER_CONTROL,
    height: COMPOSER_CONTROL,
    borderRadius: COMPOSER_CONTROL / 2,
    alignItems: "center",
    justifyContent: "center",
  },
  // Same footprint as the "+", so the composer's two flanking controls line up.
  announceButton: {
    width: COMPOSER_CONTROL,
    height: COMPOSER_CONTROL,
    borderRadius: COMPOSER_CONTROL / 2,
    alignItems: "center",
    justifyContent: "center",
  },
  // Armed, it fills: the one state in this row that must be unmistakable, because an
  // announcement posted by accident cannot be recalled.
  announceButtonArmed: { backgroundColor: color.accent },
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
  /*
   * The back control, shaped to match the one iOS draws on every OTHER screen.
   *
   * > **Chat is the only screen that draws its own header, so it is the only one that does not
   * > get the system's back button.** Everywhere else the navigator hands `headerLeft` to UIKit,
   * > which wraps it in a near-white capsule with the accent arrow inside. This header is plain
   * > views, so it got a hand-rolled 36pt circle with a faint grey wash and a BLACK arrow -
   * > close enough to look deliberate and different enough to read as another app one tap away.
   *
   * Measured off a screen recording rather than guessed: 384x848 against a 393x852pt device, so
   * a pixel is a point and the system capsule is 62 wide by 44 tall, inset by the content gutter.
   * Written as literals because they are not ours to choose - they are a copy of something
   * else's, and a token would imply this file gets a say in them.
   *
   * > **Deliberately SMALLER than the system's, which was tried and rejected on the device.**
   * > Once Highlights moved into the overflow menu there was room for the full 62x44, and it was
   * > restored on exactly that reasoning - the space existed, so why not match. Seen on a phone,
   * > it was wrong: at full size the two capsules dominate a header whose job is to name the
   * > conversation, and the row reads as a toolbar with a title squeezed into it rather than a
   * > title with controls either side.
   * >
   * > The lesson is the one this file keeps relearning. **Room to do something is not a reason
   * > to do it.** The measurement said what the system draws; it never said what this header
   * > needs, and those are different questions.
   *
   * So the TREATMENT is copied and the SIZE is not: capsule shape, near-white fill, accent glyph,
   * at the scale this row can carry.
   *
   * **It is an imitation and will not follow iOS if Apple restyles the bar.** The alternative was
   * moving chat onto the native header, which would earn the real thing and cost the blur; that
   * trade was considered and declined.
   */
  backButton: {
    width: 48,
    height: 40,
    // Clamps to half the height, so this is a capsule rather than a rounded rectangle.
    borderRadius: radius.pill,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: color.card,
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
  /*
    The attachment panel, which stands in the keyboard's place.

    Sunken rather than chrome, so it reads as the space the keyboard came out of and the composer
    still reads as a bar sitting on top of something. Its height is supplied at render and is the
    keyboard's own - see `KEYBOARD_FALLBACK_HEIGHT` for the one case where it cannot be.
  */
  attachPanel: { backgroundColor: color.cardSunken, overflow: "hidden" },
  attachGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    paddingHorizontal: space.sm,
    paddingTop: space.md,
  },
  /*
    Four to a row, by width rather than by a fixed size: the row has to divide the screen evenly
    on a phone of any width, and a fixed tile leaves a ragged gap on the wide ones.
  */
  attachTile: { width: "25%", alignItems: "center", gap: space.xs, marginBottom: space.lg },
  attachTileIcon: {
    width: 56,
    height: 56,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
  },
  attachTileLabel: { ...type.bodySmall, color: color.textPrimary },

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

  /*
   * The overflow control, matched to the back control beside it.
   *
   * Left grey when the back button became a capsule, and the result was a header with a white
   * capsule at one end and a grey disc at the other - which read as unfinished rather than as
   * two different kinds of control, because they are not two different kinds of control. They
   * are the two bar buttons on one bar.
   *
   * Height and fill match the back control; width is whatever the glyph needs, which is less.
   * Matching the two properties that were actually mismatched - the wash and the icon colour -
   * is what makes them read as a set. Width never carried that meaning, and a back arrow is
   * wider than a single column of dots in the system's own bar too.
   */
  headerAction: {
    width: 40,
    height: 40,
    borderRadius: radius.pill,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: color.card,
  },
  /** v1's pinned notice strip. `flexGrow: 0` keeps the row from claiming the list's height. */
  /*
   * The clipping box, whose height is animated.
   *
   * `overflow: hidden` is what makes the slide a slide: without it the content translating up
   * simply draws over the header instead of disappearing behind it, which looks like a bug
   * rather than like motion.
   */
  pinnedStripClip: { overflow: "hidden" },
  pinnedStrip: {
    flexGrow: 0,
    paddingHorizontal: space.md,
    paddingTop: space.sm,
  },
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
  metaRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.xs,
    flexWrap: "wrap",
    marginTop: space.xs,
    // Full width is what makes the wrapping row above break BEFORE this, putting the reactions
    // and the time on their own line rather than alongside the bubble.
    width: "100%",
  },
  /*
   * Aligned under the bubble it belongs to, on whichever side that sits. `justifyContent` rather
   * than `alignSelf`, because at full width there is no free space for `alignSelf` to move into.
   *
   * > **Theirs used to be inset past the avatar**, back when one stood in a column to the left of
   * > the bubble. With the avatar above the message there is no column to clear, and the inset
   * > that survived the move would have pushed every reaction row 48pt off its own bubble's edge.
   */
  metaRowMine: { justifyContent: "flex-end" },
  metaRowTheirs: { justifyContent: "flex-start" },
  /*
    The time, in the bubble's bottom-right corner. Same token on both fills, since both are light.

    `marginTop: -2` cancels the bubble's own child gap for this one child: the time is metadata
    tucked under the last line rather than another stacked block, so it sits closer to the words
    than the words sit to a quote above them.
  */
  bubbleTime: {
    ...type.label,
    color: color.textSecondary,
    textTransform: "none",
    alignSelf: "flex-end",
    marginTop: -2,
  },
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
