/**
 * Another member's profile card. **Read-only, always.**
 *
 * There is no edit control here and no route behind one: editing is `PATCH /me/profile`, which takes
 * no target, so "nobody can edit another member's profile - including an Owner" is structural rather
 * than a check somebody could forget.
 *
 * The layout is v1's, which is the design truth for this screen: the face centred at the top, the
 * name under it, then the details stacked down the page as label-over-value rather than boxed in a
 * card. A person's profile is about the person, so it opens with them.
 *
 * **Two deliberate departures from v1, both product decisions rather than styling.**
 *
 *  - **No date of birth.** The server withholds `dob` from everybody but its owner, so it is absent
 *    from the response this screen reads rather than hidden in the markup - see `readProfile`, and
 *    PRD/03, which lists public profiles as an explicitly rejected alternative. v1 showed every
 *    member every other member's birthday.
 *  - **An empty row is absent, not "Not set".** PRD/03's edge-case table: "Profile with no
 *    bio/city/school - those rows are simply absent."
 *
 * **A profile is not readable by everybody.** Since 2026-08-08 the server answers `not_found` unless
 * the viewer shares a club with this person or already holds a conversation with them, so a card
 * reached from a roster or a chat bubble opens and one reached any other way does not - which is
 * what makes tapping somebody who has left the club say "Not found" rather than showing them.
 */

import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { accountApi, clubApi, dmApi } from '../../../../src/api.ts';
import type { ProfileClubActions, SharedClub } from '../../../../src/api-types.ts';
import { useSession } from '../../../../src/chat-provider.tsx';
import { ProfilePictureViewer } from '../../../../src/profile-picture-viewer.tsx';
import { color, radius, space, type } from '../../../../src/theme.ts';
import { ARRIVED_FORWARD } from '../../../../src/nav.tsx';
import {
  Action,
  Avatar,
  Body,
  ConfirmDialog,
  DataScreen,
  DetailLine,
  Row,
} from '../../../../src/ui.tsx';
import { useLoad } from '../../../../src/use-load.ts';

/** v1's, and the largest avatar any person gets. A club's own picture is bigger; a person's is not. */
const AVATAR_SIZE = 96;

