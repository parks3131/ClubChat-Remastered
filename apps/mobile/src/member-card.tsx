/**
 * A person, as a card that rises from the bottom edge.
 *
 * **The same content as `/users/:id`, presented over the screen that asked for it rather than
 * instead of it.** A roster is a list you are working down - checking who somebody is, then
 * carrying on - and a full screen push makes that a navigation each way. The card keeps the list
 * behind it, dimmed and one tap from being back.
 *
 * The motion is `RisingSheet`, which is the reactor sheet's, which is the one the founder pointed
 * at: the panel travels and the shade does not. Sharing the component rather than the timings is
 * what stops the two drifting into two different products - see the note on `RisingSheet` for the
 * bug that taught us the halves have to animate separately.
 *
 * **Every authority flag here is the server's answer.** `canRemove`, `canBan` and `canLiftBan`
 * come back from `GET /users/:id?clubId=`, and this file never reads a role to decide any of them.
 * The ladders are deliberately asymmetric - removing an Admin is Owner-only, banning follows the
 * same ladder, while ANY admin may lift a ban (ADR-0021) - and a client re-deriving one is how a
 * second definition of a permission starts drifting from the first.
 *
 * **Mute, Clear chat and Report arrived on 2026-08-15**, and the shape of the first two is the
 * part worth reading. They act on a *conversation*, and this card is reached from a roster where
 * there may not be one - so they are offered only when `dm` comes back on the profile read, which
 * says a thread already exists. The card never resolves the channel itself: `POST /dm/threads` is
 * idempotent-create, so asking it "which channel is this" would open a conversation as a side
 * effect of muting one.
 *
 * Report needed a server surface that did not exist, because every report in the product was
 * keyed by `messageId` - the queue, the audited context read, the removal and the dismissal all
 * hang off one. A person report is a `user_reports` row instead, and it goes to platform
 * moderators always rather than routing by scope the way a message report does. See ADR-0035.
 */

