/**
 * Eboard polls.
 *
 * Any member of the space may create one - there is no further role distinction inside, which is
 * the opposite of a race and the reason `canCreate` is plain membership here.
 */

import { useLocalSearchParams } from 'expo-router';
import { eboardApi } from '../../../../../src/api.ts';
import { PollsList } from '../../../../../src/screens/polls.tsx';
import { DataScreen } from '../../../../../src/ui.tsx';
import { useLoad } from '../../../../../src/use-load.ts';

export default function EboardPollsScreen() {
  const { eboardId } = useLocalSearchParams<{ eboardId: string }>();
  const eboard = useLoad(() => eboardApi.detail(eboardId), [eboardId]);

  return (
    <DataScreen load={eboard}>
      {(data) => (
        <PollsList scope="eboards" scopeId={eboardId} canCreate={data.eboard.viewer.isMember} />
      )}
    </DataScreen>
  );
}
