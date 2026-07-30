/**
 * Race polls.
 *
 * `canCreate` needs BOTH a roster row and club-admin status, which is what `isManager && hasAccess`
 * says - and the two are separate flags precisely because a manager without a roster row has one
 * and not the other. The server asks the same question; this only decides whether to draw a button.
 */

import { useLocalSearchParams } from 'expo-router';
import { useDeclareClub } from '../../../../../src/current-club.tsx';
import { raceApi } from '../../../../../src/api.ts';
import { PollsList } from '../../../../../src/screens/polls.tsx';
import { DataScreen } from '../../../../../src/ui.tsx';
import { useLoad } from '../../../../../src/use-load.ts';

export default function RacePollsScreen() {
  const { raceId } = useLocalSearchParams<{ raceId: string }>();
  const race = useLoad(() => raceApi.detail(raceId), [raceId]);

  return (
    <DataScreen load={race}>
      {(data) => (
        <PollsList
          scope="races"
          scopeId={raceId}
          canCreate={data.race.viewer.isManager && data.race.viewer.hasAccess}
        />
      )}
    </DataScreen>
  );
  // Inside this club for as long as this screen is mounted. Resolved from the read
  // rather than a param: a race and an Eboard space each know their own club.
  useDeclareClub(race.data?.race.clubId);
}