import { useCallback, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { accountApi, channelApi, clubApi, dmApi } from './api.ts';
import type { ProfileClubActions, ProfileDmActions, SharedClub } from './api-types.ts';
import { useSession } from './chat-provider.tsx';
import { ARRIVED_FORWARD } from './nav.tsx';
import { color, radius, space, type } from './theme.ts';
import {
  Avatar,
  ConfirmDialog,
  ContextMenu,
  DetailLine,
  RisingSheet,
  measureRow,
  type ContextMenuItem,
  type PressAnchor,
} from './ui.tsx';
import { useLoad } from './use-load.ts';
import { useNotice } from './use-notice.ts';

/** v1's, and the largest avatar any person gets. A club's own picture is bigger; a person's is not. */
const AVATAR_SIZE = 96;

export function MemberCardSheet({
  userId,
  clubId,
  role,
  onDismiss,
  onChanged,
}: {
  userId: string;
  /**
   * The club this card was opened from, when there is one.
   *
   * Present from a club roster, which is the only place club authority makes sense - the same
   * person is bannable by you in one club and untouchable in another. The server answers what may
   * be done with it; this card never works the ladder out itself.
   */
  clubId?: string;
  /** Owner / Admin / Member, from the roster that already knows it. Absent draws none. */
  role?: string | null;
  onDismiss: () => void;
  /** After any write that changes the roster, so the list behind this reloads. */
  onChanged?: () => void;
}) {
  const router = useRouter();
  // `client` is here for Clear chat, which has to drop the local SQLite copy as well as writing
  // the server-side floor - otherwise the cache re-renders exactly what was just hidden.
  const { userId: viewerId, client } = useSession();

  const load = useLoad(() => accountApi.profile(userId, clubId), [userId, clubId]);
  /*
   * The clubs the two of you share, from the read that already answers this - the same second
   * request the full profile screen makes, and for the same reason: a failure here costs the
   * shared-clubs block and not the whole card.
   */
  const shared = useLoad(() => dmApi.sharedClubs(userId), [userId]);
  const sharedList = shared.data?.clubs ?? [];

  /** Where the "..." menu hangs, once the button that opens it has been measured. */
  const [menuAnchor, setMenuAnchor] = useState<PressAnchor | null>(null);
  /*
   * The button's own view, held in a ref rather than in state.
   *
   * A `ref` callback that calls `setState` re-runs on every render - React detaches with null and
   * re-attaches the node whenever the callback's identity changes, which for an inline arrow is
   * always - so storing it in state is an infinite render loop rather than a style preference.
   */
  const menuButton = useRef<View | null>(null);
  const [confirmingBan, setConfirmingBan] = useState(false);
  const [confirmingClear, setConfirmingClear] = useState(false);
  const [confirmingReport, setConfirmingReport] = useState(false);
  /** The shared-clubs list, which the block below opens exactly as the full profile does. */
  const [clubsOpen, setClubsOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /**
   * What a write that STAYS on the card reports back.
   *
   * The three roster writes leave, so their outcome is the roster reloading behind them. Mute,
   * Clear chat and Report all keep the card open, and a control that changes something invisible
   * and says nothing reads as a control that did not work.
   */
  const [notice, setNotice] = useNotice();
  /** Set by an action that is done with this card: plays the exit, then unmounts it. */
  const [leaving, setLeaving] = useState(false);
  /** Where to go once the card has finished leaving, so the two never animate over each other. */
  const [pendingHref, setPendingHref] = useState<string | null>(null);

  const finish = useCallback(() => {
    onDismiss();
    if (pendingHref !== null) router.push(pendingHref);
  }, [onDismiss, pendingHref, router]);

  /** Runs a write, tells the roster behind to re-read, and leaves. */
  const act = async (run: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await run();
      onChanged?.();
      setLeaving(true);
    } catch {
      setError('That did not work. Try again.');
      setBusy(false);
    }
  };

  /**
   * Runs a write and STAYS, re-reading the profile so the menu redraws against the new state.
   *
   * The reload is what makes Mute a toggle rather than a one-way trip: `dm.muted` comes back from
   * the server, so the next open of the menu says Unmute because the server says so - not because
   * this file kept a boolean of its own that a second device could contradict.
   */
  const actInPlace = async (run: () => Promise<unknown>, message: string) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await run();
      load.reload();
      setNotice(message);
    } catch {
      setError('That did not work. Try again.');
    } finally {
      setBusy(false);
    }
  };

  const openDm = async () => {
    setBusy(true);
    setError(null);
    try {
      const { channelId } = await dmApi.open(userId);
      setPendingHref(`/chat/${channelId}?${ARRIVED_FORWARD}`);
      setLeaving(true);
    } catch {
      /*
       * Deliberately the same sentence a stranger gets. Everything this can refuse - no shared
       * club any more, or a block in either direction - is only knowable by asking, and a
       * distinguishable refusal would make a block detectable by anybody willing to tap.
       */
      setError('You cannot message them right now.');
      setBusy(false);
    }
  };

  const club: ProfileClubActions | undefined = load.data?.club;
  /**
   * The conversation, when there already is one.
   *
   * **The server answers this and the card never works it out.** `dmApi.open` would CREATE a
   * thread, so resolving the channel here in order to offer Mute would bring a conversation into
   * being as a side effect of muting it - which is why the flag rides on the profile read instead.
   * Absent on somebody you have never messaged, and on your own card.
   */
  const dm: ProfileDmActions | undefined = load.data?.dm;
  const name = load.data?.profile.name ?? '';
  const first = name.split(' ')[0] ?? 'this member';

  /*
   * The menu, built from the server's flags.
   *
   * An empty list means no button at all rather than a control that opens onto nothing: a "..."
   * that does nothing is worse than an absent one, because it reads as broken rather than as
   * "you may not do anything here".
   */
  const menuItems: ContextMenuItem[] = [];

  /*
   * The conversation actions, first, and **only when a conversation exists**.
   *
   * Both act on a thread rather than on a person, so on a roster row you have never messaged
   * there is nothing for them to act on - `DESIGN/10` rule 5 then does the rest and the "..."
   * is simply absent for a member with no other authority over this row.
   *
   * `dm/[channelId]/profile` still exists for the reason `DESIGN/10` gives - it is about the
   * conversation rather than the person, and its gallery is the proof. Note it does NOT carry
   * these two: its menu is Pin, Block and Delete chat, as its own header says. An earlier version
   * of this comment claimed it carried Mute, which it never has.
   */
  if (dm !== undefined) {
    menuItems.push({
      label: dm.muted ? 'Unmute' : 'Mute',
      icon: dm.muted ? 'notifications' : 'notifications-off',
      onPress: () => {
        setMenuAnchor(null);
        void actInPlace(
          () => (dm.muted ? dmApi.unmute(dm.channelId) : dmApi.mute(dm.channelId)),
          /*
            One word, and the same word the chat header uses for the same action on the same
            conversation.

            It read "Muted. The unread count still counts." until 2026-08-17, to make the point
            that mute is not "mark as read" - a true and useful distinction that was being made in
            the wrong place. A confirmation is read once, in the half-second after a tap somebody
            already meant; it is not where a control gets explained, and the two mute controls
            saying different sentences about one action was the worse problem of the two.
          */
          dm.muted ? 'Unmuted' : 'Muted',
        );
      },
    });
    menuItems.push({
      label: 'Clear chat',
      icon: 'delete-sweep',
      destructive: true,
      onPress: () => {
        setMenuAnchor(null);
        setConfirmingClear(true);
      },
    });
  }

  /*
   * Report, when the server says so.
   *
   * `canReport` rather than a check on `viewerId !== userId` here, for `DESIGN/10` rule 4's
   * reason: the eligibility rule is `canReportUser` and this file must not hold a second copy of
   * it. It happens to be "not yourself, and you can see them" today.
   */
  if (load.data?.canReport === true) {
    menuItems.push({
      label: 'Report',
      icon: 'flag',
      destructive: true,
      onPress: () => {
        setMenuAnchor(null);
        setConfirmingReport(true);
      },
    });
  }

  if (club !== undefined) {
    if (club.banned) {
      // Any admin, including one who did not impose it. That asymmetry is the safeguard against a
      // wrongful ban - ADR-0021.
      if (club.canLiftBan) {
        menuItems.push({
          label: 'Lift ban',
          icon: 'undo',
          onPress: () => {
            setMenuAnchor(null);
            void act(() => clubApi.liftBan(club.clubId, userId));
          },
        });
      }
    } else {
      if (club.canRemove) {
        menuItems.push({
          label: 'Remove from club',
          icon: 'person-remove',
          destructive: true,
          onPress: () => {
            setMenuAnchor(null);
            void act(() => clubApi.removeMember(club.clubId, userId));
          },
        });
      }
      if (club.canBan) {
        menuItems.push({
          label: 'Ban from club',
          icon: 'block',
          destructive: true,
          onPress: () => {
            // The menu closes BEFORE the dialog opens, so the two are never stacked. Three
            // overlays deep is where a platform starts dropping one of them.
            setMenuAnchor(null);
            setConfirmingBan(true);
          },
        });
      }
    }
  }

  return (
    <RisingSheet
      onDismiss={finish}
      requestClose={leaving}
      label={`Close ${first}'s card`}
      /*
       * Everything that draws OVER the card, inside the card's own modal.
       *
       * > **These were siblings of `RisingSheet` first, and on iOS that meant they did not
       * > exist.** One modal is presented per view controller; a second, sibling modal is refused
       * > in silence. The founder's report was "the three dots doesn't pop up anything, and
       * > clicking the club symbols doesn't pop up the clubs" - every control that failed opened
       * > a modal, and the one that worked (Message) navigated instead. Web could not show it:
       * > a browser stacks them happily, which is why the first pass looked complete.
       *
       * Only one is ever up at a time - the menu closes itself before the confirmation opens.
       */
      overlay={
        <>
          {menuAnchor !== null && (
            <ContextMenu
              hosted
              anchor={menuAnchor}
              onDismiss={() => setMenuAnchor(null)}
              items={menuItems}
            />
          )}

          {confirmingBan && club !== undefined && (
            <ConfirmDialog
              hosted
              title={`Ban ${first}?`}
              // What a ban does that a removal does not, stated rather than left to be discovered.
              body="They will be removed from the club and will not be able to rejoin - not by searching, and not with an invite link. Any admin can lift this later."
              confirmLabel="Ban"
              onConfirm={() => {
                setConfirmingBan(false);
                void act(() => clubApi.ban(club.clubId, userId));
              }}
              onCancel={() => setConfirmingBan(false)}
            />
          )}

          {/*
            The wording does the work here, exactly as it does on the DM profile screen, and it
            is deliberately the same sentence: "delete" sounds mutual and is not. Saying so stops
            somebody using this believing it reaches the other person, and stops somebody avoiding
            it believing it destroys their own record permanently.
          */}
          {confirmingClear && dm !== undefined && (
            <ConfirmDialog
              hosted
              title="Delete this chat?"
              body={`This clears the conversation for you only. ${
                first === 'this member' ? 'They' : first
              } will still have every message, and will not be told.`}
              confirmLabel="Delete chat"
              dismissLabel="Keep it"
              onCancel={() => setConfirmingClear(false)}
              onConfirm={() => {
                setConfirmingClear(false);
                void act(async () => {
                  await channelApi.clear(dm.channelId);
                  // Drop the local copy too, or the cache re-renders what the server just hid.
                  // See ChatClient.forgetChannel.
                  await client?.forgetChannel(dm.channelId);
                });
              }}
            />
          )}

          {/*
            Reporting is confirmed because it is an accusation and it is not undoable from here.

            The body says who sees it and what happens next, which is the one thing a reporter
            actually wants to know - and the reason it can be stated plainly is that the answer no
            longer depends on where the card was opened from. ADR-0035 gave person reports one
            destination precisely so this sentence could be one sentence.
          */}
          {confirmingReport && (
            <ConfirmDialog
              hosted
              title={`Report ${first}?`}
              body="A ClubChat moderator will review this. They are not told by anybody in your club, and the person you are reporting is never told that you reported them."
              confirmLabel="Report"
              dismissLabel="Cancel"
              onCancel={() => setConfirmingReport(false)}
              onConfirm={() => {
                setConfirmingReport(false);
                void actInPlace(
                  () => accountApi.reportUser(userId),
                  'Reported. A moderator will review it.',
                );
              }}
            />
          )}

          {clubsOpen && (
            <SharedClubsSheet
              clubs={sharedList}
              onDismiss={() => setClubsOpen(false)}
              onPick={(pickedClubId) => {
                setClubsOpen(false);
                // Leave first, then land: the card is over the roster this club would replace.
                setPendingHref(`/clubs/${pickedClubId}?${ARRIVED_FORWARD}`);
                setLeaving(true);
              }}
            />
          )}
        </>
      }
    >
        {(close) => (
          <>
            {/*
              The "..." sits in the card's own corner, where the video puts it, and is absolutely
              positioned so the identity below stays centred on the card rather than on whatever
              is left over beside a button.
            */}
            {menuItems.length > 0 && (
              <View
                style={styles.menuHost}
                ref={(view) => {
                  menuButton.current = view as unknown as View | null;
                }}
                collapsable={false}
              >
                <Pressable
                  style={styles.menuButton}
                  hitSlop={space.sm}
                  disabled={busy}
                  onPress={(event) =>
                    measureRow(
                      menuButton.current,
                      { x: event.nativeEvent.pageX, y: event.nativeEvent.pageY },
                      (anchor) => setMenuAnchor(anchor),
                    )
                  }
                  accessibilityRole="button"
                  accessibilityLabel={`Options for ${name || 'this member'}`}
                >
                  <MaterialIcons name="more-horiz" size={22} color={color.textPrimary} />
                </Pressable>
              </View>
            )}

            <ScrollView
              contentContainerStyle={styles.content}
              showsVerticalScrollIndicator={false}
            >
              {load.data === null ? (
                <View style={styles.pending}>
                  {load.error === null ? (
                    <ActivityIndicator color={color.accent} />
                  ) : (
                    /*
                      A card that failed to load says so and offers the way back in. PRD/16 rule
                      2: no surface may fail to a blank page.
                    */
                    <>
                      <Text style={styles.error}>{load.error.message}</Text>
                      <Pressable
                        onPress={load.reload}
                        accessibilityRole="button"
                        accessibilityLabel="Try again"
                      >
                        <Text style={styles.retry}>Try again</Text>
                      </Pressable>
                    </>
                  )}
                </View>
              ) : (
                <>
                  <View style={styles.identity}>
                    <Avatar
                      name={load.data.profile.name}
                      image={load.data.profile.image}
                      size={AVATAR_SIZE}
                    />
                    <Text style={styles.name}>
                      {load.data.profile.name || 'ClubChat member'}
                    </Text>
                    {/* Their standing in the club this was opened from, not a global rank. */}
                    {role !== null && role !== undefined && (
                      <Text style={styles.role}>{role}</Text>
                    )}
                    {club?.banned === true && <Text style={styles.banned}>Banned</Text>}
                  </View>

                  {/*
                    Round, icon-only, and centred under the name - the shape the design calls for.
                    Absent on your own card: `canOpenDm` refuses a conversation with yourself, so
                    offering it would be a control that always fails.
                  */}
                  {viewerId !== userId && (
                    <View style={styles.actions}>
                      <Pressable
                        style={styles.circle}
                        onPress={() => void openDm()}
                        disabled={busy}
                        accessibilityRole="button"
                        accessibilityLabel={`Send a message to ${name || 'this member'}`}
                      >
                        {busy ? (
                          <ActivityIndicator color={color.accent} />
                        ) : (
                          <MaterialIcons name="chat-bubble-outline" size={20} color={color.accent} />
                        )}
                      </Pressable>
                    </View>
                  )}

                  {error !== null && <Text style={styles.error}>{error}</Text>}
                  {/*
                    Where a refusal already goes, so an outcome and its failure occupy the same
                    place rather than the eye having to find two. Cleared by the next write.
                  */}
                  {notice !== null && <Text style={styles.notice}>{notice}</Text>}

                  {/* Absent rows are simply absent - PRD/03. "Description" is v1's label for the bio. */}
                  <View style={styles.details}>
                    <DetailLine
                      label="Description"
                      value={load.data.profile.bio}
                      labelCase="title"
                    />
                    <DetailLine label="City" value={load.data.profile.city} labelCase="title" />
                    <DetailLine label="School" value={load.data.profile.school} labelCase="title" />
                  </View>

                  {/*
                    Absent entirely when there are none, rather than a row reading zero - the same
                    call the full profile makes.

                    > **And absent on your own card**, because "You're both in" is a statement
                    > about two people. `sharedClubs` intersects your clubs with the target's, and
                    > asked about yourself it answers all of them - so tapping your own row read
                    > "You're both in Binghamton Running Club and these other clubs" about you and
                    > you. Caught in the roster smoke test on 2026-08-14, one tap from where every
                    > admin already is.

                    It opens the list, exactly as it does on the full profile. That was left off
                    the first build on the reasoning that a panel inside a panel is a stack to
                    unwind; the founder reported the dead faces from his phone the same afternoon,
                    which settles it - the block has looked pressable everywhere else in the
                    product for as long as it has existed.
                  */}
                  {sharedList.length > 0 && viewerId !== userId && (
                    <SharedClubsBlock
                      clubs={sharedList}
                      since={load.data.profile.createdAt}
                      onOpen={() => setClubsOpen(true)}
                    />
                  )}

                  {/*
                    > **There is no "View full profile" row, and its absence is the point.**
                    >
                    > It was the last thing on this card until 2026-08-14, on the reasoning that a
                    > card is a glance and the screen is the whole record. That stopped being true
                    > while the card was being built: the shared-clubs block arrived, then the DM
                    > action, then the admin menu, and by the end the card carried description,
                    > city, school, shared clubs, Send message, Remove, Ban and Lift ban - which is
                    > every part of the screen. The row was offering a second copy of what the
                    > reader was already looking at, and charging a navigation for it.
                    >
                    > `/users/:id` is untouched and still the addressable record: a notification, a
                    > pasted link and a tap on a chat bubble's avatar all land there. What went is
                    > only the way from this card into a screen showing the same thing.
                  */}
                </>
              )}
            </ScrollView>
          </>
        )}
    </RisingSheet>
  );
}

