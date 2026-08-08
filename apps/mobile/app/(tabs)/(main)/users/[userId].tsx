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
import { StyleSheet, Text, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { accountApi, clubApi, dmApi } from '../../../../src/api.ts';
import type { ProfileClubActions } from '../../../../src/api-types.ts';
import { useSession } from '../../../../src/chat-provider.tsx';
import { color, space, type } from '../../../../src/theme.ts';
import { ARRIVED_FORWARD } from '../../../../src/nav.tsx';
import { Action, Avatar, Body, ConfirmDialog, DataScreen, DetailLine } from '../../../../src/ui.tsx';
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

  return (
    <DataScreen load={load}>
      {(data) => (
        <Body>
          <View style={styles.identity}>
            {/*
              Their picture, not just their initial. `Avatar` falls back to the letter on its own
              when `image` is null, which is the same placeholder chat and every roster draws.
            */}
            <Avatar name={data.profile.name} image={data.profile.image} size={AVATAR_SIZE} />
            <Text style={styles.name}>{data.profile.name || 'ClubChat member'}</Text>
          </View>

          <SendMessage userId={data.profile.userId} name={data.profile.name} />

          <View style={styles.details}>
            {/* Absent rows are simply absent - PRD/03. "Description" is v1's label for the bio. */}
            <DetailLine label="Description" value={data.profile.bio} labelCase="title" />
            <DetailLine label="City" value={data.profile.city} labelCase="title" />
            <DetailLine label="School" value={data.profile.school} labelCase="title" />
          </View>

          {data.club !== undefined && (
            <ClubActions
              club={data.club}
              name={data.profile.name}
              userId={data.profile.userId}
              onChanged={load.reload}
            />
          )}
        </Body>
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
