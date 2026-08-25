/**
 * One meetup.
 *
 * > **A meetup had no screen of its own until 2026-08-15, and `ADR-0036` said it was not getting
 * > one.** That was right while a meetup was three facts: a week row held all of them, and a screen
 * > would have been a second place to read the same line. What changed is what a meetup holds. A
 * > name, notes about where to stand and a way to get there do not fit a row, and the founder
 * > designed a screen for them the same afternoon. `ADR-0037` records the reversal.
 *
 * **There is no map picture, and that is a decision rather than a gap** - see `meetup-map.tsx`.
 * Directions opens the pasted link, which is the exact place somebody chose.
 *
 * Reached from the calendar's day popup, from the club's Upcoming/Past list, and from the week.
 * Every one of those is a place the reader already knows the day, so the screen leads with the
 * name rather than repeating the date at the top.
 *
 * **Deliberately no RSVP**, though the design that produced this screen had one. `PRD/00` lists
 * attendance as a non-goal beside "Weekly Meetups is a plan, not a checklist", and the founder
 * left it standing on 2026-08-15 rather than reversing it from a mockup.
 */

import { useState } from 'react';
import { MaterialIcons } from '@expo/vector-icons';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { contentApi } from '../../../../src/api.ts';
import { meetupHeadline } from '../../../../src/api-types.ts';
import { formatDaySeparator, formatDayTitle, formatWallClock } from '../../../../src/dates.ts';
import { MeetupDirections } from '../../../../src/meetup-map.tsx';
import { color, space, type } from '../../../../src/theme.ts';
import {
  Card,
  ConfirmDialog,
  ContextMenu,
  DataScreen,
  DetailLine,
  DetailPerson,
  DetailRule,
  ScreenHeading,
  type PressAnchor,
} from '../../../../src/ui.tsx';
import { goBackOr } from '../../../../src/nav.tsx';
import { useLoad, useRefreshOnReturn } from '../../../../src/use-load.ts';

