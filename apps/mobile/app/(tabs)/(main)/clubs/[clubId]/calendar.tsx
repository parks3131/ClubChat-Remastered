/**
 * The club-scoped calendar.
 *
 * The same component as the Calendar destination, given a club id. Design-system rule 5: one
 * implementation, so a fix to the month grid or the Upcoming/Past split lands in both at once.
 * The club version does not tag rows with the club name, because every row is that club.
 */

import { useLocalSearchParams } from 'expo-router';
import { useDeclareClub } from '../../../../../src/current-space.tsx';
import { CalendarView } from '../../../calendar.tsx';

export default function ClubCalendarScreen() {
  const { clubId } = useLocalSearchParams<{ clubId: string }>();
  // Inside this club for as long as this screen is mounted, which is what the Clubs tab reads.
  useDeclareClub(clubId);
  return <CalendarView clubId={clubId} />;
}
