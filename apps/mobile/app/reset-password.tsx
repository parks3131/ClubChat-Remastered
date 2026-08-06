/**
 * Set a new password, from the link in the reset email.
 *
 * PRD/03 rules 15 and 16, and **the only screen in the product entered from outside it**. Every
 * other route is reached by a tap inside the app, so "am I signed in" is already answered by the
 * time the screen is chosen. This one arrives cold, carrying a token, which is why it sits beside
 * `sign-in` and the legal screens at the root rather than behind any guard - a redirect to
 * sign-in for an unauthenticated visitor would swallow the token and the whole flow with it.
 *
 * It also has to work for somebody who IS signed in. Resetting a password on a device you are
 * still signed in on is the ordinary case of "I am changing it because I do not trust it", and
 * bouncing them into the app would be the one moment the app refuses to help. See SPEC/PRD/15.
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
import { router, useLocalSearchParams } from 'expo-router';
import { config } from '../src/config.ts';
import { resetPassword } from '../src/session.ts';
import { color, radius, space, type } from '../src/theme.ts';

/**
 * Mirrors better-auth's own default, so the refusal happens here with a sentence the reader can
 * act on rather than as a `PASSWORD_TOO_SHORT` from the server after a round trip. The server
 * still enforces it: this is the courtesy, not the rule.
 */
const MIN_PASSWORD_LENGTH = 8;

export default function ResetPassword() {
  /*
   * Both arrive as query parameters on the redirect the server performs after checking the token.
   * `error` is how it reports a token that was expired, spent or never real - it redirects here
   * either way, because the alternative is an error page in a browser with no way back into the
   * app.
   */
  const params = useLocalSearchParams<{ token?: string; error?: string }>();
  const token = typeof params.token === 'string' ? params.token : '';
  const linkRejected = typeof params.error === 'string' && params.error !== '';

  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  /*
   * One message for expired, already used, and never real.
   *
   * Told apart, they answer "was this token ever issued", which is a question about somebody
   * else's account. PRD/03's edge-case table says so, and the practical case is the same for all
   * three anyway: ask for another link.
   */
  const deadLink = linkRejected || token === '';

  const submit = async () => {
    if (password.length < MIN_PASSWORD_LENGTH) {
      setError(`Use at least ${MIN_PASSWORD_LENGTH} characters.`);
      return;
    }
    if (password !== confirm) {
      setError('The two passwords do not match.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await resetPassword(config.apiUrl, { token, newPassword: password });
      setDone(true);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not set the new password');
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
        {deadLink ? (
          <View style={styles.panel}>
            <View style={[styles.badge, styles.badgeMuted]}>
              <MaterialIcons name="link-off" size={30} color={color.textSecondary} />
            </View>
            <Text style={styles.title}>This link has expired</Text>
            <Text style={styles.body}>
              Reset links work once and last an hour. Ask for a new one and it will arrive in a
              moment.
            </Text>
            <Pressable
              style={styles.button}
              onPress={() => router.replace('/forgot-password')}
              accessibilityRole="button"
              accessibilityLabel="Request a new reset link"
            >
              <Text style={styles.buttonLabel}>Send a new link</Text>
            </Pressable>
            <Pressable
              onPress={() => router.replace('/sign-in')}
              accessibilityRole="button"
              accessibilityLabel="Back to sign in"
            >
              <Text style={styles.switch}>Back to sign in</Text>
            </Pressable>
          </View>
        ) : done ? (
          /*
            PRD/03 rule 16: this lands on sign-in, never in the app. The reset revoked every
            session including this device's, so there is nothing to land IN - and signing in once
            with the new password is the only real confirmation that it took.
          */
          <View style={styles.panel}>
            <View style={styles.badge}>
              <MaterialIcons name="lock-reset" size={30} color={color.onAccentSoft} />
            </View>
            <Text style={styles.title}>Password changed</Text>
            <Text style={styles.body}>
              You have been signed out everywhere else. Sign in with your new password.
            </Text>
            <Pressable
              style={styles.button}
              onPress={() => router.replace('/sign-in')}
              accessibilityRole="button"
              accessibilityLabel="Go to sign in"
            >
              <Text style={styles.buttonLabel}>Sign in</Text>
            </Pressable>
          </View>
        ) : (
          <>
            <Text style={styles.title}>Set a new password</Text>
            <Text style={styles.body}>
              At least {MIN_PASSWORD_LENGTH} characters. Changing it signs you out on every other
              device.
            </Text>

            <TextInput
              style={styles.input}
              placeholder="New password"
              placeholderTextColor={color.textSecondary}
              value={password}
              onChangeText={setPassword}
              secureTextEntry
              autoCapitalize="none"
              autoComplete="new-password"
              accessibilityLabel="New password"
            />

            <TextInput
              style={styles.input}
              placeholder="Confirm new password"
              placeholderTextColor={color.textSecondary}
              value={confirm}
              onChangeText={setConfirm}
              secureTextEntry
              autoCapitalize="none"
              autoComplete="new-password"
              accessibilityLabel="Confirm new password"
              onSubmitEditing={() => {
                if (!busy) void submit();
              }}
            />

            {error !== null && (
              <Text style={styles.error} accessibilityLiveRegion="polite">
                {error}
              </Text>
            )}

            <Pressable
              style={[
                styles.button,
                (busy || password.length === 0 || confirm.length === 0) && styles.buttonDisabled,
              ]}
              onPress={() => void submit()}
              disabled={busy || password.length === 0 || confirm.length === 0}
              accessibilityRole="button"
              accessibilityLabel="Set new password"
            >
              {busy ? (
                <ActivityIndicator color={color.onAccent} />
              ) : (
                <Text style={styles.buttonLabel}>Set new password</Text>
              )}
            </Pressable>

            <Pressable
              onPress={() => router.replace('/sign-in')}
              accessibilityRole="button"
              accessibilityLabel="Back to sign in"
            >
              <Text style={styles.switch}>Back to sign in</Text>
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
  panel: { gap: space.sm },
  badge: {
    width: 64,
    height: 64,
    borderRadius: radius.lg,
    backgroundColor: color.accentSoft,
    alignItems: 'center',
    justifyContent: 'center',
    alignSelf: 'center',
    marginBottom: space.sm,
  },
  badgeMuted: { backgroundColor: color.divider },
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
