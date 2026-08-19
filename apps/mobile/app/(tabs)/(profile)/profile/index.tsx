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
import {
  ActivityIndicator,
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { Link, Redirect, useRouter } from 'expo-router';
import { accountApi, ApiError, clubApi } from '../../../../src/api.ts';
import { useSession } from '../../../../src/chat-provider.tsx';
import { formatDateOfBirth } from '../../../../src/dates.ts';
import { RemoteImage } from '../../../../src/media-bubble.tsx';
import { supportMailto } from '../../../../src/support.ts';
import { pickSquarePhoto, uploadAvatar, UploadError } from '../../../../src/upload.ts';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { color, radius, space, tabBarSpace, type } from '../../../../src/theme.ts';
import {
  Action,
  Card,
  DataScreen,
  DestinationHeader,
  Field,
  Row,
  SearchField,
  SectionHeader,
} from '../../../../src/ui.tsx';
import { useLoad, useRefreshOnReturn } from '../../../../src/use-load.ts';

export default function ProfileScreen() {
  const { authState, userId, signOut } = useSession();
  const router = useRouter();
  // The tab bar floats OVER this screen - "Edit Profile" was the row it was cutting in half.
  const insets = useSafeAreaInsets();
  const [clubsOpen, setClubsOpen] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [pictureError, setPictureError] = useState<string | null>(null);

  /*
   * The pencil opens the photo picker directly rather than the edit form.
   *
   * Changing a picture is one gesture and has nothing to do with the text fields, so routing it
   * through a form would make the badge a link to somewhere the picture is not. Identity media is
   * public and needs no channel - the only gate is being signed in.
   */
  const changePicture = async () => {
    setPictureError(null);
    const picked = await pickSquarePhoto();
    if (!picked) return;
    setUploading(true);
    try {
      const mediaId = await uploadAvatar(picked);
      await accountApi.saveProfile({ image: mediaId });
      profile.reload();
    } catch (error) {
      setPictureError(
        error instanceof UploadError ? error.message : 'Could not update your picture.',
      );
    } finally {
      setUploading(false);
    }
  };
  const [clubSearch, setClubSearch] = useState('');

  /*
   * Your own profile, your own clubs, your own identity - on arrival and on RETURN, not on
   * `revision`.
   *
   * > **All three were re-read whenever anything happened on the socket**, and none of them can
   * > be changed by it. A message arriving, or somebody else's read cursor moving, does not
   * > rename you, does not change your email, and does not join you to a club. This is the
   * > entry TECH/18 3.4 lists as "Profile: own profile, own club list, own identity", and it is
   * > 2.4's defect a third time.
   *
   * A tab screen stays mounted once opened (2.10), so before this the Profile tab kept answering
   * socket traffic from behind whatever you were actually looking at.
   *
   * Joining or leaving a club still shows up, because that is a return to this screen - the same
   * mechanism 2.10 gave the calendar. Actions taken here already call `reload` themselves.
   */
  const profile = useLoad(
    () => (userId ? accountApi.profile(userId) : Promise.reject(new Error('no session'))),
    [userId],
  );
  const clubs = useLoad(() => clubApi.mine(), []);
  // The email lives on the identity read, never on a profile - see `readIdentity`.
  const identity = useLoad(() => accountApi.me(), []);
  useRefreshOnReturn(profile, userId ?? '');
  useRefreshOnReturn(clubs, userId ?? '');
  useRefreshOnReturn(identity, userId ?? '');
  const allClubs = clubs.data?.clubs ?? [];
  const clubCount = allClubs.length;

  if (authState === 'checking') return <View style={styles.flex} />;
  if (authState === 'signed-out') return <Redirect href="/sign-in" />;

  return (
    <View style={styles.flex}>
      <DestinationHeader title="Profile" />
      <DataScreen load={profile}>
      {(data) => (
        <ScrollView
          contentContainerStyle={[styles.body, { paddingBottom: tabBarSpace(insets.bottom) }]}
        >
            {/*
              Identity, centred and at the top: this screen is about a person, so it opens with
              their face rather than with a settings list they happen to own.
            */}
            <View style={styles.avatarWrap}>
              {/*
                Your own picture, which this screen is the only place to set - and which it did
                not draw at all until now: the upload succeeded, the id was saved, and the letter
                stayed. The ring is drawn by the wrapper rather than the image so both states
                sit in the same frame.
              */}
              {data.profile.image === null ? (
                <View style={styles.avatar}>
                  <Text style={styles.avatarInitial}>
                    {data.profile.name.charAt(0).toUpperCase() || '?'}
                  </Text>
                </View>
              ) : (
                <RemoteImage
                  mediaId={data.profile.image}
                  variant="display"
                  style={styles.avatar}
                  resizeMode="cover"
                  accessibilityLabel="Your picture"
                />
              )}
              <Pressable
                style={styles.editPic}
                onPress={() => void changePicture()}
                disabled={uploading}
                accessibilityRole="button"
                accessibilityLabel="Change your picture"
              >
                {uploading ? (
                  <ActivityIndicator size="small" color={color.onAccent} />
                ) : (
                  <MaterialIcons name="edit" size={18} color={color.onAccent} />
                )}
              </Pressable>
            </View>

            <Text style={styles.name}>{data.profile.name || 'ClubChat member'}</Text>
            {identity.data !== null && <Text style={styles.email}>{identity.data.email}</Text>}
            <Text style={styles.bioLine}>{data.profile.bio || 'No bio yet.'}</Text>
            {pictureError !== null && <Text style={styles.error}>{pictureError}</Text>}

            <View style={styles.section}>
              <View style={styles.sectionHead}>
                <Text style={styles.sectionTitle}>Your Clubs</Text>
                <Text style={styles.sectionCount}>
                  {clubCount} CLUB{clubCount === 1 ? '' : 'S'}
                </Text>
              </View>

              {clubCount === 0 ? (
                <Text style={styles.meta}>You have not joined any clubs yet.</Text>
              ) : (
                <View style={styles.chipRow}>
                  {allClubs.slice(0, CLUB_CHIP_LIMIT).map((club) => (
                    <Pressable
                      key={club.id}
                      style={styles.clubChip}
                      /*
                        A cross-tab jump, so it carries where it came from AND replaces rather
                        than pushes. Both halves matter: `from=profile` makes the hub's back arrow
                        return here, and replacing leaves the Clubs tab reading as the My Clubs
                        list underneath. Push instead and tapping Clubs later lands back on this
                        hub whose back bounces to Profile - a live loop rather than a quirk.
                      */
                      onPress={() => router.replace(`/clubs/${club.id}?from=profile`)}
                      accessibilityRole="button"
                      accessibilityLabel={`${club.name}, ${club.role}. Open`}
                    >
                      <Text style={styles.clubChipName}>{club.name}</Text>
                      <Text style={styles.clubChipRole}>{roleLabel(club.role)}</Text>
                    </Pressable>
                  ))}
                  {/*
                    Three chips, then a count. A member of nine clubs would otherwise push their
                    own details off the screen, and the overflow is a search rather than a longer
                    list because finding one club by name is what somebody with nine of them wants.
                  */}
                  {clubCount > CLUB_CHIP_LIMIT && (
                    <Pressable
                      style={styles.moreChip}
                      onPress={() => {
                        setClubSearch('');
                        setClubsOpen(true);
                      }}
                      accessibilityRole="button"
                      accessibilityLabel={`Show all ${clubCount} clubs`}
                    >
                      <Text style={styles.moreChipLabel}>
                        +{clubCount - CLUB_CHIP_LIMIT} more
                      </Text>
                    </Pressable>
                  )}
                </View>
              )}
            </View>

            <View style={styles.card}>
              <DetailRow label="City" value={data.profile.city || 'Not set'} />
              <DetailRow label="Date of birth" value={formatDateOfBirth(data.profile.dob)} />
              <DetailRow label="School" value={data.profile.school || 'Not set'} last />
            </View>

            {/*
              The moderation queue, for the accounts that carry the flag and nobody else.
              
              Hidden rather than disabled for everybody else, because it is not a feature they
              lack permission for - it is not part of their product at all. The server refuses it
              regardless: this row is what makes it reachable, never what makes it allowed.
            */}
            {identity.data?.isPlatformModerator === true && (
              <View style={styles.card}>
                <LinkRow
                  icon="gavel"
                  label="Reported messages"
                  href="/moderation"
                  last
                />
              </View>
            )}

            <View style={styles.card}>
              <LinkRow icon="manage-accounts" label="Edit Profile" href="/profile/edit" />
              <View style={styles.linkDivider} />
              <LinkRow icon="lock" label="Privacy Policy" href="/legal/privacy" />
              <View style={styles.linkDivider} />
              <LinkRow icon="description" label="Terms of Service" href="/legal/terms" />
              <View style={styles.linkDivider} />
              {/*
                Published contact information, which Apple's guideline 1.2 requires of any app
                carrying user-generated content. Here as well as in the two legal screens because
                somebody who needs to reach a person is not going to look for the address inside
                the Terms.
              */}
              <LinkRow
                icon="mail-outline"
                label="Contact support"
                onPress={() =>
                  void Linking.openURL(supportMailto('ClubChat: support')).catch(() => {})
                }
                last
              />
            </View>

            <Pressable
              style={styles.signOut}
              /*
               * Sign out and navigate NOWHERE. The guard at the top of this screen already sends a
               * signed-out reader to sign-in, and that is the rule stated once.
               *
               * > **This navigated itself, and the navigation raced the sign-out it belonged to.**
               * > `signOut` is async and was not awaited, so `replace('/sign-in')` ran while the
               * > session was still signed IN - and sign-in's own guard, which exists so a signed-in
               * > reader never sits on it, bounced straight back to `/clubs` as a forward push.
               * > Then the sign-out landed and the guards popped to sign-in. Two transitions in
               * > opposite directions from one tap: "pop push at same time".
               *
               * Awaiting first would also fix it, and would still be two implementations of one
               * rule sitting next to each other waiting to disagree again.
               */
              onPress={() => void signOut()}
              accessibilityRole="button"
              accessibilityLabel="Sign out"
            >
              <MaterialIcons name="logout" size={18} color={color.onSecondaryContainer} />
              <Text style={styles.signOutLabel}>Sign out</Text>
            </Pressable>

            <DeleteAccount ownedClubs={allClubs.filter((c) => c.role === 'owner')} />

            {clubsOpen && (
              <ClubsSheet
                clubs={allClubs}
                query={clubSearch}
                onQuery={setClubSearch}
                onDismiss={() => setClubsOpen(false)}
                onPick={(clubId) => {
                  setClubsOpen(false);
                  router.replace(`/clubs/${clubId}?from=profile`);
                }}
              />
            )}
        </ScrollView>
      )}
      </DataScreen>
    </View>
  );
}

/** Three chips, then a count. See the note at the call site. */
const CLUB_CHIP_LIMIT = 3;

function roleLabel(role: string): string {
  return role === 'owner' ? 'Owner' : role === 'admin' ? 'Admin' : 'Member';
}

/** A label-and-value line in the details card. */
function DetailRow({ label, value, last }: { label: string; value: string; last?: boolean }) {
  return (
    <View style={[styles.detailRow, last === true && styles.detailRowLast]}>
      <Text style={styles.detailLabel}>{label}</Text>
      <Text style={styles.detailValue}>{value}</Text>
    </View>
  );
}

/** A settings row: a tinted icon well, a label, a chevron. */
function LinkRow({
  icon,
  label,
  href,
  onPress,
  last,
}: {
  icon: React.ComponentProps<typeof MaterialIcons>['name'];
  label: string;
  href?: string;
  onPress?: () => void;
  last?: boolean;
}) {
  const body = (
    <>
      <View style={styles.linkIcon}>
        <MaterialIcons name={icon} size={18} color={color.secondary} />
      </View>
      <Text style={styles.linkLabel}>{label}</Text>
      <MaterialIcons name="chevron-right" size={20} color={color.textSecondary} />
    </>
  );
  /*
   * Flattened, not an array. `Link asChild` clones its child and Expo Router rejects an array
   * style on it outright - which renders the whole screen blank rather than mis-styling one row,
   * so it fails loudly and in a way that looks nothing like its cause.
   */
  const style = StyleSheet.flatten([styles.linkRow, last === true && styles.linkRowLast]);

  if (href !== undefined) {
    return (
      <Link href={href} asChild accessibilityRole="link" accessibilityLabel={label}>
        <Pressable style={style}>{body}</Pressable>
      </Link>
    );
  }
  return (
    <Pressable style={style} onPress={onPress} accessibilityRole="button" accessibilityLabel={label}>
      {body}
    </Pressable>
  );
}

/**
 * Every club, searchable.
 *
 * The overflow behind "+N more". A search rather than a longer list, because somebody with nine
 * clubs is looking for one by name - scrolling a list of nine to find it is the thing the chips
 * were already doing badly.
 */
function ClubsSheet({
  clubs,
  query,
  onQuery,
  onDismiss,
  onPick,
}: {
  clubs: ReadonlyArray<{ id: string; name: string; role: string }>;
  query: string;
  onQuery: (next: string) => void;
  onDismiss: () => void;
  onPick: (clubId: string) => void;
}) {
  const needle = query.trim().toLowerCase();
  const shown = needle.length === 0 ? clubs : clubs.filter((c) => c.name.toLowerCase().includes(needle));

  return (
    <View style={styles.sheetBackdrop}>
      <Pressable
        style={styles.sheetScrim}
        onPress={onDismiss}
        accessibilityRole="button"
        accessibilityLabel="Close"
      />
      <View style={styles.sheet}>
        <View style={styles.sheetHead}>
          <Text style={styles.sheetTitle}>Your Clubs</Text>
          <Pressable
            onPress={onDismiss}
            hitSlop={space.sm}
            accessibilityRole="button"
            accessibilityLabel="Close"
          >
            <MaterialIcons name="close" size={22} color={color.textPrimary} />
          </Pressable>
        </View>

        <SearchField value={query} onChangeText={onQuery} placeholder="Search clubs" />

        <ScrollView style={styles.sheetList}>
          {shown.length === 0 ? (
            <Text style={styles.meta}>No clubs match "{query}".</Text>
          ) : (
            shown.map((club) => (
              <Pressable
                key={club.id}
                style={styles.sheetRow}
                onPress={() => onPick(club.id)}
                accessibilityRole="button"
                accessibilityLabel={`${club.name}, ${club.role}. Open`}
              >
                <Text style={styles.sheetRowName}>{club.name}</Text>
                <Text style={styles.sheetRowRole}>{roleLabel(club.role)}</Text>
              </Pressable>
            ))
          )}
        </ScrollView>
      </View>
    </View>
  );
}

function DeleteAccount({ ownedClubs }: { ownedClubs: Array<{ id: string; name: string }> }) {
  const { signOut } = useSession();
  const [confirming, setConfirming] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);

  const remove = async () => {
    setFailed(null);
    try {
      await accountApi.deleteAccount();
      // Same rule as Sign out: clearing the session is the whole act, and the screen's guard is
      // what moves. This one did await, so it never raced - it was only the second copy.
      await signOut();
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
  body: {
    alignItems: 'center',
    padding: space.md,
    paddingBottom: space.xl,
    gap: space.xs,
  },
  meta: { ...type.bodySmall, color: color.textSecondary },

  avatarWrap: { width: 112, height: 112, marginVertical: space.sm },
  avatar: {
    width: 112,
    height: 112,
    borderRadius: 56,
    backgroundColor: color.cardRaised,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 4,
    borderColor: color.fallback,
    // Shared with the uploaded picture, which has to be clipped to the same circle.
    overflow: 'hidden',
  },
  avatarInitial: { ...type.display, fontSize: 40, lineHeight: 46, color: color.accent },
  editPic: {
    position: 'absolute',
    right: 2,
    bottom: 2,
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: color.accent,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
    borderColor: color.card,
  },

  name: { ...type.title, fontSize: 22, lineHeight: 28, color: color.textPrimary },
  email: { ...type.body, color: color.textSecondary },
  bioLine: {
    ...type.body,
    color: color.onSecondaryContainer,
    textAlign: 'center',
    maxWidth: 300,
    marginTop: space.xs,
  },

  section: { width: '100%', maxWidth: 420, marginTop: space.lg },
  sectionHead: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: space.sm,
  },
  sectionTitle: { ...type.title, fontSize: 17, lineHeight: 22, color: color.textPrimary },
  sectionCount: { ...type.label, color: color.accent },

  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  clubChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    backgroundColor: color.cardSunken,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: color.hairline,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
  },
  clubChipName: { ...type.label, color: color.textPrimary, textTransform: 'none' },
  clubChipRole: { ...type.label, color: color.textSecondary, textTransform: 'none' },
  moreChip: {
    backgroundColor: color.card,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: color.accent,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
  },
  moreChipLabel: { ...type.label, color: color.accent, textTransform: 'none' },

  card: {
    width: '100%',
    maxWidth: 420,
    marginTop: space.lg,
    backgroundColor: color.card,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: color.hairline,
    overflow: 'hidden',
  },
  detailRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: space.md,
    paddingVertical: space.sm + 2,
    borderBottomWidth: 1,
    borderBottomColor: color.cardSunken,
  },
  detailRowLast: { borderBottomWidth: 0 },
  detailLabel: { ...type.label, color: color.textSecondary, textTransform: 'none' },
  detailValue: { ...type.bodySmall, color: color.textPrimary },

  linkRow: { flexDirection: 'row', alignItems: 'center', gap: space.md, padding: space.md },
  linkRowLast: {},
  linkIcon: {
    width: 36,
    height: 36,
    borderRadius: radius.sm,
    backgroundColor: color.secondaryContainer,
    alignItems: 'center',
    justifyContent: 'center',
  },
  linkLabel: { flex: 1, ...type.body, color: color.textPrimary },
  linkDivider: { height: 1, backgroundColor: color.cardSunken, marginHorizontal: space.md },

  signOut: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    backgroundColor: color.secondaryContainer,
    borderRadius: radius.pill,
    paddingVertical: space.sm + 4,
    paddingHorizontal: space.md + 4,
    marginTop: space.xl,
  },
  signOutLabel: { ...type.label, color: color.onSecondaryContainer, textTransform: 'none' },

  sheetBackdrop: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    justifyContent: 'center',
    padding: space.md,
    zIndex: 100,
  },
  sheetScrim: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(0,0,0,0.4)',
  },
  sheet: {
    backgroundColor: color.card,
    borderRadius: radius.lg,
    padding: space.md,
    gap: space.sm,
    maxHeight: '70%',
    width: '100%',
    maxWidth: 420,
    alignSelf: 'center',
  },
  sheetHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  sheetTitle: { ...type.title, fontSize: 18, lineHeight: 24, color: color.textPrimary },
  sheetList: { marginTop: space.xs },
  sheetRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: space.md,
    borderBottomWidth: 1,
    borderBottomColor: color.cardSunken,
  },
  sheetRowName: { ...type.body, color: color.textPrimary },
  sheetRowRole: { ...type.label, color: color.textSecondary, textTransform: 'none' },

  // Kept for the edit form and the delete-account flow below.
  error: { ...type.bodySmall, color: color.error },
  actions: { flexDirection: 'row', gap: space.sm },
  actionButton: { flex: 1 },
  confirmTitle: { ...type.headline, color: color.textPrimary },
});
