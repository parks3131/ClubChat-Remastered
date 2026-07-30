/**
 * The notification badge count.
 *
 * > **Computed by the server, never stored, and re-read rather than accumulated.** `PRD/16` says a
 * > stored count drifts and a computed one cannot - that applies to the client too: incrementing a
 * > local number on every `notif.new` frame would drift the moment one frame is missed, and missing
 * > frames is the normal state of a socket.
 *
 * So the badge is a read, refreshed when the session's revision changes - which the provider bumps
 * on every socket event - and on an interval slow enough to cost nothing while catching the case
 * where the socket is down entirely. Realtime is an enhancement, not a requirement.
 */

import { useEffect, useState } from 'react';
import { usePathname } from 'expo-router';
import { inboxApi } from './api.ts';
import { useSession } from './chat-provider.tsx';

/** How often to re-read when nothing has happened. Slow: this is a fallback, not the mechanism. */
const IDLE_REFRESH_MS = 60_000;

export function useBadge(): number {
  const { authState, revision } = useSession();
  /*
   * Re-read on every navigation, as well as on socket events and the idle timer.
   *
   * > **Because the things that change this number are mostly NOT socket events.** Approving a
   * > join request, opening a roster, reading the inbox - all of them are HTTP calls that clear
   * > notifications server-side and bump no revision, so the badge sat on its old value for up to
   * > a minute afterwards. Reported as "I accepted the request and it still shows 1", which was
   * > true on screen and false in the database.
   *
   * Keying on the path rather than nudging from each screen is deliberate: a nudge has to be
   * remembered at every call site that changes notification state, and the one that forgets is
   * indistinguishable from this bug. Navigation is the one signal every such action shares.
   */
  const pathname = usePathname();
  const [count, setCount] = useState(0);

  useEffect(() => {
    if (authState !== 'signed-in') {
      setCount(0);
      return;
    }

    let alive = true;
    const read = async () => {
      try {
        const result = await inboxApi.badge();
        if (alive) setCount(result.count);
      } catch {
        // A failed badge read is not worth surfacing: the number is an enhancement, and the
        // inbox itself has a real error state. Leaving the last known value is less wrong than
        // flashing a zero that means "we could not ask".
      }
    };

    void read();
    const timer = setInterval(() => void read(), IDLE_REFRESH_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [authState, revision, pathname]);

  return count;
}
