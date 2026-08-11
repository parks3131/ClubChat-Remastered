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
import { Link, Stack, useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useRef, useState } from 'react';
import { useDeclareClub } from '../../../../../src/current-space.tsx';
import { BackAlwaysTo } from '../../../../../src/nav.tsx';
import { unreadCount } from '@clubchat/shared';
import { channelApi, clubApi, dmApi, raceApi } from '../../../../../src/api.ts';
import type { RaceListItem } from '../../../../../src/api-types.ts';
import { useSession } from '../../../../../src/chat-provider.tsx';
import { longPressFeedback } from '../../../../../src/haptics.ts';
import { color, radius, space, type } from '../../../../../src/theme.ts';
import {
  Avatar,
  ConfirmDialog,
  ContextMenu,
  DataScreen,
  SearchField,
  measureRow,
  type PressAnchor,
} from '../../../../../src/ui.tsx';
import { useLoad } from '../../../../../src/use-load.ts';

/** How many races the hub previews before "See all". */
const RACE_PREVIEW = 5;

/**
 * Where tapping a race goes.
 *
 * A race the member is ON opens its conversation directly; one they are not on opens the preview,
 * which is where the request-to-join lives. `channelId` is null precisely when there is no roster
 * row, so this cannot open a chat somebody may not read.
 *
 * One function because two lists navigate here - the hub preview and the "See all" sheet - and
 * they had already been written out separately once.
 */