export default function MeetupScreen() {
  const { meetupId } = useLocalSearchParams<{ meetupId: string }>();
  const router = useRouter();
  const [menuAnchor, setMenuAnchor] = useState<PressAnchor | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const load = useLoad(() => contentApi.meetup(meetupId), [meetupId]);

  /* Re-read on RETURN, so an edit made on the composer is here - and only on return. */
  useRefreshOnReturn(load, meetupId);

  return (
    <DataScreen load={load} errorMessage="Couldn't load this meetup.">
      {({ meetup }) => {
        /*
         * "Today" when it is today, and the weekday otherwise. Built from the date key's own
         * components - `formatDaySeparator` and `formatDayTitle` both split rather than parse,
         * because a date-only value read as an instant is UTC midnight and renders a day early
         * west of Greenwich. The clock is the club's own characters and is never converted.
         */
        const today = formatDaySeparator(meetup.date) === 'Today';
        const when = `${today ? 'TODAY' : formatDayTitle(meetup.date).toUpperCase()} @ ${formatWallClock(
          meetup.time,
        )}`;

        return (
          <ScrollView contentContainerStyle={styles.body}>
            {/*
              The same "..." the event screen grew on 2026-08-17, in the same corner.

              The week's long press stays - it is the fast path for an admin working down a week -
              and this is the discoverable one. A gesture nothing advertises is not a way to reach
              an action; it is a way for somebody who already knows to reach it faster.
            */}
            {meetup.canManage && (
              <Stack.Screen
                options={{
                  headerRight: () => (
                    <Pressable
                      onPress={(pressEvent) =>
                        setMenuAnchor({
                          x: pressEvent.nativeEvent.pageX,
                          y: pressEvent.nativeEvent.pageY,
                          width: 0,
                          height: 0,
                        })
                      }
                      accessibilityRole="button"
                      accessibilityLabel="Options for this meetup"
                      hitSlop={space.sm}
                      style={styles.headerButton}
                    >
                      <MaterialIcons name="more-vert" size={22} color={color.accent} />
                    </Pressable>
                  ),
                }}
              />
            )}

            {menuAnchor !== null && (
              <ContextMenu
                anchor={menuAnchor}
                onDismiss={() => setMenuAnchor(null)}
                items={[
                  {
                    label: 'Edit meetup',
                    icon: 'edit',
                    onPress: () => {
                      setMenuAnchor(null);
                      router.push(`/clubs/${meetup.clubId}/weekly-meetups?edit=${meetup.id}`);
                    },
                  },
                  {
                    label: 'Delete meetup',
                    icon: 'delete',
                    destructive: true,
                    onPress: () => {
                      setMenuAnchor(null);
                      setConfirming(true);
                    },
                  },
                ]}
              />
            )}

            {confirming && (
              <ConfirmDialog
                title="Delete this meetup?"
                body={`"${meetupHeadline(meetup)}" leaves the week and the club calendar for everybody. This cannot be undone.`}
                confirmLabel="Delete"
                dismissLabel="Keep"
                onCancel={() => setConfirming(false)}
                onConfirm={() => {
                  setConfirming(false);
                  setFailed(null);
                  void contentApi.deleteMeetup(meetup.id).then(
                    // Guarded: reachable by deep link and by refresh, where there is no history to
                    // pop - failure mode 14. The club is the fallback; the meetup is gone.
                    () => goBackOr(router, `/clubs/${meetup.clubId}`),
                    () => setFailed('Could not delete the meetup. Try again.'),
                  );
                }}
              />
            )}

            <ScreenHeading eyebrow="Meetup" title={meetupHeadline(meetup)} />
            <Text style={styles.when}>{when}</Text>
            {failed !== null && <Text style={styles.error}>{failed}</Text>}

            <Card>
              {/*
                "Description", here and in the composer, which now match.

                They deliberately did not until 2026-08-17: the form asked "What are we doing?" on
                the reasoning that a form reads better as a question, while the record answering it
                was labelled "Description". The founder asked for the question to go - one word for
                one field, wherever it appears. The original complaint that produced the split
                still stands and is still answered: "WHAT / Easy Run" reads as a label that lost
                its question mark, and neither surface says "What" any more.
              */}
              <DetailLine label="Description" value={meetup.description} />
              <DetailLine label="Who" value={meetup.clubName} />
              <DetailLine label="Location notes" value={meetup.locationNotes} />

              {/*
                Who made it, with a face, and who changed it when that is somebody else.

                A meetup carried no author at all until 2026-08-17 - the read never joined the
                creator - so "who put this here" was a question the screen could not answer. It
                matches the event screen exactly, which is the point: the two are the same kind of
                thing to a member and should not differ in what they are willing to say.
              */}
              <DetailRule />
              <DetailPerson
                label="Added by"
                name={meetup.creatorName}
                image={meetup.creatorImage}
              />
              <DetailPerson
                label="Edited by"
                name={meetup.editorName}
                image={meetup.editorImage}
              />
            </Card>

            {/*
              Directions, and only when a link was pasted. There is deliberately no map picture -
              see `meetup-map.tsx` and `ADR-0037` for why one was built and then taken back out.
              With no link there is no button at all, rather than a button that hands Maps a text
              search for "Bimini" and sends somebody wherever it guesses that is.
            */}
            <MeetupDirections mapUrl={meetup.mapUrl} place={meetupHeadline(meetup)} />
          </ScrollView>
        );
      }}
    </DataScreen>
  );
}

const styles = StyleSheet.create({
  body: { padding: space.md, gap: space.md, paddingBottom: space.xl },
  /*
   * The one accent line on the screen, directly under the name, because when it happens is the
   * second thing anybody wants and the design put it there.
   */
  when: {
    ...type.bodySmallStrong,
    color: color.accent,
    letterSpacing: 0.6,
    marginTop: -space.sm,
  },
  /** Padding around the header glyph, on top of its `hitSlop`. A 22pt target needs both. */
  headerButton: { padding: space.xs },
  error: { ...type.bodySmall, color: color.error },
});
