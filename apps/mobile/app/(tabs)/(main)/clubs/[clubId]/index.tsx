/**
 * The club hub.
 *
 * `PRD/15` fixes the order, and the first row is the point: **News and Highlights is the club's
 * front page**, above chat. Chat is the centre of gravity but the hub is what somebody opens a club
 * to see, and putting the feed second would make the hub a menu.
 *
 * The Eboard row is absent for an ordinary member rather than disabled. Rule 4 of `PRD/10` gives
 * them no visibility that the space exists at all, and a greyed-out row is visibility.
 */

import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { Link, Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useState } from 'react';
import { useDeclareClub } from '../../../../../src/current-space.tsx';
import { RemoteImage } from '../../../../../src/media-bubble.tsx';
import { BackAlwaysTo } from '../../../../../src/nav.tsx';
import { unreadCount } from '@clubchat/shared';
import { clubApi, raceApi } from '../../../../../src/api.ts';
import { useSession } from '../../../../../src/chat-provider.tsx';
import { color, radius, space, type } from '../../../../../src/theme.ts';
import { DataScreen, SearchField } from '../../../../../src/ui.tsx';
import { useLoad } from '../../../../../src/use-load.ts';

/** How many races the hub previews before "See all". */
const RACE_PREVIEW = 5;

export default function ClubHubScreen() {
  const { clubId, from } = useLocalSearchParams<{ clubId: string; from?: string }>();

  /*
   * Where this hub's back control goes, which depends on how the hub was reached.
   *
   * Two of the three entries are cross-stack jumps that leave misleading history behind, so both
   * override the arrow rather than trusting it:
   *
   *  - `from=clubsTab`: the Clubs tab's shortcut, which surfaced here from arbitrary depth. Its
   *    back must be the My Clubs list. Popping would drop the person back into the deep screen
   *    they just escaped, which makes the shortcut useless.
   *  - `from=profile`: a club chip on the Profile screen. Its back must be Profile - and the
   *    Clubs tab underneath must ALREADY read as the My Clubs list, which is why the jump
   *    replaces rather than pushes. Otherwise tapping Clubs later returns here and back bounces
   *    to Profile again, which is a live loop rather than a quirk.
   *
   * Anything else is an ordinary push from the list, where popping is exactly right.
   */
  const jumped = from === 'clubsTab' || from === 'profile';
  const backHref = from === 'profile' ? '/profile' : '/clubs';
  const backLabel = from === 'profile' ? 'Profile' : 'Clubs';
  const { channels, revision } = useSession();
  const router = useRouter();
  const [racesOpen, setRacesOpen] = useState(false);
  const [raceSearch, setRaceSearch] = useState('');

  const club = useLoad(() => clubApi.detail(clubId), [clubId, revision]);
  const races = useLoad(() => raceApi.list(clubId), [clubId, revision]);
  // Inside this club for as long as this screen is mounted, and carrying its name so every
  // header below can show the club's identity rather than the screen's.
  useDeclareClub(clubId, club.data?.club.name, club.data?.club.image);

  const unreadFor = (channelId: string | null): number => {
    if (channelId === null) return 0;
    const channel = channels.find((entry) => entry.id === channelId);
    return channel ? unreadCount(channel) : 0;
  };

  return (
    <DataScreen load={club}>
      {(data) => {
        const previewed = (races.data?.races ?? []).slice(0, RACE_PREVIEW);
        const total = races.data?.races.length ?? 0;
        const unread = unreadFor(data.club.channelId);

        return (
          <ScrollView style={styles.flex} contentContainerStyle={styles.content}>
            <Stack.Screen
              options={{
                title: data.club.name,
                // Overridden only for the two cross-stack jumps; an ordinary push keeps the
                // stack's own control, which pops correctly.
                ...(jumped
                  ? {
                      headerLeft: () => (
                        <BackAlwaysTo href={backHref} label={backLabel} variant="icon" />
                      ),
                    }
                  : {}),
              }}
            />

            {/* The club's name again, at display weight. The header states where you are; this
                states what you are looking at, which is what makes the hub feel like a front
                door rather than a menu. */}
            <Text style={styles.identity}>{data.club.name.toUpperCase()}</Text>

            {/*
              ONE continuous panel, not a stack of separately bordered cards.

              Every row is flat with a divider between, and every icon is a filled circle. That
              is what gives the hub a group-list feel instead of the card-per-item look the rest
              of the app uses - v1's deliberate exception, and the reason the three destinations
              read as one place rather than three unrelated links.
            */}
            <View style={styles.panel}>
              <HubRow
                icon="auto-awesome"
                tint={color.secondary}
                label="News & Highlights"
                subtitle="Club updates & photos"
                href={`/clubs/${clubId}/news`}
              />
              <View style={styles.divider} />
              <HubRow
                icon="forum"
                tint={color.accent}
                label="Club main chat"
                subtitle="Jump into the conversation"
                href={data.club.channelId !== null ? `/chat/${data.club.channelId}` : undefined}
                badge={unread > 0 ? String(unread) : undefined}
              />
              {/*
                Present only for somebody actually in the space. The server returns a null id to
                everybody else, so this row cannot be rendered for them by mistake - and rule 4
                of PRD/10 gives an ordinary member no visibility that the space exists, which a
                greyed-out row would be.
              */}
              {data.club.eboardId !== null && (
                <>
                  <View style={styles.divider} />
                  <HubRow
                    icon="shield"
                    tint={color.tertiary}
                    label="Eboard & Council"
                    subtitle="Private space for admins"
                    href={`/eboard/${data.club.eboardId}`}
                  />
                </>
              )}

              <View style={styles.divider} />

              <View style={styles.racesHead}>
                <Text style={styles.sectionTitle}>Races and meets</Text>
                {/*
                  A sheet, not a page. v1 has no races list screen at all - "See all" is usually
                  "find the one I am looking for", and a search over the club's races answers that
                  without a destination whose only other job would be to be a back target.
                */}
                <Pressable
                  onPress={() => {
                    setRaceSearch('');
                    setRacesOpen(true);
                  }}
                  accessibilityRole="button"
                  accessibilityLabel="See all races"
                >
                  <Text style={styles.seeAll}>See all</Text>
                </Pressable>
              </View>

              {previewed.length === 0 ? (
                <Text style={styles.emptyRaces}>No upcoming races yet.</Text>
              ) : (
                previewed.map((race, index) => (
                  <View key={race.id}>
                    {index > 0 && <View style={styles.divider} />}
                    <Link href={`/races/${race.id}`} asChild accessibilityRole="link">
                      <Pressable
                        style={styles.raceRow}
                        accessibilityLabel={`${race.name}${race.hasAccess ? '' : ', no access'}`}
                      >
                        <RaceFace race={race} />
                        <Text style={styles.raceName} numberOfLines={1}>
                          {race.name}
                        </Text>
                        {race.pinned && (
                          <MaterialIcons name="push-pin" size={16} color={color.accent} />
                        )}
                        {!race.hasAccess && (
                          <MaterialIcons name="lock" size={16} color={color.textSecondary} />
                        )}
                      </Pressable>
                    </Link>
                  </View>
                ))
              )}
              {total > RACE_PREVIEW && (
                <Text style={styles.emptyRaces}>{`${total} in total`}</Text>
              )}
            </View>

            {racesOpen && (
              <RacesSheet
                races={races.data?.races ?? []}
                query={raceSearch}
                onQuery={setRaceSearch}
                onDismiss={() => setRacesOpen(false)}
                onPick={(raceId) => {
                  setRacesOpen(false);
                  router.push(`/races/${raceId}`);
                }}
              />
            )}

            {/* Admin only: the one create action the hub carries. */}
            {data.club.viewer.isAdmin && (
              <Link href={`/clubs/${clubId}/races/create`} asChild accessibilityRole="link">
                <Pressable style={styles.addGroup} accessibilityLabel="Add a race or meet">
                  <MaterialIcons name="add" size={20} color={color.onAccent} />
                  <Text style={styles.addGroupLabel}>Add Group</Text>
                </Pressable>
              </Link>
            )}
          </ScrollView>
        );
      }}
    </DataScreen>
  );
}

