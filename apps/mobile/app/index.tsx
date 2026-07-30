import { Redirect } from 'expo-router';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { useSession } from '../src/chat-provider.tsx';
import { color, space, type } from '../src/theme.ts';

/**
 * The bare entry point.
 *
 * PRD/03 rule 4: an unauthenticated user is always routed to sign-in, an authenticated
 * one always into the app, **including from `/`**. This screen exists only to make that
 * decision, and it renders a real loading state while deciding rather than a blank page.
 */
export default function Index() {
  const { authState } = useSession();

  if (authState === 'checking') {
    return (
      <View style={styles.container}>
        <ActivityIndicator color={color.accent} />
        <Text style={styles.label}>Loading</Text>
      </View>
    );
  }

  return <Redirect href={authState === 'signed-in' ? '/clubs' : '/sign-in'} />;
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.md,
    backgroundColor: color.appBackground,
  },
  label: { ...type.label, color: color.textSecondary, textTransform: 'uppercase' },
});
