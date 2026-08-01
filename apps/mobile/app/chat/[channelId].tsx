import { useCallback, useEffect, useRef, useState } from "react";
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
  reactionEmoji,
  reactionSummary,
  SYSTEM_ACTOR_ID,
  type MessageEnvelope,
  type ReactionEmoji,
} from "@clubchat/shared";
import { useSession } from "../../src/chat-provider.tsx";
import { channelApi, dmApi, type ChannelMeta } from "../../src/api.ts";
import { DocumentBubble, PhotoBubble } from "../../src/media-bubble.tsx";
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
import { BlurView } from "expo-blur";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { MaterialIcons } from "@expo/vector-icons";
import { Avatar } from "../../src/ui.tsx";
import { ChatEventCard } from "../../src/screens/events.tsx";
import { ChatMeetingCard } from "../../src/screens/meetings.tsx";
import { ChatPollCard } from "../../src/screens/polls.tsx";
import { QuickNav, spaceProfileHref, useGoBack } from "../../src/nav.tsx";
import { color, radius, space, type } from "../../src/theme.ts";

type Row =
  | { kind: "message"; message: MessageEnvelope }
  /** An optimistic row from the send outbox, not yet acked. */
  | {
      kind: "pending";
      clientMsgId: string;
      body: string;
      failed: boolean;
      /** Mirrors the outbox entry, announcements included - see `store.ts`. */
      type: "text" | "photo" | "document" | "announcement";
      /** Renders the photo the sender just picked, before any round trip. */
      localUri?: string | undefined;
      documentName?: string | undefined;
      documentSize?: number | undefined;
    };

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
  /** Set once Report is tapped, so the confirmation is a second deliberate step. */
  const [confirmingReport, setConfirmingReport] = useState<number | null>(null);
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
  /** The grid dropdown of this conversation's other screens. */
  const [gridOpen, setGridOpen] = useState(false);
  /** True while bytes are in flight, so the "+" cannot start a second upload. */
  const [uploading, setUploading] = useState(false);
  const listRef = useRef<FlatList<Row>>(null);
  /**
   * Whether the reader is sitting at the live tail.
   *
   * > **This is what makes the scroll-to-end conditional, and it has to be.** The list scrolls to
   * > the end on every content size change, which is right for a new message and catastrophic for
   * > everything else that changes a row's height after it is laid out. A card fetches its subject
   * > by id and renders nothing until that lands, so it grows by ~180px a moment after the row
   * > appears; a photo does the same when its bytes arrive. Scrolling up to read history and
   * > having any of those resolve used to yank the log back to the bottom, repeatedly, because
   * > every card resolves on its own schedule.
   *
   * So the rule is the standard one: **pin to the tail only if we were already at the tail.**
   * Starts true so the first layout still opens at the newest message, which is chat's whole
   * arrival behaviour.
   *
   * A ref rather than state on purpose - it is read inside scroll handlers that fire at frame
   * rate, and re-rendering the entire log on each one would be its own defect.
   */
  const atTailRef = useRef(true);
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

  // Newest first, so the most recent notice is the one already in view rather than the one you
  // have to scroll the strip sideways to reach. A tombstone is dropped outright: a deleted
  // message is not worth keeping pinned above the conversation.
  const pinnedRows = rows
    .flatMap((row) => (row.kind === "message" ? [row.message] : []))
    .filter(
      (message) =>
        message.pinned &&
        message.deletedAt === null &&
        !dismissedPins.has(message.seq),
    )
    .reverse();

  /**
   * Load the channel's title and whether the composer is live.
   *
   * One endpoint for all four scopes, so this screen stays a single implementation rather than
   * forking for DMs. A failure here is not fatal: history still renders from the local cache,
   * which is what makes the screen work in airplane mode.
   */
  const loadMeta = useCallback(async () => {
    if (!channelId) return;
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
   * Jump to a message named in the URL.
   *
   * > **This is what `GET /channels/:id/messages/around` exists for.** Highlights, a pinned-strip
   * > notice and a mention notification all name a specific `seq`, and paging backward from the tail
   * > until it appears cannot satisfy "jumps on the FIRST tap" - the message is not loaded yet, so a
   * > first tap could only start fetching.
   *
   * The window is written into the local store rather than held in this component, so it is cached
   * like every other page of history and a second jump to the same place needs no network at all.
   * Failing is survivable: the chat still renders its tail, which is the "realtime and paging are
   * enhancements" rule applied to navigation.
   */
  useEffect(() => {
    const target = Number(around);
    if (!client || !channelId || !Number.isInteger(target) || target <= 0)
      return;

    let alive = true;
    void (async () => {
      try {
        const window = await channelApi.around(channelId, target);
        if (!alive) return;
        await client.store.upsert(window.messages);
        await refresh();
      } catch {
        // Leave the tail on screen. A jump that cannot load is a worse outcome than a jump that
        // does not happen, and the notice below says which.
        if (alive) setNotice("Could not open that message.");
      } finally {
        if (alive) setJumpedTo(target);
      }
    })();
    return () => {
      alive = false;
    };
  }, [client, channelId, around, refresh]);

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
    const index = rows.findIndex(
      (row) => row.kind === "message" && row.message.seq === jumpedTo,
    );
    if (index < 0) return;
    listRef.current?.scrollToIndex({
      index,
      viewPosition: 0.5,
      animated: false,
    });
  }, [jumpedTo, rows]);

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
    client.markRead(channelId, channel?.lastSeq ?? 0);
  }, [client, channelId, revision]);

  if (authState === "checking") {
    return (
      <View style={styles.centered}>
        <ActivityIndicator color={color.accent} />
      </View>
    );
  }
  if (authState === "signed-out") return <Redirect href="/sign-in" />;

  const canPost = meta === null ? true : meta.canPost;

  const send = async () => {
    const body = draft.trim();
    if (body.length === 0 || !client || !channelId || !canPost) return;
    setDraft("");
    /*
      Sending is a deliberate return to the tail, wherever the reader had scrolled to.
      Posting from halfway up the history and being left there, unable to see what you just
      said, is the one case where NOT following the tail would be the wrong answer.
    */
    atTailRef.current = true;
    // Disarmed as the message goes, so the NEXT one is an ordinary message. An announcement
    // toggle that stays armed is how somebody posts three of them by accident, and each one
    // notifies the whole space.
    const announcing = asAnnouncement;
    setAsAnnouncement(false);
    try {
      await client.sendWithRetry(
        channelId,
        body,
        announcing ? { type: "announcement" } : {},
      );
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
  const setPinned = async (seq: number, pinned: boolean) => {
    if (!channelId) return;
    setSelected(null);
    try {
      await channelApi.setPinned(channelId, seq, pinned);
      setNotice(pinned ? "Pinned." : "Unpinned.");
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
      // keeps the gapless sequence gapless.
      setNotice("Message deleted.");
    } catch {
      setNotice("Could not delete that. Try again.");
    }
    await refresh();
  };

  /**
   * Toggle a reaction.
   *
   * Optimistic, and reconciled from the response rather than from a locally-guessed set: the
   * server returns the full resulting set, which is also what arrives over the socket for
   * everybody else. Two devices held by the same member therefore converge on the same answer
   * without either one having to have guessed right.
   */
  const react = async (seq: number, emoji: ReactionEmoji) => {
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
      // Same deliberate return to the tail as a typed message. See `send`.
      atTailRef.current = true;
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

  const retry = async (clientMsgId: string) => {
    if (!client) return;
    try {
      await client.flushOne(clientMsgId);
    } catch {
      /* stays failed, still visible */
    }
    await refresh();
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
          disabled={spaceScope === undefined}
          onPress={() =>
            spaceScope !== undefined &&
            meta !== null &&
            router.push(spaceProfileHref(spaceScope, meta.scopeId))
          }
          accessibilityRole={spaceScope === undefined ? undefined : "button"}
          accessibilityLabel={
            spaceScope === undefined || meta === null
              ? undefined
              : `${meta.name}. Open its profile`
          }
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
            <Pressable
              onPress={() => setGridOpen((open) => !open)}
              accessibilityRole="button"
              accessibilityLabel="This conversation's screens"
              hitSlop={space.sm}
              style={styles.headerAction}
            >
              <MaterialIcons name="grid-view" size={18} color={color.textPrimary} />
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
            <MaterialIcons name="more-horiz" size={20} color={color.textPrimary} />
          </Pressable>
        )}
      </BlurView>

      {/*
        The grid dropdown: where this conversation's other screens live.

        Anchored under the header rather than shown as a permanent strip, because these are places
        you go occasionally and a row of six chips above every conversation spends the screen's
        most valuable space on navigation.
      */}
      {gridOpen && meta !== null && meta.scope !== "dm" && (
        <>
          <Pressable
            style={styles.gridScrim}
            onPress={() => setGridOpen(false)}
            accessibilityRole="button"
            accessibilityLabel="Close"
          />
          <View style={styles.gridMenu}>
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
                onPress={() => setJumpedTo(message.seq)}
                accessibilityRole="button"
                accessibilityLabel="Jump to this pinned message"
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
          data={rows}
          keyExtractor={(row) =>
            row.kind === "message"
              ? `m-${row.message.seq}`
              : `p-${row.clientMsgId}`
          }
          contentContainerStyle={styles.list}
          /*
            Chat opens at the tail, and follows it while the reader is AT the tail.

            Two things suppress the scroll, and they suppress different mistakes. `jumpedTo` is the
            deliberate one: a jump sent us somewhere specific and scrolling to the end would
            immediately undo it. `atTailRef` is the one that was missing - without it this fires on
            every content size change, including a card resolving its fetch 200ms after its row was
            laid out, which drags a reader who is halfway up the history back down to the bottom.
          */
          onContentSizeChange={() => {
            if (jumpedTo === null && atTailRef.current)
              listRef.current?.scrollToEnd({ animated: false });
          }}
          /*
            Recomputed as the reader moves, so the rule above knows whether following the tail is
            what they want. The threshold is deliberately not zero: a list can sit a pixel or two
            short of the bottom after a layout pass, and "near enough the tail" is what the reader
            experiences as being at it.
          */
          scrollEventThrottle={16}
          onScroll={(event) => {
            const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
            const fromBottom =
              contentSize.height - layoutMeasurement.height - contentOffset.y;
            atTailRef.current = fromBottom <= TAIL_SLACK;
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
            <View style={styles.empty}>
              <Text style={styles.emptyTitle}>No messages yet</Text>
              <Text style={styles.emptyBody}>
                Say something to get started.
              </Text>
            </View>
          }
          renderItem={({ item }) => {
            if (item.kind === "pending") {
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
                      {item.type === "photo" && (
                        <PhotoBubble
                          mediaId={null}
                          localUri={item.localUri}
                          mine
                        />
                      )}
                      {item.type === "document" && (
                        <DocumentBubble
                          name={item.documentName ?? null}
                          size={item.documentSize ?? null}
                          mine
                        />
                      )}
                      {item.body.length > 0 && (
                        <Text style={styles.sentText}>{item.body}</Text>
                      )}
                      {item.failed ? (
                        <Pressable
                          onPress={() => void retry(item.clientMsgId)}
                          accessibilityRole="button"
                          accessibilityLabel="Retry sending this message"
                        >
                          <Text style={styles.failed}>
                            Failed. Tap to retry
                          </Text>
                        </Pressable>
                      ) : (
                        <Text style={styles.pendingLabel}>Sending</Text>
                      )}
                    </BubbleContainer>
                  </View>
                </View>
              );
            }

            const { message } = item;

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

            const mine = message.senderId === userId;
            // Marked so a reader can see WHICH message a jump sent them to. Without it the screen
            // has silently scrolled somewhere and the target is indistinguishable from its
            // neighbours, which is most of the value of jumping.
            const isJumpTarget = jumpedTo === message.seq;

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
                <View
                  style={[styles.announcementWrap, isJumpTarget && styles.jumpTarget]}
                >
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
                  onPress={() => router.push(`/users/${message.senderId}`)}
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
                  // > **A card bubble is not long-pressable, and must not be.** Its contents are
                  // > controls - vote, see voters, close, delete - and a pressable wrapping them
                  // > is failure mode 17: invalid on web, where the browser says "<button> cannot
                  // > contain a nested <button>", and on native the outer gesture swallows the
                  // > vote. So the card owns its own taps and the bubble owns none. The cost is
                  // > that a poll card cannot be reacted to by holding it, which is the right way
                  // > round: voting on it is what it is for.
                  onLongPress={
                    cardId !== null
                      ? undefined
                      : () => {
                          setSelected(message.seq);
                          setConfirmingReport(null);
                        }
                  }
                  delayLongPress={400}
                  // `none`, not `button`, and that is what actually fixes the nesting: react-native-web
                  // renders a Pressable as a real <button> ONLY when its role says so, and a plain
                  // <div> wrapper can hold the card's controls legally. `disabled` was the first
                  // attempt and was worse than the bug - a disabled button disables its descendants,
                  // so every option inside went dead and the card could not be voted on at all.
                  accessibilityRole={cardId !== null ? "none" : "button"}
                  accessibilityLabel={
                    cardId !== null
                      ? undefined
                      : mine
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
                          <Text
                            style={
                              mine ? styles.senderNameMine : styles.senderName
                            }
                          >
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
                          The card bubble cannot be long-pressed - its contents are buttons, and
                          wrapping them in one is failure mode 17 - so the menu gets a visible
                          control instead. v1 draws the same dots in the same corner. Without it,
                          a card is the one message in the log nobody can react to or report.
                        */}
                        <Pressable
                          style={styles.cardMenu}
                          onPress={() => {
                            setSelected(message.seq);
                            setConfirmingReport(null);
                          }}
                          hitSlop={space.sm}
                          accessibilityRole="button"
                          accessibilityLabel={
                            mine
                              ? "React to your card"
                              : "React to or report this card"
                          }
                        >
                          <MaterialIcons
                            name="more-vert"
                            size={18}
                            color={mine ? color.onAccent : color.textSecondary}
                          />
                        </Pressable>
                      </>
                    ) : (
                      /* A photo may carry a caption, and usually does not. */
                      message.body !== null &&
                      message.body.length > 0 && (
                        <Text style={mine ? styles.sentText : styles.receivedText}>
                          {message.body}
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
                  The reaction row, rendered under the bubble it belongs to and aligned with
                  it. Only emoji anyone actually used, in the fixed order from the shared
                  constant so the row does not reshuffle as counts change.
                */}
                {(() => {
                  const summary = reactionSummary(message.reactions, userId);
                  if (summary.length === 0) return null;
                  return (
                    <View
                      style={[
                        styles.pillRow,
                        mine ? styles.pillRowMine : styles.pillRowTheirs,
                      ]}
                    >
                      {summary.map((entry) => (
                        <Pressable
                          key={entry.emoji}
                          style={[styles.pill, entry.mine && styles.pillMine]}
                          onPress={() => void react(message.seq, entry.emoji)}
                          accessibilityRole="button"
                          accessibilityLabel={
                            entry.mine
                              ? `Remove your ${entry.emoji} reaction, ${entry.count} total`
                              : `React with ${entry.emoji}, ${entry.count} total`
                          }
                        >
                          <Text style={styles.pillEmoji}>{entry.emoji}</Text>
                          <Text
                            style={[
                              styles.pillCount,
                              entry.mine && styles.pillCountMine,
                            ]}
                          >
                            {entry.count}
                          </Text>
                        </Pressable>
                      ))}
                    </View>
                  );
                })()}

                {selected === message.seq &&
                  confirmingReport !== message.seq && (
                    <View style={styles.actionSheet}>
                      {/*
                      Six large tap targets, which is the whole reason the set is fixed rather
                      than a searchable grid: reacting should cost one tap.
                    */}
                      <View style={styles.emojiRow}>
                        {reactionEmoji.map((emoji) => (
                          <Pressable
                            key={emoji}
                            style={styles.emojiButton}
                            onPress={() => {
                              setSelected(null);
                              void react(message.seq, emoji);
                            }}
                            accessibilityRole="button"
                            accessibilityLabel={`React with ${emoji}`}
                          >
                            <Text style={styles.emojiGlyph}>{emoji}</Text>
                          </Pressable>
                        ))}
                      </View>
                      <View style={styles.reportActions}>
                        <Pressable
                          style={styles.secondaryButton}
                          onPress={() => setSelected(null)}
                          accessibilityRole="button"
                          accessibilityLabel="Close message actions"
                        >
                          <Text style={styles.secondaryLabel}>Close</Text>
                        </Pressable>
                        {/*
                          Pin, for an admin of this space. `canPin` and not `canAnnounce`: in
                          race chat pinning additionally needs a roster row, and the server
                          enforces exactly that - this only decides whether to offer it.
                        */}
                        {meta?.canPin === true && (
                          <Pressable
                            style={styles.secondaryButton}
                            onPress={() =>
                              void setPinned(message.seq, !message.pinned)
                            }
                            accessibilityRole="button"
                            accessibilityLabel={
                              message.pinned
                                ? "Unpin this message"
                                : "Pin this message"
                            }
                          >
                            <Text style={styles.secondaryLabel}>
                              {message.pinned ? "Unpin" : "Pin"}
                            </Text>
                          </Pressable>
                        )}
                        {/*
                          Delete: your own message always, anybody's if you moderate here. The
                          two halves are separate on purpose - a DM has no admin, so neither
                          participant gets the second one.
                        */}
                        {(mine || meta?.canDeleteAnyMessage === true) && (
                          <Pressable
                            style={styles.secondaryButton}
                            onPress={() => setConfirmingDelete(message.seq)}
                            accessibilityRole="button"
                            accessibilityLabel={
                              mine
                                ? "Delete your message"
                                : "Delete this message"
                            }
                          >
                            <Text
                              style={[
                                styles.secondaryLabel,
                                styles.destructive,
                              ]}
                            >
                              Delete
                            </Text>
                          </Pressable>
                        )}
                        {/* Nobody can report their own message, so it is not offered. */}
                        {!mine && (
                          <Pressable
                            style={styles.secondaryButton}
                            onPress={() => setConfirmingReport(message.seq)}
                            accessibilityRole="button"
                            accessibilityLabel="Report this message"
                          >
                            <Text
                              style={[
                                styles.secondaryLabel,
                                styles.destructive,
                              ]}
                            >
                              Report
                            </Text>
                          </Pressable>
                        )}
                      </View>
                    </View>
                  )}

                {confirmingDelete === message.seq && (
                  <View style={styles.actionSheet}>
                    {/* Names what is lost, and does not pretend it can be undone. */}
                    <Text style={styles.reportPrompt}>
                      Delete this message? It is replaced by "This message was deleted" for
                      everyone, and cannot be brought back.
                    </Text>
                    <View style={styles.reportActions}>
                      <Pressable
                        style={styles.secondaryButton}
                        onPress={() => {
                          setConfirmingDelete(null);
                          setSelected(null);
                        }}
                        accessibilityRole="button"
                        accessibilityLabel="Keep this message"
                      >
                        <Text style={styles.secondaryLabel}>Keep</Text>
                      </Pressable>
                      <Pressable
                        style={styles.button}
                        onPress={() => void removeMessage(message.seq)}
                        accessibilityRole="button"
                        accessibilityLabel="Confirm delete"
                      >
                        <Text style={styles.buttonLabel}>Delete</Text>
                      </Pressable>
                    </View>
                  </View>
                )}

                {confirmingReport === message.seq && (
                  <View style={styles.actionSheet}>
                    <Text style={styles.reportPrompt}>
                      {meta?.scope === "dm"
                        ? // No club admin ever sees the contents of a DM, so say where it goes.
                          "Report this to ClubChat moderators?"
                        : "Report this to the admins of this space?"}
                    </Text>
                    <View style={styles.reportActions}>
                      <Pressable
                        style={styles.secondaryButton}
                        onPress={() => {
                          setConfirmingReport(null);
                          setSelected(null);
                        }}
                        accessibilityRole="button"
                        accessibilityLabel="Cancel reporting"
                      >
                        <Text style={styles.secondaryLabel}>Cancel</Text>
                      </Pressable>
                      <Pressable
                        style={styles.button}
                        onPress={() => {
                          setConfirmingReport(null);
                          setSelected(null);
                          void dmApi
                            .report(channelId!, message.seq)
                            .then((result) =>
                              setNotice(
                                result.alreadyReported
                                  ? "You already reported this message."
                                  : "Reported. The other person is not told.",
                              ),
                            )
                            .catch(() =>
                              setNotice("Could not report that. Try again."),
                            );
                        }}
                        accessibilityRole="button"
                        accessibilityLabel="Confirm report"
                      >
                        <Text style={styles.buttonLabel}>Report</Text>
                      </Pressable>
                    </View>
                  </View>
                )}
              </View>
            );
          }}
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
    flexGrow: 1,
    // Anchor to the bottom so a short conversation sits just above the composer rather
    // than stranded at the top under a screen of empty space. With flexGrow alone the
    // content container fills the viewport and leaves the gap below the messages.
    justifyContent: "flex-end",
  },
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
  actionSheet: {
    alignSelf: "flex-start",
    maxWidth: "90%",
    backgroundColor: color.card,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: color.divider,
    padding: space.sm,
    gap: space.sm,
    marginTop: space.xs,
  },
  emojiRow: {
    flexDirection: "row",
    gap: space.xs,
    justifyContent: "space-between",
  },
  emojiButton: {
    // A generous target: this is the control the whole fixed-set decision exists to keep fast.
    minWidth: 44,
    minHeight: 44,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radius.pill,
    backgroundColor: color.appBackground,
  },
  emojiGlyph: { fontSize: 24, lineHeight: 30 },
  pillRow: {
    flexDirection: "row",
    gap: space.xs,
    flexWrap: "wrap",
    marginTop: -space.xs,
  },
  // Aligned under the bubble they belong to, on whichever side it sits.
  pillRowMine: { alignSelf: "flex-end" },
  pillRowTheirs: { alignSelf: "flex-start" },
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
  reportPrompt: { ...type.bodySmall, color: color.textPrimary },
  reportActions: { flexDirection: "row", gap: space.sm },
  button: {
    flex: 1,
    backgroundColor: color.accent,
    borderRadius: radius.sm,
    paddingVertical: space.sm,
    alignItems: "center",
  },
  buttonLabel: {
    ...type.label,
    color: color.onAccent,
    textTransform: "uppercase",
  },
  secondaryButton: {
    flex: 1,
    backgroundColor: color.card,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: color.divider,
    paddingVertical: space.sm,
    alignItems: "center",
  },
  secondaryLabel: {
    ...type.label,
    color: color.textSecondary,
    textTransform: "uppercase",
  },
});
