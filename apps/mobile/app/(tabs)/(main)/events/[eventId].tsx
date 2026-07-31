/**
 * One calendar event.
 *
 * A thin wrapper, like the poll route beside it: an event id carries its club, so there is nothing
 * here to parametrise. The implementation is in `src/screens/events.tsx`, shared with the card
 * that stands in for this screen in chat.
 */

import { useLocalSearchParams } from 'expo-router';
import { EventView } from '../../../../src/screens/events.tsx';

export default function EventScreen() {
  const { eventId } = useLocalSearchParams<{ eventId: string }>();
  return <EventView eventId={eventId} />;
}
