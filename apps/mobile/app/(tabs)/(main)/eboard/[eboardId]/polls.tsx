/**
 * Eboard polls.
 *
 * Any member of the space may create one - there is no further role distinction inside, which is
 * the opposite of a race and the reason `canCreate` is plain membership here.
 */

import { useLocalSearchParams } from 'expo-router';
import { useDeclareEboard } from '../../../../../src/current-space.tsx';
import { eboardApi } from '../../../../../src/api.ts';
import { PollsList } from '../../../../../src/screens/polls.tsx';
import { DataScreen } from '../../../../../src/ui.tsx';
import { useLoad } from '../../../../../src/use-load.ts';

export default function EboardPollsScreen() {
  const { eboardId } = useLocalSearchParams<{ eboardId: string }>();
  const eboard = useLoad(() => eboardApi.detail(eboardId), [eboardId]);
  /*
   * Which space this screen is in, for the header and for the Clubs tab's shortcut.
   *
   * The id comes from the ROUTE, so the header knows which space it is drawing before the name
   * arrives - that is what stops it showing the previous screen's name for a frame. Everything
   * else comes from the read, because a race and an Eboard space each know their own club and the
   * route does not carry it.
   */
  useDeclareEboard(
    eboardId,
    eboard.data?.eboard.clubId,
    eboard.data?.eboard.name,
    eboard.data?.eboard.image,
  );

  return (
    <DataScreen load={eboard}>
      {(data) => (
        <PollsList scope="eboards" scopeId={eboardId} canCreate={data.eboard.viewer.isMember} />
      )}
    </DataScreen>
  );
}
