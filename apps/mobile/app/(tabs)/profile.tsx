/**
 * Own profile: identity, "Your clubs", and the account controls.
 *
 * Two things here are load-bearing rather than cosmetic.
 *
 * **The date of birth is only on your own profile.** The server withholds it from everybody else,
 * so this screen is the only place it appears - and it appears because it is yours, not because
 * this screen is privileged.
 *
 * **Account deletion has a precondition, and the screen has to explain it.** Deleting refuses while
 * you still own a club, because an ownerless club has no recovery path and an Owner cannot leave.
 * A dialog that just said "failed" would leave somebody stuck; this offers the way out.
 */

import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Redirect, useRouter } from 'expo-router';
import { accountApi, ApiError, clubApi } from '../../src/api.ts';
import { useSession } from '../../src/chat-provider.tsx';
import { color, space, type } from '../../src/theme.ts';
import { Action, Avatar, Card, DataScreen, Field, Row, SectionHeader } from '../../src/ui.tsx';
import { useLoad } from '../../src/use-load.ts';

export default function ProfileScreen() {
  const { authState, userId, signOut, revision } = useSession();
  const router = useRouter();
  const [editing, setEditing] = useState(false);

  const profile = useLoad(
    () => (userId ? accountApi.profile(userId) : Promise.reject(new Error('no session'))),
    [userId, revision],
  );
  const clubs = useLoad(() => clubApi.mine(), [revision]);

  if (authState === 'checking') return <View style={styles.flex} />;
  if (authState === 'signed-out') return <Redirect href="/sign-in" />;

  return (
    <DataScreen load={profile}>
      {(data) =>
        editing ? (
          <EditProfile
            initial={data.profile}
            onDone={() => {
              setEditing(false);
              profile.reload();
            }}
            onCancel={() => setEditing(false)}
          />
        ) : (
          <View style={styles.body}>
            <Card>
              <View style={styles.identity}>
                <Avatar name={data.profile.name} size={64} />
                <View style={styles.identityText}>
                  <Text style={styles.name}>{data.profile.name}</Text>
                  {/* Absent rows are simply absent, never rendered as an empty line. */}
                  {data.profile.city !== null && data.profile.city.length > 0 && (
                    <Text style={styles.meta}>{data.profile.city}</Text>
                  )}
                  {data.profile.school !== null && data.profile.school.length > 0 && (
                    <Text style={styles.meta}>{data.profile.school}</Text>
                  )}
                </View>
              </View>
              {data.profile.bio !== null && data.profile.bio.length > 0 && (
                <Text style={styles.bio}>{data.profile.bio}</Text>
              )}
              {/* Yours alone: the server does not return this field to anybody else. */}
              {data.profile.dob !== null && data.profile.dob !== undefined && (
                <Text style={styles.meta}>Born {data.profile.dob}</Text>
              )}
              <Action label="Edit profile" variant="secondary" onPress={() => setEditing(true)} />
            </Card>

            <SectionHeader title="Your clubs" />
            {(clubs.data?.clubs ?? []).length === 0 ? (
              <Text style={styles.meta}>You are not in any clubs yet.</Text>
            ) : (
              (clubs.data?.clubs ?? []).map((club) => (
                <Row
                  key={club.id}
                  title={club.name}
                  subtitle={`${club.sport}  ·  ${club.role}`}
                  href={`/clubs/${club.id}`}
                />
              ))
            )}

            <SectionHeader title="Legal" />
            {/* Readable signed in AND signed out, which is why they are their own routes. */}
            <Row title="Privacy Policy" href="/legal/privacy" />
            <Row title="Terms" href="/legal/terms" />

            <SectionHeader title="Account" />
            <Action
              label="Sign out"
              variant="secondary"
              onPress={() => {
                void signOut();
                router.replace('/sign-in');
              }}
            />
            <DeleteAccount ownedClubs={(clubs.data?.clubs ?? []).filter((c) => c.role === 'owner')} />
          </View>
        )
      }
    </DataScreen>
  );
}

