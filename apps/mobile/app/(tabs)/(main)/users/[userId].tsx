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
 *    bio/city/school - those rows are simply absent." v1 drew the label with a placeholder under it.
 */

import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { accountApi, dmApi } from '../../../../src/api.ts';
import { useSession } from '../../../../src/chat-provider.tsx';
import { color, space, type } from '../../../../src/theme.ts';
import { ARRIVED_FORWARD } from '../../../../src/nav.tsx';
import { Action, Avatar, Body, DataScreen, DetailLine } from '../../../../src/ui.tsx';
import { useLoad } from '../../../../src/use-load.ts';

/** v1's, and the largest avatar any person gets. A club's own picture is bigger; a person's is not. */
const AVATAR_SIZE = 96;

export default function MemberProfileScreen() {
  const { userId } = useLocalSearchParams<{ userId: string }>();
  const load = useLoad(() => accountApi.profile(userId), [userId]);

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
        </Body>
      )}
    </DataScreen>
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
});