/**
 * What the two of you have in common, as a sentence and a stack of faces.
 *
 * > **A count in a row said the same thing and meant less.** "Shared clubs 3" is a number; naming
 * > the club and showing the others behind it is the actual answer to the question somebody opens
 * > a profile with, which is "who is this to me". The whole block is one target, so the faces are
 * > a preview of the list rather than eight small things to hit.
 *
 * The overlap is the point of the stack: it reads as one object - a group of groups - where a row
 * of separated thumbnails reads as a toolbar. The `+N` chip carries whatever does not fit rather
 * than the row scrolling, because a horizontal scroller inside a vertical one is a gesture fight
 * over about forty points of screen.
 *
 * **`onOpen` is optional, and its absence is a layout decision rather than a missing feature.**
 * The full profile screen opens the list; the card does not, because a panel opened from inside a
 * panel is a stack somebody has to unwind. Without it this renders as a plain block, so there is
 * no press target that does nothing.
 */
export function SharedClubsBlock({
  clubs,
  since,
  onOpen,
}: {
  clubs: readonly SharedClub[];
  /** The profile's own `createdAt`: when they joined ClubChat, not when you met. */
  since: string;
  onOpen?: () => void;
}) {
  const first = clubs[0];
  /*
   * The faces are the clubs the sentence has NOT already named, which is why this slices from 1.
   *
   * > **It sliced from 0, so the stack led with the club named directly above it.** The line reads
   *  "and these other clubs" and pointed at a row whose first face was Binghamton Running Club -
   * the club it had just said you were both in. Reported from the device on 2026-08-14. The count
   * was wrong the same way: a `+N` chip computed against the whole set overstated what was left.
   *
   * The full list sheet still shows every shared club, and that is not the same claim - it is
   * titled "Shared clubs" rather than introduced by a sentence naming one of them.
   */
  const others = clubs.slice(1);
  const shown = others.slice(0, FACE_LIMIT);
  const rest = others.length - shown.length;

  const body = (
    <>
      <Text style={styles.sharedLead}>
        {"You're both in "}
        <Text style={styles.sharedClubName}>{first?.name}</Text>
      </Text>
      {/*
        Counted and pluralised, where it used to be the fixed string "and these other clubs" -
        which said "clubs" about a single one for anybody sharing exactly two, the commonest case
        after sharing one. A line that miscounts what is directly beneath it is worse than no line.
      */}
      {others.length > 0 && (
        <Text style={styles.sharedMore}>
          and {others.length} other {others.length === 1 ? 'club' : 'clubs'}
        </Text>
      )}

      {/*
        Absent rather than empty when there is nothing left to show. An always-rendered row keeps
        its own gap, which would leave a band of nothing under every profile sharing exactly one
        club - the same hidden-thing-still-occupying-room defect as `DESIGN/03` rule 4.
      */}
      {shown.length > 0 && (
        <View style={styles.faces}>
          {shown.map((club, index) => (
            <View
              key={club.clubId}
              // Each face laps the one before it. The first sits flush so the stack starts where
              // the block does rather than half a face in.
              style={[styles.face, index > 0 && styles.faceOverlap]}
            >
              <Avatar
                name={club.name}
                image={club.image}
                size={FACE_SIZE}
                kind="group"
                tintId={club.clubId}
              />
            </View>
          ))}
          {rest > 0 && (
            <View style={[styles.face, styles.faceOverlap, styles.faceRest]}>
              <Text style={styles.faceRestLabel}>+{rest}</Text>
            </View>
          )}
        </View>
      )}

      {/*
        When they joined ClubChat - the profile's own `createdAt`, which is the only "since" the
        product actually knows. It is deliberately not "since you met": there is no such record,
        and inventing one from the oldest shared club would be wrong the moment somebody leaves it.
      */}
      <View style={styles.sinceRow}>
        <MaterialIcons name="schedule" size={14} color={color.textSecondary} />
        <Text style={styles.since}>
          Since {new Date(since).toLocaleDateString([], { month: 'short', year: 'numeric' })}
        </Text>
      </View>
    </>
  );

  if (onOpen === undefined) return <View style={styles.shared}>{body}</View>;

  return (
    <Pressable
      style={styles.shared}
      onPress={onOpen}
      accessibilityRole="button"
      accessibilityLabel={
        clubs.length === 1
          ? `You are both in ${first?.name}. See shared clubs`
          : `You are both in ${first?.name} and ${clubs.length - 1} other clubs. See shared clubs`
      }
    >
      {body}
    </Pressable>
  );
}

