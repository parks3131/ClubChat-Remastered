/**
 * Ask for a reset link.
 *
 * PRD/03 rules 13 and 14. Email and password is the only way into this product, so without this
 * screen a forgotten password is a lost account - there is no support desk to fall back on.
 *
 * **The screen has one answer and gives it whether or not the address is registered.** That is
 * rule 14 and it is the whole security posture of the form: a different message for a known
 * address turns it into a test for whether somebody has an account here, and clubs include
 * minors. The server already answers identically in both cases, so there is nothing here to get
 * wrong - which is the point of putting the rule in the server rather than in the copy.
 */

import { useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import * as Linking from 'expo-linking';
import { router } from 'expo-router';
import { config } from '../src/config.ts';
import { requestPasswordReset } from '../src/session.ts';
import { color, radius, space, type } from '../src/theme.ts';

/**
 * Where the emailed link lands once the server has checked the token.
 *
 * `createURL` rather than a hardcoded string, because the answer differs per platform and getting
 * it wrong is a link that opens nothing: `clubchat://reset-password` on a device, and the dev
 * server's own origin on web. Both are origins the API trusts - an untrusted one is refused
 * outright rather than followed, which is what stops this being an open redirect.
 */
function resetLandingUrl(): string {
  return Linking.createURL('/reset-password');
}

export default function ForgotPassword() {
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await requestPasswordReset(config.apiUrl, {
        email: email.trim(),
        redirectTo: resetLandingUrl(),
      });
      setSent(true);
    } catch (caught) {
      // A real failure - offline, or refused for asking too often. Distinct from "that address
      // has no account", which is not a failure and never reaches here.
      setError(caught instanceof Error ? caught.message : 'Could not send the link');
    } finally {
      setBusy(false);
    }
  };

  return (
    <KeyboardAvoidingView
      style={styles.flex}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView contentContainerStyle={styles.container} keyboardShouldPersistTaps="handled">
        {sent ? (
          /*
            The confirmation REPLACES the form rather than pushing a screen over it.
            SPEC/PRD/15: there is nothing to go back to, and the answer is one sentence.
          */
          <View style={styles.done}>
            <View style={styles.doneBadge}>
              <MaterialIcons name="mark-email-read" size={30} color={color.onAccentSoft} />
            </View>
            <Text style={styles.title}>Check your inbox</Text>
            <Text style={styles.body}>
              If {email.trim()} is registered, we have sent a link to reset the password. It works
              once and expires in an hour.
            </Text>
            <Pressable
              style={styles.button}
              onPress={() => router.replace('/sign-in')}
              accessibilityRole="button"
              accessibilityLabel="Back to sign in"
            >
              <Text style={styles.buttonLabel}>Back to sign in</Text>
            </Pressable>
            <Pressable
              onPress={() => {
                setSent(false);
                setError(null);
              }}
              accessibilityRole="button"
              accessibilityLabel="Use a different email address"
            >
              <Text style={styles.switch}>Wrong address? Try another</Text>
            </Pressable>
          </View>
        ) : (
          <>
            <Text style={styles.title}>Forgot your password?</Text>
            <Text style={styles.body}>
              Enter the email you signed up with and we will send you a link to set a new one.
            </Text>

            <TextInput
              style={styles.input}
              placeholder="Email"
              placeholderTextColor={color.textSecondary}
              value={email}
              onChangeText={setEmail}
              autoCapitalize="none"
              autoComplete="email"
              keyboardType="email-address"
              accessibilityLabel="Email"
              onSubmitEditing={() => {
                if (email.trim().length > 0 && !busy) void submit();
              }}
            />

            {error !== null && (
              <Text style={styles.error} accessibilityLiveRegion="polite">
                {error}
              </Text>
            )}

            <Pressable
              style={[styles.button, (email.trim().length === 0 || busy) && styles.buttonDisabled]}
              onPress={() => void submit()}
              disabled={email.trim().length === 0 || busy}
              accessibilityRole="button"
              accessibilityLabel="Send reset link"
            >
              {busy ? (
                <ActivityIndicator color={color.onAccent} />
              ) : (
                <Text style={styles.buttonLabel}>Send reset link</Text>
              )}
            </Pressable>

            <Pressable
              onPress={() => router.replace('/sign-in')}
              accessibilityRole="button"
              accessibilityLabel="Back to sign in"
            >
              <Text style={styles.switch}>Remembered it? Sign in</Text>
            </Pressable>
          </>
        )}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: color.appBackground },
  container: {
    flexGrow: 1,
    justifyContent: 'center',
    padding: space.md,
    gap: space.sm,
    maxWidth: 460,
    width: '100%',
    alignSelf: 'center',
  },
  done: { gap: space.sm },
  doneBadge: {
    width: 64,
    height: 64,
    borderRadius: radius.lg,
    backgroundColor: color.accentSoft,
    alignItems: 'center',
    justifyContent: 'center',
    alignSelf: 'center',
    marginBottom: space.sm,
  },
  title: { ...type.title, color: color.textPrimary, textAlign: 'center' },
  body: {
    ...type.bodySmall,
    color: color.textSecondary,
    textAlign: 'center',
    marginBottom: space.md,
  },
  input: {
    backgroundColor: color.card,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: color.divider,
    paddingHorizontal: space.md,
    paddingVertical: space.md,
    ...type.body,
    color: color.textPrimary,
  },
  error: { ...type.bodySmall, color: color.error, paddingHorizontal: space.xs },
  button: {
    backgroundColor: color.accent,
    borderRadius: radius.sm,
    paddingVertical: space.md,
    alignItems: 'center',
    marginTop: space.sm,
  },
  buttonDisabled: { opacity: 0.5 },
  buttonLabel: { ...type.label, color: color.onAccent, textTransform: 'uppercase' },
  switch: {
    ...type.bodySmall,
    color: color.accent,
    textAlign: 'center',
    paddingVertical: space.md,
  },
});
