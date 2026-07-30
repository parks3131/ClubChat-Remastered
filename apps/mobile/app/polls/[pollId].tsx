/**
 * One poll, in any scope.
 *
 * A thin wrapper: a poll id already carries its scope, so there is nothing here to parametrise and
 * nothing scope-specific to decide. The shared implementation is in `src/screens/polls.tsx`.
 */

import { useLocalSearchParams } from 'expo-router';
import { PollDetail } from '../../src/screens/polls.tsx';

export default function PollScreen() {
  const { pollId } = useLocalSearchParams<{ pollId: string }>();
  return <PollDetail pollId={pollId} />;
}