/** How many club pictures the stack shows before the rest become a +N chip. */
const FACE_LIMIT = 4;
const FACE_SIZE = 30;

/**
 * The clubs you and this person are both in, as a popup over the card.
 *
 * > **A sheet rather than a screen, deliberately.** The same reasoning the club hub's races list
 * > records: a page here would exist only to be somewhere a back control returns to. This list is
 * > short - it is an intersection, not a directory - and every row is a way OUT of it, so nothing
 * > about it wants a URL of its own.
 *
 * No search field. The races sheet has one because a club can hold a season's worth of them and
 * the question there is "which one was it"; two people share a handful of clubs and the whole
 * list is on screen at once. A search box over three rows is furniture.
 */
export function SharedClubsSheet({
  clubs,
  onDismiss,
  onPick,
}: {
  clubs: readonly SharedClub[];
  onDismiss: () => void;
  onPick: (clubId: string) => void;
}) {
  return (
    <View style={styles.sheetBackdrop}>
      <Pressable
        style={styles.sheetScrim}
        onPress={onDismiss}
        accessibilityRole="button"
        accessibilityLabel="Close"
      />
      <View style={styles.sheet}>
        <View style={styles.sheetHead}>
          <Text style={styles.sheetTitle}>Shared clubs</Text>
          <Pressable
            onPress={onDismiss}
            hitSlop={space.sm}
            accessibilityRole="button"
            accessibilityLabel="Close"
          >
            <MaterialIcons name="close" size={22} color={color.textPrimary} />
          </Pressable>
        </View>

        <ScrollView style={styles.sheetList}>
          {clubs.map((club) => (
            <Pressable
              key={club.clubId}
              style={styles.sheetRow}
              onPress={() => onPick(club.clubId)}
              accessibilityRole="button"
              accessibilityLabel={`Open ${club.name}`}
            >
              {/* Square, because a club is a thing rather than a person - DESIGN/02. */}
              <Avatar
                name={club.name}
                image={club.image}
                size={40}
                kind="group"
                tintId={club.clubId}
              />
              <Text style={styles.sheetRowText} numberOfLines={1}>
                {club.name}
              </Text>
              <MaterialIcons name="chevron-right" size={22} color={color.textSecondary} />
            </Pressable>
          ))}
        </ScrollView>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  content: { paddingBottom: space.sm, gap: space.sm },
  pending: { paddingVertical: space.xl, alignItems: 'center', gap: space.sm },
  retry: { ...type.body, color: color.accent },

  /*
   * The corner button. `zIndex` rather than source order, because it is drawn before the scroller
   * that fills the card and would otherwise sit underneath it.
   *
   * > **Inset by the gutter rather than pinned to the corner.** It sat at `top: 0, right: 0`, and
   * > the sheet's top corners are `radius.xl` - so a 36pt disc was placed entirely inside a 24pt
   * > arc, in the one part of the card where the edge is curving away from it. Two rounded shapes
   * > with no space between them read as one badly cut shape: reported from the device on
   * > 2026-08-14 as the button looking "unshaped", and it looks like it is spilling off the card
   * > because the card's own edge is receding behind it.
   *
   * `space.md` on both axes, which is the gutter the rest of the product insets by, so the disc
   * clears the arc and lines up with content rather than floating at a number chosen to look
   * right. A corner control needs the corner to have finished being a corner first.
   */
  menuHost: { position: 'absolute', top: space.md, right: space.md, zIndex: 2 },
  menuButton: {
    width: 36,
    height: 36,
    borderRadius: radius.pill,
    backgroundColor: color.cardSunken,
    alignItems: 'center',
    justifyContent: 'center',
  },

  identity: { alignItems: 'center', gap: space.xs, paddingTop: space.sm },
  // 22, matching the name on your own profile. `type.title` at 28 is a screen heading, and this
  // is a person.
  name: {
    ...type.title,
    fontSize: 22,
    lineHeight: 28,
    color: color.textPrimary,
    textAlign: 'center',
  },
  role: { ...type.label, color: color.accent, textTransform: 'none' },
  banned: { ...type.label, color: color.error, textTransform: 'none' },

  actions: { flexDirection: 'row', justifyContent: 'center', gap: space.md },
  circle: {
    width: 52,
    height: 52,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: color.hairline,
    alignItems: 'center',
    justifyContent: 'center',
  },

  details: { width: '100%', gap: space.sm },
  error: { ...type.bodySmall, color: color.error, textAlign: 'center' },
  /** The same line as an error, in the accent rather than the error colour. */
  notice: { ...type.bodySmall, color: color.accent, textAlign: 'center' },

  /*
   * The shared-clubs block: centred under the name, because it is a statement about the two of
   * you rather than a row of data. Its own sunken panel so the whole thing reads as one target.
   */
  shared: {
    alignItems: 'center',
    gap: space.xs,
    paddingVertical: space.md,
    paddingHorizontal: space.md,
    backgroundColor: color.cardSunken,
    borderRadius: radius.lg,
    marginTop: space.sm,
  },
  sharedLead: { ...type.body, color: color.textSecondary, textAlign: 'center' },
  /** The club's name is the load-bearing word in the sentence, so it carries the weight. */
  sharedClubName: { ...type.title, fontSize: 15, lineHeight: 20, color: color.textPrimary },
  sharedMore: { ...type.bodySmall, color: color.textSecondary },

  faces: { flexDirection: 'row', alignItems: 'center', marginTop: space.xs },
  /*
   * A ring in the card colour around each face, which is what makes an overlap read as a stack
   * rather than as two pictures touching. Same trick a stacked avatar row uses anywhere.
   */
  face: {
    borderRadius: radius.pill,
    borderWidth: 2,
    borderColor: color.cardSunken,
  },
  /** Laps the previous face by a third of its width. */
  faceOverlap: { marginLeft: -FACE_SIZE / 3 },
  faceRest: {
    width: FACE_SIZE + 4,
    height: FACE_SIZE + 4,
    borderRadius: radius.pill,
    backgroundColor: color.chrome,
    alignItems: 'center',
    justifyContent: 'center',
  },
  faceRestLabel: { ...type.label, fontSize: 11, color: color.textSecondary },

  sinceRow: { flexDirection: 'row', alignItems: 'center', gap: space.xs, marginTop: space.xs },
  since: { ...type.bodySmall, color: color.textSecondary },

  /*
   * The shared-clubs popup, matching the club hub's races sheet exactly.
   *
   * Same scrim, same rounded card, same 70% ceiling so a long list scrolls inside the sheet
   * rather than growing past the screen. Copied deliberately as a pair of treatments rather than
   * invented: two popups in one product that dim the background differently read as two products.
   */
  sheetBackdrop: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    justifyContent: 'center',
    padding: space.md,
    zIndex: 100,
  },
  sheetScrim: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(0,0,0,0.4)',
  },
  sheet: {
    backgroundColor: color.card,
    borderRadius: radius.lg,
    padding: space.md,
    gap: space.sm,
    maxHeight: '70%',
    alignSelf: 'center',
    width: '100%',
    maxWidth: 420,
  },
  sheetHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  sheetTitle: { ...type.title, fontSize: 18, lineHeight: 24, color: color.textPrimary },
  sheetList: { marginTop: space.xs },
  sheetRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingVertical: space.sm,
    borderBottomWidth: 1,
    borderBottomColor: color.cardSunken,
  },
  sheetRowText: { ...type.body, color: color.textPrimary, flex: 1 },
});
