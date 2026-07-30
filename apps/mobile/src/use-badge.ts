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
import { inboxApi } from './api.ts';
import { useSession } from './chat-provider.tsx';

/** How often to re-read when nothing has happened. Slow: this is a fallback, not the mechanism. */
const IDLE_REFRESH_MS = 60_000;

export function useBadge(): number {
  const { authState, revision } = useSession();
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
  }, [authState, revision]);

  return count;
}
