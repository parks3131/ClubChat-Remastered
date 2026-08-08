/**
 * One calendar event: its own screen, and the card that stands in for it in chat.
 *
 * Both live here for the same reason polls do - they are two renderings of one read, and keeping
 * them side by side is what stops the card and the screen drifting into disagreeing about what an
 * event is.
 *
 * > **An event used to have no screen at all.** Creating one already notified every member of the
 * > club and already posted a card into club chat, and both of those led nowhere: the notification
 * > tap was routed to the club as a consolation and the card was a sentence. This module is the
 * > destination those two links were always implying.
 */

import type { ReactNode } from 'react';
import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { contentApi } from '../api.ts';
import type { EventDetail } from '../api-types.ts';
import { formatInstant, formatTimeOfDay } from '../dates.ts';
import { color, radius, space, type } from '../theme.ts';
import { Action, Body, Card, ConfirmDialog, DataScreen, DetailLine } from '../ui.tsx';
import { useLoad } from '../use-load.ts';

/**
 * When it happens, as one line.
 *
 * An end is optional and usually absent, so the shape has to read correctly both ways. When the
 * event ends on the same day it started, only the closing TIME is added - "Tue, Mar 2, 5:00 PM -
 * 7:00 PM" - because repeating the date inside a single afternoon is noise. A multi-day event
 * spells both ends out in full, where the second date is the entire point.
 */
export function eventWhen(startsAt: string, endsAt: string | null): string {
  const start = formatInstant(startsAt);
  if (endsAt === null) return start;

  const sameDay = new Date(startsAt).toDateString() === new Date(endsAt).toDateString();
  return sameDay ? `${start} - ${formatTimeOfDay(endsAt)}` : `${start} - ${formatInstant(endsAt)}`;
}

/**
 * The full event.
 *
 * Readable by every member of the club; **deletable by any club admin, not only its creator.**
 * That is the opposite of a poll and is deliberate - a poll is a question somebody asked, and an
 * event is club business on a shared calendar. A cancelled practice that only the one absent
 * admin could remove is the failure the rule avoids. The screen says "Added by <name>" either
 * way, so the difference is legible rather than arbitrary.
 */
export function EventView({ eventId }: { eventId: string }) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const load = useLoad(() => contentApi.event(eventId), [eventId]);

  return (
    <DataScreen load={load} errorMessage="Couldn't load this event.">
      {(data) => {
        const event = data.event;

        return (
          <Body>
            <View style={styles.headline}>
              <MaterialIcons name="event" size={22} color={color.accent} />
              <Text style={styles.title}>{event.title}</Text>
            </View>
            <Text style={styles.when}>{eventWhen(event.startsAt, event.endsAt)}</Text>

            <Card>
              <DetailLine label="Location" value={event.location} />
              {/* Stated even when empty, because "is there more to this?" is the question the
                  screen exists to answer, and a missing row leaves it open. */}
              <DetailLine
                label="Details"
                value={event.description}
                placeholder="No description was added."
              />
              <DetailLine label="Added by" value={event.creatorName} />
            </Card>

            <Action
              label="Open the club"
              variant="secondary"
              onPress={() => router.push(`/clubs/${event.clubId}`)}
            />

            {event.canManage && (
              <>
                {failed !== null && <Text style={styles.error}>{failed}</Text>}
                <Action
                  label="Delete event"
                  variant="danger"
                  onPress={() => setConfirming(true)}
                />
              </>
            )}

            {confirming && (
              <ConfirmDialog
                title="Delete this event?"
                body={`"${event.title}" leaves the calendar for everyone in the club and its card disappears from chat. This cannot be undone.`}
                confirmLabel="Delete event"
                onCancel={() => setConfirming(false)}
                onConfirm={() => {
                  setConfirming(false);
                  setFailed(null);
                  void contentApi.deleteEvent(eventId).then(
                    () => router.back(),
                    () => setFailed('Could not delete the event. Try again.'),
                  );
                }}
              />
            )}
          </Body>
        );
      }}
    </DataScreen>
  );
}

/**
 * The event card that sits in chat, for a `card` message carrying a `linkedEventId`.
 *
 * v1's card, and the shape is its: a calendar glyph beside the title, the date, the location, and
 * **View Event** out to the screen above.
 *
 * Fetched by id rather than read off the message, because the message carries only a sentence -
 * the date and the location the card is supposed to show were never on the wire. The read being
 * authorized is the other half: a viewer who may not see the club gets nothing back and the card
 * renders as its sentence alone, rather than leaking a club's schedule through a chat log.
 *
 * Unlike the poll card, this one **is** a single press target. Nothing inside it is a control, so
 * there is no button to nest inside a button - it navigates, and `accessibilityRole="button"` is
 * legal here precisely because the bubble around it declares `none`.
 */
export function ChatEventCard({
  eventId,
  fallback = null,
}: {
  eventId: string;
  /** The message's own sentence, drawn when the event cannot be. See `ChatPollCard`. */
  fallback?: ReactNode;
}) {
  const router = useRouter();
  const load = useLoad(() => contentApi.event(eventId), [eventId]);

  // No spinner and no error text: a pending or failed read falls back to the message's own
  // sentence, because the chat screen has already suppressed it for any card-carrying message.
  if (load.data === null) return <>{fallback}</>;
  const event: EventDetail = load.data.event;

  return (
    <Pressable
      style={styles.card}
      onPress={() => router.push(`/events/${eventId}`)}
      accessibilityRole="button"
      accessibilityLabel={`${event.title}, ${eventWhen(event.startsAt, event.endsAt)}. View this event`}
    >
      <View style={styles.cardHead}>
        <MaterialIcons name="event" size={18} color={color.accent} />
        <Text style={styles.cardTitle} numberOfLines={2}>
          {event.title}
        </Text>
      </View>

      <View style={styles.cardLine}>
        <MaterialIcons name="schedule" size={14} color={color.textSecondary} />
        <Text style={styles.cardMeta} numberOfLines={1}>
          {eventWhen(event.startsAt, event.endsAt)}
        </Text>
      </View>

      {/* Absent rather than blank when there is no location. A row reading "Location -" tells
          the reader nothing they did not already know from its absence. */}
      {event.location !== null && event.location.trim().length > 0 && (
        <View style={styles.cardLine}>
          <MaterialIcons name="place" size={14} color={color.textSecondary} />
          <Text style={styles.cardMeta} numberOfLines={1}>
            {event.location}
          </Text>
        </View>
      )}

      <View style={styles.cardCta}>
        <Text style={styles.cardCtaLabel}>VIEW EVENT</Text>
        <MaterialIcons name="arrow-forward" size={14} color={color.onAccent} />
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  headline: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  title: { ...type.title, color: color.textPrimary, flex: 1 },
  when: { ...type.label, color: color.textSecondary, textTransform: 'none' },
  error: { ...type.bodySmall, color: color.error },

  /* The card in chat. Its own surface, because the creator's bubble behind it is accent-filled. */
  card: {
    backgroundColor: color.card,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: color.divider,
    padding: space.md,
    gap: space.sm,
  },
  cardHead: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  cardTitle: { ...type.headline, color: color.textPrimary, flex: 1 },
  cardLine: { flexDirection: 'row', alignItems: 'center', gap: space.xs },
  cardMeta: { ...type.bodySmall, color: color.textSecondary, flex: 1 },
  cardCta: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.xs,
    backgroundColor: color.accent,
    borderRadius: radius.pill,
    paddingVertical: space.sm,
    marginTop: space.xs,
  },
  cardCtaLabel: { ...type.label, fontSize: 11, color: color.onAccent },
});