function EditProfile({
  initial,
  onDone,
  onCancel,
}: {
  initial: { name: string; bio: string | null; city: string | null; school: string | null; dob?: string | null };
  onDone: () => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(initial.name);
  const [bio, setBio] = useState(initial.bio ?? '');
  const [city, setCity] = useState(initial.city ?? '');
  const [school, setSchool] = useState(initial.school ?? '');
  const [dob, setDob] = useState(initial.dob ?? '');
  const [failed, setFailed] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const save = async () => {
    setBusy(true);
    setFailed(null);
    try {
      await accountApi.saveProfile({
        name: name.trim(),
        // An empty field is an explicit null: the member cleared it, which is different from
        // not having touched it.
        bio: bio.trim().length > 0 ? bio.trim() : null,
        city: city.trim().length > 0 ? city.trim() : null,
        school: school.trim().length > 0 ? school.trim() : null,
        dob: dob.trim().length > 0 ? dob.trim() : null,
      });
      onDone();
    } catch (caught) {
      setFailed(
        caught instanceof ApiError && caught.status === 400
          ? 'Check the fields: a name is required, and a date of birth must be YYYY-MM-DD.'
          : 'Could not save. Check your connection and try again.',
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={styles.body}>
      <SectionHeader title="Edit profile" />
      <Field label="Full name" value={name} onChangeText={setName} />
      <Field label="Bio" value={bio} onChangeText={setBio} multiline />
      <Field label="City" value={city} onChangeText={setCity} />
      <Field label="School" value={school} onChangeText={setSchool} />
      <Field label="Date of birth" value={dob} onChangeText={setDob} placeholder="1999-04-01" />
      <Text style={styles.meta}>
        Your date of birth is never shown to other members. Email is used for sign-in only.
      </Text>
      {failed !== null && <Text style={styles.error}>{failed}</Text>}
      <View style={styles.actions}>
        <Action label="Cancel" variant="secondary" onPress={onCancel} style={styles.actionButton} />
        <Action
          label={busy ? 'Saving' : 'Save'}
          onPress={() => void save()}
          disabled={busy || name.trim().length === 0}
          style={styles.actionButton}
        />
      </View>
    </View>
  );
}

/**
 * Delete account: confirmation-gated, and honest about the precondition.
 *
 * > **`Alert` is a no-op on web**, which is `PRD/16` rule 6 and shipped as a real defect in v1: a
 * > delete button reported success, logged nothing, and did nothing. So confirmation is a rendered
 * > two-step here rather than a native dialog, on every platform. The same code path runs
 * > everywhere, which is the only way the web behaviour cannot diverge.
 */
function DeleteAccount({ ownedClubs }: { ownedClubs: Array<{ id: string; name: string }> }) {
  const { signOut } = useSession();
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);

  const remove = async () => {
    setFailed(null);
    try {
      await accountApi.deleteAccount();
      await signOut();
      router.replace('/sign-in');
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 409) {
        setFailed(
          'You still own a club. Transfer it to another admin, or delete it, and then you can delete your account.',
        );
        return;
      }
      setFailed('Could not delete your account. Check your connection and try again.');
    }
  };

  if (ownedClubs.length > 0) {
    return (
      <Card>
        <Text style={styles.meta}>
          You own {ownedClubs.length === 1 ? 'a club' : `${ownedClubs.length} clubs`}, so your
          account cannot be deleted yet: a club without an Owner cannot be recovered. Transfer
          ownership or delete the club first.
        </Text>
        {ownedClubs.map((club) => (
          <Row key={club.id} title={club.name} subtitle="Transfer or delete" href={`/clubs/${club.id}/profile`} />
        ))}
      </Card>
    );
  }

  if (!confirming) {
    return (
      <>
        <Action
          label="Delete account"
          variant="danger"
          onPress={() => setConfirming(true)}
          accessibilityLabel="Delete your account"
        />
        {failed !== null && <Text style={styles.error}>{failed}</Text>}
      </>
    );
  }

  return (
    <Card>
      {/* The confirmation names what is destroyed and states what is lost. */}
      <Text style={styles.confirmTitle}>Delete your account permanently?</Text>
      <Text style={styles.meta}>
        Your profile is erased and you can never sign in again. Messages you have already sent stay
        in their conversations, without your name on them.
      </Text>
      {failed !== null && <Text style={styles.error}>{failed}</Text>}
      <View style={styles.actions}>
        <Action
          label="Keep my account"
          variant="secondary"
          onPress={() => setConfirming(false)}
          style={styles.actionButton}
        />
        <Action
          label="Delete for good"
          variant="danger"
          onPress={() => void remove()}
          style={styles.actionButton}
        />
      </View>
    </Card>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: color.appBackground },
  body: { flex: 1, padding: space.md, gap: space.sm, backgroundColor: color.appBackground },
  identity: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  identityText: { flex: 1, gap: space.xs },
  name: { ...type.title, color: color.textPrimary },
  bio: { ...type.body, color: color.textPrimary },
  meta: { ...type.bodySmall, color: color.textSecondary },
  error: { ...type.bodySmall, color: color.error },
  confirmTitle: { ...type.headline, color: color.textPrimary },
  actions: { flexDirection: 'row', gap: space.sm },
  actionButton: { flex: 1 },
});
