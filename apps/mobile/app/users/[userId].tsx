/**
 * Another member's profile card. **Read-only, always.**
 *
 * There is no edit control here and no route behind one: editing is `PATCH /me/profile`, which takes
 * no target, so "nobody can edit another member's profile - including an Owner" is structural rather
 * than a check somebody could forget.
 *
 * The date of birth is absent from the response for anybody but its owner, so this screen cannot
 * show it even by accident.
 */

import { StyleSheet, Text, View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { accountApi } from '../../src/api.ts';
import { color, space, type } from '../../src/theme.ts';
import { Avatar, Body, Card, DataScreen, DetailLine } from '../../src/ui.tsx';
import { useLoad } from '../../src/use-load.ts';

export default function MemberProfileScreen() {
  const { userId } = useLocalSearchParams<{ userId: string }>();
  const load = useLoad(() => accountApi.profile(userId), [userId]);

  return (
    <DataScreen load={load}>
      {(data) => (
        <Body>
          <View style={styles.identity}>
            <Avatar name={data.profile.name} size={64} />
            <Text style={styles.name}>{data.profile.name}</Text>
          </View>
          <Card>
            {/* Absent rows are simply absent. */}
            <DetailLine label="Bio" value={data.profile.bio} />
            <DetailLine label="City" value={data.profile.city} />
            <DetailLine label="School" value={data.profile.school} />
          </Card>
          <Text style={styles.meta}>
            Profiles are visible to people who share a club with you. Email is never shown.
          </Text>
        </Body>
      )}
    </DataScreen>
  );
}

const styles = StyleSheet.create({
  identity: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  name: { ...type.title, color: color.textPrimary },
  meta: { ...type.bodySmall, color: color.textSecondary },
});
