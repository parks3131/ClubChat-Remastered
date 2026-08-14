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
 *
 * **This screen is no longer how a roster shows somebody.** A club roster opens `MemberCardSheet`
 * over itself instead - a list you are working down should not become a navigation each way. What
 * this stays is the whole record and the addressable one: a notification, a pasted link, and the
 * card's own "View full profile" all land here, so it keeps every part the card leaves out. The
 * shared-clubs block is imported from the card rather than written twice.
 */

import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { accountApi, clubApi, dmApi } from '../../../../src/api.ts';
import type { ProfileClubActions } from '../../../../src/api-types.ts';
import { useSession } from '../../../../src/chat-provider.tsx';
import { SharedClubsBlock, SharedClubsSheet } from '../../../../src/member-card.tsx';
import { ProfilePictureViewer } from '../../../../src/profile-picture-viewer.tsx';
import { color, space, type } from '../../../../src/theme.ts';
import { ARRIVED_FORWARD } from '../../../../src/nav.tsx';
import {
  Action,
  Avatar,
  Body,
  ConfirmDialog,
  DataScreen,
  DetailLine,
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
  /*
   * Who is looking, so the block below can be absent on your own profile.
   *
   * > **"You're both in" is a statement about two people.** `sharedClubs` intersects your clubs
   * > with the target's, and asked about yourself it answers all of them - so this screen told you
   * > that you and you are both in your own clubs. True since the block shipped and invisible
   * > because nobody navigates here from a roster; the member card made it one tap away and it was
   * > caught there on 2026-08-14. Fixed in both places at once, since it is one sentence with two
   * > renderers.
   */
  const { userId: viewerId } = useSession();

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
          {sharedList.length > 0 && viewerId !== userId && (
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