/**
 * Every race in the club, searchable.
 *
 * The overflow behind "See all". A search rather than a page, because the question it answers is
 * "which one was it" - and a page would additionally have to be somewhere a race's back control
 * returned to, which is the intermediate screen this replaces.
 */
function RacesSheet({
  races,
  query,
  onQuery,
  onDismiss,
  onPick,
}: {
  races: ReadonlyArray<{
    id: string;
    name: string;
    raceDate: string;
    image: string | null;
    hasAccess: boolean;
  }>;
  query: string;
  onQuery: (next: string) => void;
  onDismiss: () => void;
  onPick: (raceId: string) => void;
}) {
  const needle = query.trim().toLowerCase();
  const shown = needle.length === 0 ? races : races.filter((r) => r.name.toLowerCase().includes(needle));

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
          <Text style={styles.sheetTitle}>Races & Meets</Text>
          <Pressable
            onPress={onDismiss}
            hitSlop={space.sm}
            accessibilityRole="button"
            accessibilityLabel="Close"
          >
            <MaterialIcons name="close" size={22} color={color.textPrimary} />
          </Pressable>
        </View>

        <SearchField value={query} onChangeText={onQuery} placeholder="Search races" />

        <ScrollView style={styles.sheetList}>
          {shown.length === 0 ? (
            <Text style={styles.emptyRaces}>No races match "{query}".</Text>
          ) : (
            shown.map((race) => (
              <Pressable
                key={race.id}
                style={styles.sheetRow}
                onPress={() => onPick(race.id)}
                accessibilityRole="button"
                accessibilityLabel={`${race.name}${race.hasAccess ? '' : ', no access'}`}
              >
                <RaceFace race={race} />
                <View style={styles.sheetRowText}>
                  <Text style={styles.raceName} numberOfLines={1}>
                    {race.name}
                  </Text>
                  <Text style={styles.emptyRaces}>{race.raceDate}</Text>
                </View>
                {!race.hasAccess && (
                  <MaterialIcons name="lock" size={16} color={color.textSecondary} />
                )}
              </Pressable>
            ))
          )}
        </ScrollView>
      </View>
    </View>
  );
}

