/**
 * Race polls.
 *
 * `canCreate` needs BOTH a roster row and club-admin status, which is what `isManager && hasAccess`
 * says - and the two are separate flags precisely because a manager without a roster row has one
 * and not the other. The server asks the same question; this only decides whether to draw a button.
 */

import { useLocalSearchParams } from 'expo-router';
import { useDeclareRace } from '../../../../../src/current-space.tsx';
import { raceApi } from '../../../../../src/api.ts';
import { PollsList } from '../../../../../src/screens/polls.tsx';
import { DataScreen } from '../../../../../src/ui.tsx';
import { useLoad } from '../../../../../src/use-load.ts';

export default function RacePollsScreen() {
  const { raceId } = useLocalSearchParams<{ raceId: string }>();
  const race = useLoad(() => raceApi.detail(raceId), [raceId]);
  /*
   * Which space this screen is in, for the header and for the Clubs tab's shortcut.
   *
   * The id comes from the ROUTE, so the header knows which space it is drawing before the name
   * arrives - that is what stops it showing the previous screen's name for a frame. Everything
   * else comes from the read, because a race and an Eboard space each know their own club and the
   * route does not carry it.
   */
  useDeclareRace(
    raceId,
    race.data?.race.clubId,
    race.data?.race.name,
    race.data?.race.image,
  );

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
}