const raceHref = (race: { id: string; channelId: string | null }): string =>
  race.channelId !== null ? `/chat/${race.channelId}` : `/races/${race.id}`;

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
  const { channels, revision, userId, client } = useSession();
  const router = useRouter();
  const [racesOpen, setRacesOpen] = useState(false);
  const [raceSearch, setRaceSearch] = useState('');
  /**
   * The race whose long-press menu is open, with the rectangle it occupies so it can be lifted.
   *
   * `from` decides which row to lift. The same race is drawn one way in the hub list and another
   * in the "See all" sheet, and lifting the wrong one would float a row that looks nothing like
   * the one under the finger.
   */
  const [menuFor, setMenuFor] = useState<{
    race: RaceListItem;
    anchor: PressAnchor;
    from: 'list' | 'sheet';
  } | null>(null);
  const [confirmClear, setConfirmClear] = useState<RaceListItem | null>(null);
  const [confirmLeave, setConfirmLeave] = useState<RaceListItem | null>(null);

  const club = useLoad(() => clubApi.detail(clubId), [clubId, revision]);
  const races = useLoad(() => raceApi.list(clubId), [clubId, revision]);
  // Inside this club for as long as this screen is mounted, and carrying its name so every
  // header below can show the club's identity rather than the screen's.
  useDeclareClub(clubId, club.data?.club.name, club.data?.club.image);

  /*
   * Per-channel unread, from a LIVE read rather than from the session's copy.
   *
   * The session's `channels` is filled once at sign-in and never replaced, so badging from it
   * showed the counts as they stood when the app started - which is how this screen came to
   * disagree with the chat list and how "it says nine and I cannot find them" happened.
   */
  const states = useLoad(() => channelApi.states(), [revision]);
  useFocusEffect(
    useCallback(() => {
      // Quiet, for the same reason the chat list is: returning to a screen is not a load.
      states.refresh();
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []),
  );

  const unreadFor = (channelId: string | null): number => {
    if (channelId === null) return 0;
    const channel = states.data?.channels.find((entry) => entry.id === channelId);
    return channel ? unreadCount(channel) : 0;
  };

  /** Unread in the one channel of a given scope belonging to this club. */
  const unreadForScope = (scope: 'eboard' | 'race', scopeId: string): number => {
    const channel = states.data?.channels.find(
      (entry) => entry.scope === scope && entry.scopeId === scopeId,
    );
    return channel ? unreadCount(channel) : 0;
  };

  /*
   * Pin or unpin a race, from the long press on its row.
   *
   * **`raceApi.setPin` and not `channelApi.pin`, and the distinction is not cosmetic.** A race
   * pin is a row in `race_pins` keyed by the RACE, which is what this screen's pin icon reads
   * and what the schema allows any club member to set "whether or not they can see the race" -
   * so a locked race is pinnable, and a channel pin could not be, because a race you are not on
   * has no `channelId` at all. The conversation pin is a different personal fact about a
   * different object, and the Chats list owns that one.
   *
   * `refresh` rather than `reload`: a quiet swap, so toggling a pin does not blank the section
   * behind a spinner for something the row can already show.
   */
  const act = async (run: () => Promise<unknown>) => {
    setMenuFor(null);
    try {
      await run();
    } finally {
      // Both loaders, because these actions cross them: leaving a race changes its row AND the
      // unread totals the badges come from. Refresh rather than reload, so a menu action does
      // not blank the section behind a spinner.
      races.refresh();
      states.refresh();
    }
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

            {/*
              The club's name used to be repeated here at display weight, on the argument that the
              header states where you are and this states what you are looking at. Removed
              2026-08-11: on a real screen those are the same sentence twice, one directly above
              the other, and the second one costs a row of the list. The header already carries
              the club's picture beside its name, which is the identity this was reaching for.
            */}
            {/*
              ONE continuous panel, not a stack of separately bordered cards.

              Every row is flat with a divider between, and every icon sits in a filled well. That
              is what gives the hub a group-list feel instead of the card-per-item look the rest
              of the app uses - v1's deliberate exception, and the reason the three destinations
              read as one place rather than three unrelated links.

              The wells were circles until 2026-08-11. What carries the group-list feel is the
              flat row, the divider and the filled tint - not the roundness, which was only ever
              incidental to it and was putting these three spaces in the shape reserved for
              people. See `DESIGN/02-avatar` rule 2.
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
                    /*
                      Straight to the conversation, exactly as CLUB MAIN CHAT above does.

                      > **This is why club chat felt right and the other two did not.** A member
                      > entering the space is taken to chat anyway (PRD/10 rule 15); routing that
                      > through the landing screen made one tap cost a push plus a replace, and
                      > two transitions for one act cannot be tuned into feeling like one. The
                      > landing still exists for the paths that genuinely need a decision - a
                      > direct URL, a notification, somebody who is not a member.

                      The row only renders for a member at all, so the channel is there.
                    */
                    href={
                      data.club.eboardChannelId !== null
                        ? `/chat/${data.club.eboardChannelId}`
                        : `/eboard/${data.club.eboardId}`
                    }
                    /*
                      The row that had no badge, which is what made unread in the board's chat
                      invisible everywhere: the club row totalled it and nothing here said where
                      it was. A total that does not resolve to a place is worse than no total.
                    */
                    badge={
                      unreadForScope('eboard', data.club.eboardId) > 0
                        ? String(unreadForScope('eboard', data.club.eboardId))
                        : undefined
                    }
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
                    <RaceRow
                      race={race}
                      unread={unreadForScope('race', race.id)}
                      onPress={() => router.push(raceHref(race))}
                      /*
                        Long press for the menu, the same gesture the Chats list uses. No
                        visible control, because a toggle on every row is five controls in a
                        five-row list for something most people set once - and the pin icon at
                        the end of the row is the state it sets.

                        Deliberately NOT gated on `hasAccess`: any member can pin any race they
                        can see, which is the whole club's. Somebody waiting on a roster request
                        is exactly who wants it at the top of their hub.
                      */
                      onLongPress={(anchor) => {
                        longPressFeedback();
                        setMenuFor({ race, anchor, from: 'list' });
                      }}
                    />
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
                  // Through `raceHref`, the same function the preview rows use. Picking from the
                  // sheet must not take a different route to the same place, or the two drift.
                  const picked = races.data?.races.find((race) => race.id === raceId);
                  if (picked) router.push(raceHref(picked));
                }}
                /*
                  The sheet pins too, and the menu opens OVER it rather than closing it.
                  Somebody who searched a long list to find one race should not have to search
                  again to pin the next one - and `RaceFace`'s own comment is the warning: these
                  two lists drift every time one of them grows something the other did not.
                */
                onLongPin={(race, anchor) => {
                  longPressFeedback();
                  setMenuFor({ race, anchor, from: 'sheet' });
                }}
              />
            )}

            {/*
              The race long-press menu, the same one the Chats list uses.

              **Pin is the only item a locked race gets.** The other three all act on the race's
              CHAT, and a race with no roster row has no chat to mute, clear or leave - which is
              exactly why `channelId` is null there. Pinning is the one act that was never gated
              on access, so somebody waiting on a request can still keep the race at the top.
            */}
            {menuFor !== null && (
              <ContextMenu
                anchor={menuFor.anchor}
                preview={
                  menuFor.from === 'sheet' ? (
                    <SheetRaceRow race={menuFor.race} />
                  ) : (
                    <RaceRow race={menuFor.race} unread={unreadForScope('race', menuFor.race.id)} />
                  )
                }
                onDismiss={() => setMenuFor(null)}
                items={[
                  {
                    label: menuFor.race.pinned ? 'Unpin' : 'Pin',
                    icon: 'push-pin',
                    onPress: () => {
                      const race = menuFor.race;
                      void act(() => raceApi.setPin(race.id, !race.pinned));
                    },
                  },
                  ...(menuFor.race.channelId !== null
                    ? [
                        {
                          label: menuFor.race.muted ? 'Unmute' : 'Mute',
                          icon: menuFor.race.muted
                            ? ('notifications-active' as const)
                            : ('notifications-off' as const),
                          onPress: () => {
                            const race = menuFor.race;
                            const channelId = race.channelId;
                            if (channelId === null) return;
                            void act(() =>
                              race.muted ? dmApi.unmute(channelId) : dmApi.mute(channelId),
                            );
                          },
                        },
                        {
                          label: 'Delete chat',
                          icon: 'delete-outline' as const,
                          onPress: () => {
                            const race = menuFor.race;
                            setMenuFor(null);
                            setConfirmClear(race);
                          },
                        },
                        {
                          label: 'Leave group',
                          icon: 'logout' as const,
                          destructive: true,
                          onPress: () => {
                            const race = menuFor.race;
                            setMenuFor(null);
                            setConfirmLeave(race);
                          },
                        },
                      ]
                    : []),
                ]}
              />
            )}

            {confirmClear !== null && (
              <ConfirmDialog
                title="Delete this chat?"
                body={`This clears ${confirmClear.name} for you only. Everybody else on the roster keeps every message, and nobody is told.`}
                confirmLabel="Delete chat"
                dismissLabel="Keep it"
                onCancel={() => setConfirmClear(null)}
                onConfirm={() => {
                  const race = confirmClear;
                  const channelId = race.channelId;
                  setConfirmClear(null);
                  if (channelId === null) return;
                  void act(async () => {
                    await channelApi.clear(channelId);
                    // The device holds exactly the messages the clear was meant to hide, and
                    // renders from that cache before any network call resolves.
                    await client?.forgetChannel(channelId);
                  });
                }}
              />
            )}

            {/*
              Leaving a race takes the car group with it - `removeRaceMember` shares
              `departCarGroup` with the explicit car-group commands rather than reimplementing
              it - so the dialog says so. Somebody who has been assigned a car is the person most
              likely to be surprised, and the Incharge rule bites hardest there.
            */}
            {confirmLeave !== null && (
              <ConfirmDialog
                title={`Leave ${confirmLeave.name}?`}
                body="You will lose its chat and your car group place. Your club membership is not affected, and you can ask to join again."
                confirmLabel="Leave group"
                dismissLabel="Stay"
                onCancel={() => setConfirmLeave(null)}
                onConfirm={() => {
                  const race = confirmLeave;
                  const channelId = race.channelId;
                  setConfirmLeave(null);
                  if (userId === null) return;
                  void act(async () => {
                    // Removing yourself IS leaving: `removeRaceMember` reads the self case and
                    // emits `actorId: null`, which is what makes race chat say "left the race"
                    // rather than "was removed by".
                    await raceApi.removeMember(race.id, userId);
                    if (channelId !== null) await client?.forgetChannel(channelId);
                  });
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
  onLongPin,
}: {
  races: ReadonlyArray<RaceListItem>;
  query: string;
  onQuery: (next: string) => void;
  onDismiss: () => void;
  onPick: (raceId: string) => void;
  /** Long press on a row, to open the menu over this sheet at the row. */
  onLongPin: (race: RaceListItem, anchor: PressAnchor) => void;
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
              <SheetRaceRow
                key={race.id}
                race={race}
                onPress={() => onPick(race.id)}
                onLongPress={(anchor) => onLongPin(race, anchor)}
              />
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
 * One race inside the "See all" sheet.
 *
 * A second row rather than a reuse of `RaceRow`: the sheet shows the date under the name and the
 * hub list does not, and the two have different paddings. Sharing one component would mean a
 * prop toggling half its content, which is the shape that eventually renders the wrong one on the
 * wrong screen. `RaceFace` is the part that IS shared, and its own comment says why.
 */
function SheetRaceRow({
  race,
  onPress,
  onLongPress,
}: {
  race: RaceListItem;
  onPress?: () => void;
  onLongPress?: (anchor: PressAnchor) => void;
}) {
  const self = useRef<View>(null);

  return (
    <Pressable
      ref={self}
      style={styles.sheetRow}
      onPress={onPress}
      onLongPress={
        onLongPress === undefined
          ? undefined
          : (event) =>
              measureRow(
                self.current,
                { x: event.nativeEvent.pageX, y: event.nativeEvent.pageY },
                onLongPress,
              )
      }
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
      {/* The state the long press sets, shown here as well as in the preview list - otherwise
          pinning from this sheet looks like it did nothing. */}
      {race.pinned && <MaterialIcons name="push-pin" size={16} color={color.accent} />}
      {!race.hasAccess && <MaterialIcons name="lock" size={16} color={color.textSecondary} />}
    </Pressable>
  );
}

/**
 * One race in the club hub's list.
 *
 * Its own component so the long-press menu can draw it a second time, lifted, without describing
 * the row twice - the copy that drifts is always the one written out by hand. It measures itself
 * on long press, because the menu hangs off the row's rectangle rather than off the touch point.
 *
 * **Navigates by `onPress` and NOT by being wrapped in `<Link asChild>`.** Extracting this row
 * out of a Link is what broke tapping a race on 2026-08-06: `asChild` clones its child and
 * injects `onPress`, a plain function component silently drops every prop it does not
 * destructure, and the result was a row that still looked and long-pressed correctly and simply
 * did nothing when tapped. Nothing failed loudly, because dropping a prop is not an error. The
 * Chats list had always navigated with `router.push` for its own rows; this now matches it.
 *
 * `onPress` and `onLongPress` are both optional and both omitted by the lifted copy, which is a
 * picture rather than a control: pressing it again would open a second menu over the first.
 */
function RaceRow({
  race,
  unread,
  onPress,
  onLongPress,
}: {
  race: RaceListItem;
  unread: number;
  onPress?: () => void;
  onLongPress?: (anchor: PressAnchor) => void;
}) {
  const self = useRef<View>(null);

  return (
    <Pressable
      ref={self}
      style={styles.raceRow}
      onPress={onPress}
      accessibilityRole="button"
      onLongPress={
        onLongPress === undefined
          ? undefined
          : (event) =>
              measureRow(
                self.current,
                { x: event.nativeEvent.pageX, y: event.nativeEvent.pageY },
                onLongPress,
              )
      }
      accessibilityLabel={`${race.name}${race.hasAccess ? '' : ', no access'}`}
    >
      <RaceFace race={race} />
      <Text style={styles.raceName} numberOfLines={1}>
        {race.name}
      </Text>
      {/*
        A race's own unread.

        The club row above totals every channel of the club this member can reach, races included
        - so without this a race's share of that number is real and unfindable, which is exactly
        the complaint the Eboard badge fixed one row up. `unreadForScope` was written for that and
        never carried across, which is how it happened.

        Zero for a race with no roster row, because the channel is not in the reachable set at
        all: no access, no count, nothing to explain.
      */}
      {unread > 0 && <Text style={styles.raceUnread}>{unread > 99 ? '99+' : unread}</Text>}
      {race.pinned && <MaterialIcons name="push-pin" size={16} color={color.accent} />}
      {!race.hasAccess && <MaterialIcons name="lock" size={16} color={color.textSecondary} />}
    </Pressable>
  );
}

/**
 * A race's face: its own picture, or its initial.
 *
 * One component for the hub preview and the "See all" sheet, which render the same row two
 * screens apart. When they each had their own copy, adding pictures to one left the other on
 * initials - which is how this pair drifts every time.
 */
function RaceFace({ race }: { race: { id: string; name: string; image: string | null } }) {
  /*
   * `Avatar`, not a third hand-written well. This drew a 44px `radius.pill` circle, so a race on
   * the hub was round while the same race's chat header and profile were both rounded squares -
   * and a race is a thing, one level down from a club but the same kind of object.
   *
   * Tinted from the id rather than the name, so renaming a race does not recolour it.
   */
  return <Avatar name={race.name} image={race.image} size={44} kind="group" tintId={race.id} />;
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
  /*
   * The three spaces' wells, and they are SQUARE for the same reason every other space face is.
   *
   * News & Highlights, the main chat and Eboard & Council are each a group, so the roundness rule
   * reaches them even though these draw a destination icon rather than a picture: what a viewer
   * reads is "the club's spaces", and one of them being a different shape from the races directly
   * beneath it is the confusion the rule exists to remove. See `DESIGN/02-avatar` rule 2.
   *
   * The radius matches what `Avatar` computes at this size, so the wells and the race faces below
   * them agree rather than merely both being "squarish".
   */
  well: {
    width: 44,
    height: 44,
    borderRadius: 11,
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
  raceUnread: {
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