export default function MemberProfileScreen() {
  /*
   * `clubId` is optional and comes from wherever this card was opened.
   *
   * Present when the card was reached from a club roster, which is the only place club authority
   * makes sense - the same person is bannable by you in one club and untouchable in another. The
   * server answers what may be done with it; this screen never works the ladder out itself.
   */
  const { userId, clubId } = useLocalSearchParams<{ userId: string; clubId?: string }>();
  const load = useLoad(() => accountApi.profile(userId, clubId), [userId, clubId]);
  /*
   * The clubs the two of you share, from the read that already answers this.
   *
   * > **A second request rather than a field on the profile**, and that is deliberate.
   * > `sharedClubs` has existed since Phase 3.5 for the DM profile, and its route note already
   * > said "the same read serves a profile reached from a roster". Adding the same intersection
   * > to `readProfile` was written and then deleted: it would have been a second answer to a
   * > question that already had one, which is this codebase's failure mode 9.
   *
   * Loaded separately from the card so a failure here costs the shared-clubs row and not the
   * whole profile - the name, the bio and the ban controls do not depend on it.
   */
  const shared = useLoad(() => dmApi.sharedClubs(userId), [userId]);
  const sharedList = shared.data?.clubs ?? [];
  const router = useRouter();

  /** The shared-clubs popup, and the full-screen view of their picture. */
  const [clubsOpen, setClubsOpen] = useState(false);
  const [viewingPicture, setViewingPicture] = useState(false);

  return (
    <DataScreen load={load}>
      {(data) => (
        // A fragment, so the two overlays below are SIBLINGS of the body rather than children of
        // it. `Body` is a ScrollView, and an absolutely-positioned overlay inside one resolves
        // against the scroller's content box - which drew the photo viewer over the top third of
        // the screen and left the rest of the page showing. Chat's own note says the same thing:
        // last in the tree, so it covers the screen rather than appearing inside it.
        <>
          <Body>
          <View style={styles.identity}>
            {/*
              Their picture, not just their initial. `Avatar` falls back to the letter on its own
              when `image` is null, which is the same placeholder chat and every roster draws.

              > **Tappable only when there IS a picture.** The fallback is a coloured letter, and
              > opening a full-screen viewer onto a letter is a control that looks like it did
              > something wrong. So the pressable is conditional rather than the viewer being
              > asked to cope with a null.
            */}
            {data.profile.image === null ? (
              <Avatar name={data.profile.name} image={null} size={AVATAR_SIZE} />
            ) : (
              <Pressable
                onPress={() => setViewingPicture(true)}
                accessibilityRole="imagebutton"
                accessibilityLabel={`View ${data.profile.name || 'their'} picture`}
              >
                <Avatar name={data.profile.name} image={data.profile.image} size={AVATAR_SIZE} />
              </Pressable>
            )}
            <Text style={styles.name}>{data.profile.name || 'ClubChat member'}</Text>
          </View>

          <SendMessage userId={data.profile.userId} name={data.profile.name} />

          <View style={styles.details}>
            {/* Absent rows are simply absent - PRD/03. "Description" is v1's label for the bio. */}
            <DetailLine label="Description" value={data.profile.bio} labelCase="title" />
            <DetailLine label="City" value={data.profile.city} labelCase="title" />
            <DetailLine label="School" value={data.profile.school} labelCase="title" />
          </View>

          {/*
            The clubs the two of you are both in.
            
            > **Absent entirely when there are none, rather than a row reading zero.** You can
            > reach a profile through a conversation after the last shared club is gone - the
            > thread stays readable - and "Shared clubs 0" states a fact nobody asked about while
            > implying something is missing.
            
            A popup rather than a screen, which is the same call the club hub's races list makes:
            a destination whose only other job would be to be a back target is a screen not worth
            having. Tapping one goes to that club.
          */}
          {sharedList.length > 0 && (
            <SharedClubsBlock
              clubs={sharedList}
              since={data.profile.createdAt}
              onOpen={() => setClubsOpen(true)}
            />
          )}

          {data.club !== undefined && (
            <ClubActions
              club={data.club}
              name={data.profile.name}
              userId={data.profile.userId}
              onChanged={load.reload}
            />
          )}
          </Body>

          {clubsOpen && (
            <SharedClubsSheet
              clubs={sharedList}
              onDismiss={() => setClubsOpen(false)}
              onPick={(pickedClubId) => {
                setClubsOpen(false);
                router.push(`/clubs/${pickedClubId}?${ARRIVED_FORWARD}`);
              }}
            />
          )}

          {/*
            Their picture, and nothing else on the screen.

            > **Not `PhotoViewer`.** That one carries Share, Download, Report and a way back to a
            > message, all of which are true of a photograph somebody posted and none of which are
            > true of somebody's face. You should not be able to download another member's profile
            > picture, and the way to guarantee that is to not build the menu.
          */}
          {viewingPicture && data.profile.image !== null && (
            <ProfilePictureViewer
              mediaId={data.profile.image}
              name={data.profile.name || 'This member'}
              onClose={() => setViewingPicture(false)}
            />
          )}
        </>
      )}
    </DataScreen>
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
 */
function SharedClubsBlock({
  clubs,
  since,
  onOpen,
}: {
  clubs: readonly SharedClub[];
  /** The profile's own `createdAt`: when they joined ClubChat, not when you met. */
  since: string;
  onOpen: () => void;
}) {
  const shown = clubs.slice(0, FACE_LIMIT);
  const rest = clubs.length - shown.length;
  const first = clubs[0];

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
      <Text style={styles.sharedLead}>
        {"You're both in "}
        <Text style={styles.sharedClubName}>{first?.name}</Text>
      </Text>
      {clubs.length > 1 && <Text style={styles.sharedMore}>and these other clubs</Text>}

      <View style={styles.faces}>
        {shown.map((club, index) => (
          <View
            key={club.clubId}
            // Each face laps the one before it. The first sits flush so the stack starts where
            // the block does rather than half a face in.
            style={[styles.face, index > 0 && styles.faceOverlap]}
          >
            <Avatar name={club.name} image={club.image} size={FACE_SIZE} kind="group" tintId={club.clubId} />
          </View>
        ))}
        {rest > 0 && (
          <View style={[styles.face, styles.faceOverlap, styles.faceRest]}>
            <Text style={styles.faceRestLabel}>+{rest}</Text>
          </View>
        )}
      </View>

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
function SharedClubsSheet({
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
              <Avatar name={club.name} image={club.image} size={40} kind="group" tintId={club.clubId} />
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

/**
 * Banning, and lifting a ban, from the card an admin reached through the roster.
 *
 * > **Every flag here is the server's answer**, never a role this screen inspected. Banning follows
 * > the removal ladder - any admin may ban a Member, only the Owner may ban an Admin, the Owner is
 * > never bannable - while **lifting is open to any admin**. That asymmetry is the safeguard against
 * > a wrongful ban (ADR-0021), and a screen re-deriving either half would be a second definition of
 * > a rule that has exactly one.
 *
 * Behind a confirmation, because a ban is durable in a way a removal is not: it survives the person
 * tapping Join again, which is the entire reason it exists. The dialog says so rather than asking
 * "are you sure".
 */
function ClubActions({
  club,
  name,
  userId,
  onChanged,
}: {
  club: ProfileClubActions;
  name: string;
  userId: string;
  onChanged: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const first = name.split(' ')[0] ?? 'this member';

  const run = async (call: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await call();
      onChanged();
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  };

  // Already barred: the only thing on offer is undoing it, and only to somebody who may.
  if (club.banned) {
    if (!club.canLiftBan) return null;
    return (
      <View style={styles.action}>
        <Text style={styles.note}>{first} is banned from this club.</Text>
        <Action
          label={busy ? 'Lifting…' : 'Lift ban'}
          onPress={() => void run(() => clubApi.liftBan(club.clubId, userId))}
          disabled={busy}
          accessibilityLabel={`Lift the ban on ${name}`}
        />
      </View>
    );
  }

  if (!club.canBan) return null;

  return (
    <View style={styles.action}>
      <Action
        label="Ban from club"
        variant="danger"
        onPress={() => setConfirming(true)}
        disabled={busy}
        accessibilityLabel={`Ban ${name} from this club`}
      />
      {confirming && (
        <ConfirmDialog
          title={`Ban ${first}?`}
          // What a ban does that a removal does not, stated rather than left to be discovered.
          body="They will be removed from the club and will not be able to rejoin - not by searching, and not with an invite link. Any admin can lift this later."
          confirmLabel="Ban"
          onConfirm={() => void run(() => clubApi.ban(club.clubId, userId))}
          onCancel={() => setConfirming(false)}
        />
      )}
    </View>
  );
}

/**
 * The one place in the product that starts a direct message.
 *
 * Reaching a person is what varies - a chat avatar, a roster row, the new-message search - and
 * every one of them lands here, so "message this person" is a single action with a single
 * implementation rather than a button each of those screens grows its own copy of.
 *
 * **Absent on your own profile.** `canOpenDm` refuses a conversation with yourself, so offering
 * it would be a control that always fails. Everything else it can refuse - no shared club any
 * more, or a block in either direction - is only knowable by asking, so those surface as a
 * refusal after the tap rather than as a hidden button. The refusal is deliberately the same
 * sentence a stranger gets: a distinguishable one would make a block detectable by anybody
 * willing to tap.
 */
function SendMessage({ userId, name }: { userId: string; name: string }) {
  const { userId: viewerId } = useSession();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (viewerId === userId) return null;

  const open = async () => {
    setBusy(true);
    setError(null);
    try {
      const { channelId } = await dmApi.open(userId);
      // Replace rather than push: coming from the search, the profile was a step on the way to
      // the conversation, and backing out of the chat should not land on it again.
      router.replace(`/chat/${channelId}?${ARRIVED_FORWARD}`);
    } catch {
      setError(`You cannot message ${name.split(' ')[0] ?? 'this member'} right now.`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={styles.action}>
      <Action
        label={busy ? 'Opening…' : 'Send message'}
        onPress={() => void open()}
        disabled={busy}
        accessibilityLabel={`Send a message to ${name}`}
      />
      {error !== null && <Text style={styles.error}>{error}</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  /*
   * The popup, matching the club hub's races sheet exactly.
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

  identity: { alignItems: 'center', gap: space.sm, paddingTop: space.sm, paddingBottom: space.xs },
  // 22, matching the name on your own profile. `type.title` at 28 is a screen heading, and this
  // is a person.
  name: { ...type.title, fontSize: 22, lineHeight: 28, color: color.textPrimary, textAlign: 'center' },

  details: { width: '100%', maxWidth: 420, alignSelf: 'center', gap: space.sm },

  action: {
    width: '100%',
    maxWidth: 420,
    alignSelf: 'center',
    gap: space.xs,
    marginBottom: space.md,
  },
  error: { ...type.bodySmall, color: color.error, textAlign: 'center' },
  note: { ...type.bodySmall, color: color.textSecondary, textAlign: 'center' },
});
