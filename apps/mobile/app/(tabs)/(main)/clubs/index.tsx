/**
 * The Clubs destination.
 *
 * The list, plus the two ways in that `PRD/04` names: create, and join. Joining is by **search or
 * link only** - there is no screen anywhere that asks for a typed invite code (ADR-0010), and that
 * absence is a requirement rather than an omission.
 *
 * A row opens the club **hub**, not its chat. That is a change from the previous version, which
 * jumped straight into the main channel: the hub is where News, races, the Eboard space and the
 * calendar are reached from, and `PRD/15` puts News and Highlights as its first row.
 */

import { FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { RemoteImage } from '../../../../src/media-bubble.tsx';
import { Redirect, useRouter } from 'expo-router';
import { useClearClub } from '../../../../src/current-space.tsx';
import { unreadCount, type Club } from '@clubchat/shared';
import { clubApi } from '../../../../src/api.ts';
import { useSession } from '../../../../src/chat-provider.tsx';
import { color, radius, space, type } from '../../../../src/theme.ts';
import { DataScreen } from '../../../../src/ui.tsx';
import { useLoad } from '../../../../src/use-load.ts';

export default function ClubsScreen() {
  /*
   * The one screen that is outside every club, and therefore the ONLY one that clears it.
   *
   * > **Leaving a club is an act, not a side effect of glancing at another tab.** Calendar,
   * > Notifications and Profile each used to clear it too, and that broke the Clubs tab's whole
   * > purpose: stepping across to the Calendar and tapping CLUBS dropped you on this list instead
   * > of surfacing at the club's front door, which is what rule 2 of the navigation contract
   * > exists to give you. Worse, it did it inconsistently - the clear and the tab press raced, so
   * > the same two taps went two different places.
   *
   * The rule is now one sentence: you are inside a club until you come here. Which also makes
   * the club-scoped Calendar possible at all - it follows whichever club you are in.
   */
  useClearClub();
  const { authState, channels, revision } = useSession();
  const router = useRouter();

  const load = useLoad(() => clubApi.mine(), [revision]);

  // A guarded screen renders a placeholder in its denied branch, because the redirect lands a
  // frame later and an unguarded render would flash real chrome first.
  if (authState === 'checking') return <View style={styles.flex} />;
  if (authState === 'signed-out') return <Redirect href="/sign-in" />;

  const unreadFor = (channelId: string): number => {
    const channel = channels.find((entry) => entry.id === channelId);
    // Computed from the log, never stored. A stored count drifts; this one cannot.
    return channel ? unreadCount(channel) : 0;
  };

  return (
    <View style={styles.flex}>
      {/* v1's page header: the title, and one line saying what this screen is for. */}
      <View style={styles.heading}>
        <Text style={styles.title}>My Clubs</Text>
        <Text style={styles.subtitle}>Manage your teams and athletic communities</Text>
      </View>

      {/*
        The two ways in, side by side and equally weighted. Create is filled and Join is outlined,
        which is the only hierarchy between them - both are first-class, and a member with no clubs
        needs whichever one matches how they heard about the club.
      */}
      <View style={styles.actions}>
        <Pressable
          style={styles.primaryButton}
          onPress={() => router.push('/clubs/create')}
          accessibilityRole="button"
          accessibilityLabel="Create a club"
        >
          <MaterialIcons name="add-circle" size={18} color={color.onAccent} />
          <Text style={styles.primaryButtonText}>Create a Club</Text>
        </Pressable>
        <Pressable
          style={styles.secondaryButton}
          onPress={() => router.push('/clubs/join')}
          accessibilityRole="button"
          accessibilityLabel="Join a club"
        >
          <MaterialIcons name="explore" size={18} color={color.accent} />
          <Text style={styles.secondaryButtonText}>Join a Club</Text>
        </Pressable>
      </View>

      <DataScreen load={load}>
        {(data) => (
          <FlatList<Club>
            data={data.clubs}
            keyExtractor={(club) => club.id}
            contentContainerStyle={styles.list}
            refreshControl={
              <RefreshControl
                refreshing={load.state === 'loading'}
                onRefresh={load.reload}
                tintColor={color.accent}
              />
            }
            ListEmptyComponent={
              <View style={styles.empty}>
                <MaterialIcons name="groups" size={48} color={color.border} />
                <Text style={styles.emptyTitle}>No clubs yet?</Text>
                <Text style={styles.emptyBody}>
                  Every champion needs a team. Join an existing club or lead your own squad to
                  victory.
                </Text>
                <Pressable
                  style={styles.primaryButton}
                  onPress={() => router.push('/clubs/create')}
                  accessibilityRole="button"
                  accessibilityLabel="Create your first club"
                >
                  <Text style={styles.primaryButtonText}>Create your first club</Text>
                </Pressable>
              </View>
            }
            renderItem={({ item }) => {
              const unread = unreadFor(item.mainChannelId);
              const isAdminTier = item.role === 'owner' || item.role === 'admin';
              return (
                <Pressable
                  style={styles.clubRow}
                  onPress={() => router.push(`/clubs/${item.id}`)}
                  accessibilityRole="button"
                  accessibilityLabel={`Open ${item.name}, ${item.role}`}
                >
                  <View style={styles.clubRowLeft}>
                    {item.image === null ? (
                      <View style={styles.clubAvatar}>
                        <Text style={styles.clubAvatarInitial}>
                          {item.name.charAt(0).toUpperCase()}
                        </Text>
                      </View>
                    ) : (
                      <RemoteImage
                        mediaId={item.image}
                        variant="thumb"
                        style={styles.clubAvatar}
                        resizeMode="cover"
                      />
                    )}
                    <View style={styles.clubRowText}>
                      <Text style={styles.clubName} numberOfLines={1}>
                        {item.name}
                      </Text>
                      <Text style={styles.clubSport}>{item.sport}</Text>
                    </View>
                  </View>
                  <View style={styles.clubRowRight}>
                    {/* Only when there IS unread. A zero badge is noise. */}
                    {unread > 0 && (
                      <Text style={styles.unreadBadge}>{unread > 99 ? '99+' : unread}</Text>
                    )}
                    {/* Role badges are visible, so authority is never guessed. */}
                    <Text
                      style={[
                        styles.roleBadge,
                        isAdminTier ? styles.roleBadgeAdmin : styles.roleBadgeMember,
                      ]}
                    >
                      {item.role === 'owner' ? 'Owner' : item.role === 'admin' ? 'Admin' : 'Member'}
                    </Text>
                    <MaterialIcons name="chevron-right" size={22} color={color.textSecondary} />
                  </View>
                </Pressable>
              );
            }}
          />
        )}
      </DataScreen>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: color.appBackground, padding: space.md },

  heading: { marginBottom: space.md },
  title: { ...type.title, color: color.textPrimary },
  subtitle: {
    ...type.label,
    color: color.textSecondary,
    marginTop: space.xs,
    textTransform: 'none',
  },

  actions: { flexDirection: 'row', gap: space.sm, marginBottom: space.md },
  primaryButton: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.xs,
    backgroundColor: color.accent,
    borderRadius: radius.pill,
    paddingVertical: space.sm + 4,
  },
  primaryButtonText: { ...type.label, color: color.onAccent, textTransform: 'uppercase' },
  secondaryButton: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.xs,
    // A 2px edge, not a hairline: this is a peer of the filled button, not a quiet control.
    borderWidth: 2,
    borderColor: color.accent,
    borderRadius: radius.pill,
    paddingVertical: space.sm + 4,
  },
  secondaryButtonText: { ...type.label, color: color.accent, textTransform: 'uppercase' },

  list: { gap: space.sm, paddingBottom: space.lg },
  clubRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    backgroundColor: color.card,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: color.hairline,
    padding: space.md,
  },
  clubRowLeft: { flexDirection: 'row', alignItems: 'center', gap: space.md, flex: 1 },
  clubRowText: { flex: 1 },
  // Larger than the avatar anywhere else in the app: a club is the biggest thing in the product,
  // and this list is the first screen anybody sees.
  clubAvatar: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: color.cardSunken,
    alignItems: 'center',
    justifyContent: 'center',
  },
  clubAvatarInitial: { ...type.title, fontSize: 20, lineHeight: 26, color: color.accent },
  clubName: { ...type.headline, fontSize: 17, color: color.textPrimary },
  clubSport: { ...type.label, color: color.onSecondaryContainer, marginTop: 2, textTransform: 'none' },
  clubRowRight: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  roleBadge: {
    ...type.label,
    borderRadius: radius.pill,
    paddingHorizontal: space.sm,
    paddingVertical: 4,
    textTransform: 'none',
    overflow: 'hidden',
  },
  roleBadgeAdmin: { backgroundColor: color.accentSoft, color: color.onAccentSoft },
  roleBadgeMember: { backgroundColor: color.fallback, color: color.textSecondary },
  unreadBadge: {
    ...type.label,
    fontSize: 10,
    minWidth: 20,
    textAlign: 'center',
    borderRadius: radius.pill,
    paddingHorizontal: space.xs,
    paddingVertical: 2,
    backgroundColor: color.error,
    color: color.onAccent,
    overflow: 'hidden',
  },

  empty: { alignItems: 'center', marginTop: 60, gap: space.sm, paddingHorizontal: space.md },
  emptyTitle: { ...type.title, fontSize: 20, lineHeight: 26, color: color.textPrimary },
  emptyBody: {
    ...type.body,
    color: color.textSecondary,
    textAlign: 'center',
    maxWidth: 280,
  },

});