/**
 * One row of the hub's panel.
 *
 * The filled circular icon well in its own tint is what stops the three destinations reading as an
 * undifferentiated list - chat on the accent, News on the secondary, Eboard on the tertiary.
 */
/**
 * A race's face: its own picture, or its initial.
 *
 * One component for the hub preview and the "See all" sheet, which render the same row two
 * screens apart. When they each had their own copy, adding pictures to one left the other on
 * initials - which is how this pair drifts every time.
 */
function RaceFace({ race }: { race: { name: string; image: string | null } }) {
  return (
    <View style={styles.raceAvatar}>
      {race.image === null ? (
        <Text style={styles.raceInitial}>{race.name.charAt(0).toUpperCase()}</Text>
      ) : (
        <RemoteImage
          mediaId={race.image}
          variant="thumb"
          style={styles.raceAvatarImage}
          resizeMode="cover"
        />
      )}
    </View>
  );
}

function HubRow({
  icon,
  tint,
  label,
  subtitle,
  href,
  badge,
}: {
  icon: React.ComponentProps<typeof MaterialIcons>['name'];
  tint: string;
  label: string;
  subtitle: string;
  href: string | undefined;
  badge?: string | undefined;
}) {
  const body = (
    <>
      <View style={[styles.well, { backgroundColor: tint }]}>
        <MaterialIcons name={icon} size={20} color={color.onAccent} />
      </View>
      <View style={styles.rowText}>
        <Text style={styles.rowLabel}>{label.toUpperCase()}</Text>
        <Text style={styles.rowSubtitle}>{subtitle}</Text>
      </View>
      {badge !== undefined && <Text style={styles.badge}>{badge}</Text>}
      <MaterialIcons name="chevron-right" size={22} color={color.textSecondary} />
    </>
  );

  if (href === undefined) return <View style={styles.hubRow}>{body}</View>;

  return (
    <Link href={href} asChild accessibilityRole="link">
      <Pressable style={styles.hubRow} accessibilityLabel={label}>
        {body}
      </Pressable>
    </Link>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: color.appBackground },
  content: { padding: space.md, paddingBottom: space.xl },

  identity: {
    ...type.display,
    fontSize: 24,
    lineHeight: 30,
    letterSpacing: 0.5,
    color: color.textPrimary,
    textAlign: 'center',
    marginBottom: space.md,
  },

  panel: {
    backgroundColor: color.card,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: color.hairline,
    paddingHorizontal: space.md,
    paddingBottom: space.sm,
  },
  divider: { height: 1, backgroundColor: color.hairline },

  hubRow: { flexDirection: 'row', alignItems: 'center', gap: space.md, paddingVertical: space.md },
  well: {
    width: 44,
    height: 44,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
  },
  rowText: { flex: 1 },
  rowLabel: { ...type.title, fontSize: 17, lineHeight: 22, color: color.textPrimary },
  rowSubtitle: { ...type.bodySmall, color: color.textSecondary, marginTop: 2 },
  badge: {
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

  racesHead: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: space.md,
  },
  sectionTitle: { ...type.title, fontSize: 15, lineHeight: 20, color: color.textPrimary },
  seeAll: { ...type.label, color: color.accent, textTransform: 'uppercase' },
  emptyRaces: { ...type.bodySmall, color: color.textSecondary, paddingBottom: space.md },

  raceRow: { flexDirection: 'row', alignItems: 'center', gap: space.md, paddingVertical: space.md },
  raceAvatar: {
    width: 44,
    height: 44,
    borderRadius: radius.pill,
    backgroundColor: color.cardSunken,
    alignItems: 'center',
    justifyContent: 'center',
  },
  raceInitial: { ...type.headline, fontSize: 17, color: color.accent },
  // Fills the well the initial would sit in, so a race with a picture and one without line up.
  raceAvatarImage: { width: 44, height: 44, borderRadius: radius.pill },
  raceName: { ...type.body, color: color.textPrimary, flex: 1 },

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
    alignSelf: 'center',
    width: '100%',
    maxWidth: 420,
  },
  sheetHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  sheetTitle: { ...type.title, fontSize: 18, lineHeight: 24, color: color.textPrimary },
  sheetList: { marginTop: space.xs },
  sheetRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingVertical: space.sm,
    borderBottomWidth: 1,
    borderBottomColor: color.cardSunken,
  },
  sheetRowText: { flex: 1 },

  addGroup: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.sm,
    backgroundColor: color.accent,
    borderRadius: radius.pill,
    paddingVertical: space.sm + 6,
    marginTop: space.md,
  },
  addGroupLabel: { ...type.title, fontSize: 17, lineHeight: 22, color: color.onAccent },
});
