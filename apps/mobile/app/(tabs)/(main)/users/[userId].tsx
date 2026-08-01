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

import { StyleSheet, Text, View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { accountApi } from '../../../../src/api.ts';
import { color, space, type } from '../../../../src/theme.ts';
import { Avatar, Body, DataScreen, DetailLine } from '../../../../src/ui.tsx';
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

const styles = StyleSheet.create({
  identity: { alignItems: 'center', gap: space.sm, paddingTop: space.sm, paddingBottom: space.xs },
  // 22, matching the name on your own profile. `type.title` at 28 is a screen heading, and this
  // is a person.
  name: { ...type.title, fontSize: 22, lineHeight: 28, color: color.textPrimary, textAlign: 'center' },

  details: { width: '100%', maxWidth: 420, alignSelf: 'center', gap: space.sm },
});
