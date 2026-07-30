/**
 * The invite deep link, and the only invite path there is.
 *
 * Four states, and each one is a rule from `PRD/04`:
 *
 *  - **Signed out**: routed to sign-in first, then back here to finish. That is why the redirect
 *    carries the token rather than dropping it.
 *  - **Valid**: joins instantly, even on a request club, because a link is a private side channel
 *    and is deliberately independent of the public join policy.
 *  - **Opened twice**: a no-op, not an error. The second attempt reports the same success.
 *  - **Revoked or malformed**: a plain "no longer valid", **offering club search as the way
 *    forward** - never a hint about which clubs exist.
 */

import { useEffect, useState } from 'react';
import { StyleSheet, Text } from 'react-native';
import { Redirect, useLocalSearchParams, useRouter } from 'expo-router';
import { clubApi } from '../../../../src/api.ts';
import { useSession } from '../../../../src/chat-provider.tsx';
import { color, type } from '../../../../src/theme.ts';
import { Action, Body, Card, SectionHeader } from '../../../../src/ui.tsx';

type State = 'redeeming' | 'joined' | 'requested' | 'invalid';

export default function JoinScreen() {
  const { token } = useLocalSearchParams<{ token: string }>();
  const { authState, client } = useSession();
  const router = useRouter();
  const [state, setState] = useState<State>('redeeming');

  useEffect(() => {
    if (authState !== 'signed-in') return;
    let alive = true;
    void (async () => {
      try {
        const result = await clubApi.redeemInvite(token);
        if (!alive) return;
        setState(result.status === 'requested' ? 'requested' : 'joined');
        // Resubscribe so the new club's channel is live without a restart.
        await client?.reconnect().catch(() => undefined);
      } catch {
        if (alive) setState('invalid');
      }
    })();
    return () => {
      alive = false;
    };
  }, [authState, token, client]);

  if (authState === 'checking') return <Body />;
  // Carries the token through sign-in so the join completes afterwards rather than being lost.
  if (authState === 'signed-out') return <Redirect href={`/sign-in?next=/join/${token}`} />;

  return (
    <Body>
      {state === 'redeeming' && <Text style={styles.meta}>Joining...</Text>}

      {state === 'joined' && (
        <Card>
          <SectionHeader title="You are in" />
          <Text style={styles.meta}>The club is in your list now.</Text>
          <Action label="Go to my clubs" onPress={() => router.replace('/clubs')} />
        </Card>
      )}

      {state === 'requested' && (
        <Card>
          <SectionHeader title="Requested" />
          <Text style={styles.meta}>An admin will approve or deny it.</Text>
          <Action label="Go to my clubs" onPress={() => router.replace('/clubs')} />
        </Card>
      )}

      {state === 'invalid' && (
        <Card>
          <SectionHeader title="This invite link is no longer valid" />
          {/* Offers search as the way forward, and says nothing about which clubs exist. */}
          <Text style={styles.meta}>
            It may have been rotated by an admin. You can search for the club by name instead.
          </Text>
          <Action label="Search for a club" onPress={() => router.replace('/clubs')} />
        </Card>
      )}
    </Body>
  );
}

const styles = StyleSheet.create({
  meta: { ...type.bodySmall, color: color.textSecondary },
});
