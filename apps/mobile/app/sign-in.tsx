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
import { Redirect, router } from 'expo-router';
import { useSession } from '../src/chat-provider.tsx';
import { config } from '../src/config.ts';
import { ARRIVED_FORWARD } from '../src/nav.tsx';
import { signIn, signUp } from '../src/session.ts';
import { color, radius, space, type } from '../src/theme.ts';

type Mode = 'sign-in' | 'sign-up';

export default function SignIn() {
  const { authState, signedIn } = useSession();
  const [mode, setMode] = useState<Mode>('sign-in');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Already signed in: never leave a signed-in user looking at sign-in.
  // Entering the app is going IN, and a redirect is a replace - so it has to say so, or the
  // stack's way-out default slides the app in from the left. See `ARRIVED_FORWARD`.
  if (authState === 'signed-in') return <Redirect href={`/clubs?${ARRIVED_FORWARD}`} />;

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const result =
        mode === 'sign-up'
          ? await signUp(config.apiUrl, { name: name.trim(), email: email.trim(), password })
          : await signIn(config.apiUrl, { email: email.trim(), password });
      await signedIn(result.token, result.userId);
    } catch (caught) {
      // Inline error, and the form RETAINS its input. Clearing the fields on failure
      // makes the user retype an email to fix a password typo.
      setError(caught instanceof Error ? caught.message : 'Sign-in failed');
    } finally {
      setBusy(false);
    }
  };

  const canSubmit =
    email.trim().length > 0 &&
    password.length > 0 &&
    (mode === 'sign-in' || name.trim().length > 0);

  return (
    <KeyboardAvoidingView
      style={styles.flex}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView contentContainerStyle={styles.container} keyboardShouldPersistTaps="handled">
        {/*
          v1's brand mark, which is a badge rather than a picture.

          There is no logo FILE to take: `assets/icon.png` in both repos is still the stock Expo
          template artwork, and v1's own sign-in screen draws its mark the same way this does -
          a tilted rounded square holding one glyph, with the wordmark under it. Copying the
          asset would have copied the wrong thing.
        */}
        <View style={styles.brandBadge}>
          <MaterialIcons name="sports-kabaddi" size={32} color={color.onAccentSoft} />
        </View>
        <Text style={styles.wordmark}>ClubChat</Text>
        <Text style={styles.tagline}>
          The structure your club is already faking by hand.
        </Text>

        {mode === 'sign-up' && (
          <TextInput
            style={styles.input}
            placeholder="Full name"
            placeholderTextColor={color.textSecondary}
            value={name}
            onChangeText={setName}
            autoCapitalize="words"
            accessibilityLabel="Full name"
          />
        )}

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
        />

        <TextInput
          style={styles.input}
          placeholder="Password"
          placeholderTextColor={color.textSecondary}
          value={password}
          onChangeText={setPassword}
          secureTextEntry
          accessibilityLabel="Password"
        />

        {/*
          PRD/03 rule 13, and sign-in mode only: there is nothing to recover on a form that is
          creating the account. It sits under the password field, which is where somebody looks
          the moment the one they typed was refused.
        */}
        {mode === 'sign-in' && (
          <Pressable
            onPress={() => router.push('/forgot-password')}
            accessibilityRole="button"
            accessibilityLabel="Forgot your password"
            hitSlop={space.sm}
            style={styles.forgotWrap}
          >
            <Text style={styles.forgot}>Forgot password?</Text>
          </Pressable>
        )}

        {error !== null && (
          <Text style={styles.error} accessibilityLiveRegion="polite">
            {error}
          </Text>
        )}

        <Pressable
          style={[styles.button, (!canSubmit || busy) && styles.buttonDisabled]}
          onPress={() => void submit()}
          disabled={!canSubmit || busy}
          accessibilityRole="button"
          accessibilityLabel={mode === 'sign-up' ? 'Create account' : 'Sign in'}
        >
          {busy ? (
            <ActivityIndicator color={color.onAccent} />
          ) : (
            <Text style={styles.buttonLabel}>
              {mode === 'sign-up' ? 'Create account' : 'Sign in'}
            </Text>
          )}
        </Pressable>

        <Pressable
          onPress={() => {
            setMode(mode === 'sign-in' ? 'sign-up' : 'sign-in');
            setError(null);
          }}
          accessibilityRole="button"
          accessibilityLabel={
            mode === 'sign-in' ? 'Switch to creating an account' : 'Switch to signing in'
          }
        >
          <Text style={styles.switch}>
            {mode === 'sign-in' ? 'Need an account? Sign up' : 'Have an account? Sign in'}
          </Text>
        </Pressable>

        {mode === 'sign-up' && (
          // PRD/03 rule 1: a consent line below the password field. The documents must be
          // readable both signed out and signed in, which is why this sits here and not
          // behind the auth gate.
          //
          // The age is stated here as well as in the Terms, because a declared minimum age is
          // what the store age rating rests on and nobody reads the Terms. Declaring rather
          // than collecting a date of birth is deliberate - see ADR-0026.
          //
          // > **Both documents are reachable from here, and that is a requirement rather than a
          // > courtesy.** Apple's guideline 1.2 is discharged by the Terms screen's "no
          // > tolerance" wording, and `legal/terms.tsx` has always said the consent line links
          // > to it - while this line was plain text for the life of the project, so the only
          // > stated route to the document somebody is agreeing to did not exist. Found on
          // > 2026-08-12 by reading the rendered screen rather than the code.
          <View style={styles.consent}>
            <Text style={styles.consentText}>
              By creating an account you confirm you are 18 or over, and you agree to the{' '}
              <Text
                style={styles.consentLink}
                onPress={() => router.push('/legal/terms')}
                accessibilityRole="link"
                accessibilityLabel="Read the Terms"
              >
                Terms
              </Text>{' '}
              and the{' '}
              <Text
                style={styles.consentLink}
                onPress={() => router.push('/legal/privacy')}
                accessibilityRole="link"
                accessibilityLabel="Read the Privacy Policy"
              >
                Privacy Policy
              </Text>
              .
            </Text>
          </View>
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
  /** 3 degrees off square, which is v1's value. Enough to read as drawn rather than as a box. */
  brandBadge: {
    width: 64,
    height: 64,
    borderRadius: radius.lg,
    backgroundColor: color.accentSoft,
    alignItems: 'center',
    justifyContent: 'center',
    alignSelf: 'center',
    marginBottom: space.sm,
    transform: [{ rotate: '3deg' }],
  },
  wordmark: { ...type.display, color: color.accent, textAlign: 'center' },
  tagline: {
    ...type.bodySmall,
    color: color.textSecondary,
    textAlign: 'center',
    marginBottom: space.lg,
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
  forgotWrap: { alignSelf: 'flex-end' },
  forgot: { ...type.bodySmall, color: color.accent, paddingVertical: space.xs },
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
  consent: { paddingHorizontal: space.sm },
  consentText: { ...type.bodySmall, color: color.textSecondary, textAlign: 'center' },
  // The accent, so the two documents read as reachable rather than as emphasis.
  consentLink: { color: color.accent },
});
