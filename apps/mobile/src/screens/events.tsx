/**
 * One calendar event: its own screen, and the card that stands in for it in chat.
 *
 * Both live here for the same reason polls do - they are two renderings of one read, and keeping
 * them side by side is what stops the card and the screen drifting into disagreeing about what an
 * event is. The shell both wear is `content-card.tsx`, shared with polls and meetings.
 *
 * > **An event used to have no screen at all.** Creating one already notified every member of the
 * > club and already posted a card into club chat, and both of those led nowhere: the notification
 * > tap was routed to the club as a consolation and the card was a sentence. This module is the
 * > destination those two links were always implying.
 */

import type { ReactNode } from 'react';
import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { contentApi } from '../api.ts';
import type { EventDetail } from '../api-types.ts';
import { bibParts, formatInstant, formatTimeOfDay } from '../dates.ts';
import { CardEyebrow, CardMeta, CardTitle, ContentCard, DateChip } from '../content-card.tsx';
import { MeetupDirections } from '../meetup-map.tsx';
import { color, space, type } from '../theme.ts';
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
 * The same, for a card whose date chip has already said the day.
 *
 * The clock alone, so the meta line reads "6:00 AM · Rec Center track" rather than repeating the
 * date the chip is holding two inches to its left. A multi-day event is the one case that still
 * has to name a second date, because there the second day IS the information.
 */
export function eventClock(startsAt: string, endsAt: string | null): string {
  const start = formatTimeOfDay(startsAt);
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
        /*
          `false`, always: an event's `startsAt` is an instant, so its day is whatever the reader's
          clock says. See `bibParts` - the flag is required precisely because the wrong answer here
          is a confidently wrong date rather than an error.
        */
        const bib = bibParts(event.startsAt, false);

        return (
          <Body>
            {/*
              The hero says the same thing the chat card does, in the same arrangement, because a
              member arriving from the card should recognise where they landed. It is the card
              without its border - the screen is already the surface.
            */}
            <View style={styles.hero}>
              <DateChip day={bib.day} month={bib.month} />
              <View style={styles.heroText}>
                <CardEyebrow label="EVENT" />
                <Text style={styles.title}>{event.title}</Text>
              </View>
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

            {/*
              Directions, and only when a link was pasted.

              The same component and the same rule as a meetup's: no link means no button, never a
              button that hands Maps a text search for whatever the location field happens to say.
              `point` is always null here - an event has no hand-placed pin, so the stored URL is
              the only thing that can open, which is why the column has no lat/lng beside it.
            */}
            <MeetupDirections mapUrl={event.mapUrl} point={null} place={event.location ?? ''} />

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
 * A filled date chip, the kind, the title, and one quiet line of time, place and who added it.
 *
 * Fetched by id rather than read off the message, because the message carries only a sentence -
 * the date and the location the card is supposed to show were never on the wire. The read being
 * authorized is the other half: a viewer who may not see the club gets nothing back and the card
 * renders as its sentence alone, rather than leaking a club's schedule through a chat log.
 *
 * **The whole card navigates, and there is no VIEW EVENT button.** Nothing inside it is a control,
 * so there is no button to nest inside a button - and a card that is entirely a link does not need
 * to also contain one. `PRD/07` rule 10 was rewritten to match on 2026-08-13.
 */
export function ChatEventCard({
  eventId,
  fallback = null,
  onLongPress,
}: {
  eventId: string;
  /** The message's own sentence, drawn when the event cannot be. See `ChatPollCard`. */
  fallback?: ReactNode;
  /**
   * React or report, taken by the card's OWN pressable.
   *
   * It cannot be left to the row around it: this card is a press target, so on native it becomes
   * the responder and an enclosing pressable never sees the hold. See `ContentCard`.
   */
  onLongPress?: () => void;
}) {
  const router = useRouter();
  const load = useLoad(() => contentApi.event(eventId), [eventId]);

  // No spinner and no error text: a pending or failed read falls back to the message's own
  // sentence, because the chat screen has already suppressed it for any card-carrying message.
  if (load.data === null) return <>{fallback}</>;
  const event: EventDetail = load.data.event;
  const bib = bibParts(event.startsAt, false);

  return (
    <ContentCard
      onPress={() => router.push(`/events/${eventId}`)}
      onLongPress={onLongPress}
      accessibilityLabel={`${event.title}, ${eventWhen(event.startsAt, event.endsAt)}. View this event`}
    >
      <View style={styles.cardRow}>
        <DateChip day={bib.day} month={bib.month} />
        <View style={styles.cardText}>
          <CardEyebrow label="EVENT" />
          <CardTitle>{event.title}</CardTitle>
          {/*
            The parts go in unjoined rather than pre-joined: an event with no location must not
            leave a stranded separator behind. See `CardMeta`.

            **No creator here.** Who added it is said by the avatar and name above the card. The
            event's own screen still says "Added by", because there is no author row there.
          */}
          <CardMeta parts={[eventClock(event.startsAt, event.endsAt), event.location]} />
        </View>
      </View>
    </ContentCard>
  );
}

const styles = StyleSheet.create({
  hero: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  heroText: { flex: 1, gap: space.xs },
  title: { ...type.title, color: color.textPrimary },
  when: { ...type.label, color: color.textSecondary, textTransform: 'none' },
  error: { ...type.bodySmall, color: color.error },

  /*
    Chip beside text, vertically centred on it. `flex: 1` on the text column is what keeps a long
    title wrapping inside the card instead of pushing the chip off its left edge.
  */
  cardRow: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  cardText: { flex: 1, gap: space.xs },
});
