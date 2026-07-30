/**
 * Club polls.
 *
 * `canCreate` is club-admin, which this screen learns from the club read rather than deciding: the
 * server refuses a non-admin anyway, and a client that computed the rule would be a second
 * definition of it.
 */

import { useLocalSearchParams } from 'expo-router';
import { clubApi } from '../../../../../src/api.ts';
import { PollsList } from '../../../../../src/screens/polls.tsx';
import { DataScreen } from '../../../../../src/ui.tsx';
import { useLoad } from '../../../../../src/use-load.ts';

export default function ClubPollsScreen() {
  const { clubId } = useLocalSearchParams<{ clubId: string }>();
  const club = useLoad(() => clubApi.detail(clubId), [clubId]);

  return (
    <DataScreen load={club}>
      {(data) => (
        <PollsList scope="clubs" scopeId={clubId} canCreate={data.club.viewer.isAdmin} />
      )}
    </DataScreen>
  );
}
