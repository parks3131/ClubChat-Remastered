/**
 * The notification badge count.
 *
 * > **Computed by the server, never stored, and re-read rather than accumulated.** `PRD/16` says a
 * > stored count drifts and a computed one cannot - that applies to the client too: incrementing a
 * > local number on every `notif.new` frame would drift the moment one frame is missed, and missing
 * > frames is the normal state of a socket.
 *
 * So the badge is a read, refreshed when the session's revision changes - which the provider bumps
 * on every socket event - on navigation, and on an interval slow enough to cost nothing while
 * catching the case where the socket is down entirely. Realtime is an enhancement, not a
 * requirement.
 *
 * ## Why the timer lives here rather than in the hook
 *
 * > **It used to be a `setInterval` inside the hook's effect, and there were two of them.** The
 * > trace showed `GET /notifications/badge` arriving in pairs 20 to 30ms apart, on a quiet app,
 * > repeating at exactly 60.000s forever - which is two timers, not one timer firing twice. The
 * > hook has a single call site, `BadgedIcon` in the tab layout, so something was rendering that
 * > icon twice and each copy brought its own clock.
 *
 * Finding which copy was the wrong fix to reach for. **This number is one fact about the whole
 * app, not a property of an icon**, and a component that a navigator may render more than once is
 * the wrong owner for it. So the count, the timer and the request live at module scope with the
 * hook as a subscription: however many `BadgedIcon`s mount, there is one timer, one request in
 * flight at a time, and one answer they all draw.
 *
 * That also makes the duplicate harmless rather than merely absent, which matters because the
 * duplicate itself has not been explained - see TODO. A structure where the second copy costs
 * nothing is worth more than a fix that depends on there never being one.
 */

import { useEffect, useState } from 'react';
import { usePathname } from 'expo-router';
import { inboxApi } from './api.ts';
import { useSession } from './chat-provider.tsx';

/** How often to re-read when nothing has happened. Slow: this is a fallback, not the mechanism. */
const IDLE_REFRESH_MS = 60_000;

/** The one live value, the one timer, and everybody drawing it. */
let current = 0;
let timer: ReturnType<typeof setInterval> | null = null;
let inFlight: Promise<void> | null = null;
const watchers = new Set<(count: number) => void>();

function publish(count: number): void {
  current = count;
  for (const watcher of watchers) watcher(count);
}

/**
 * Read the count, at most one request at a time.
 *
 * The in-flight promise is shared rather than queued, deliberately: two callers asking "how many"
 * inside the same moment want the same answer, and a second request would only be a slower copy of
 * the one already on the wire. Sending one message bumps `revision` several times in a few hundred
 * milliseconds, so this is the ordinary case rather than a race.
 */
function refresh(): Promise<void> {
  if (inFlight) return inFlight;

  inFlight = (async () => {
    try {
      const result = await inboxApi.badge();
      publish(result.count);
    } catch {
      // A failed badge read is not worth surfacing: the number is an enhancement, and the
      // inbox itself has a real error state. Leaving the last known value is less wrong than
      // flashing a zero that means "we could not ask".
    } finally {
      inFlight = null;
    }
  })();

  return inFlight;
}

/** Start drawing the count. The timer exists only while somebody is watching. */
function watch(onCount: (count: number) => void): () => void {
  watchers.add(onCount);
  if (timer === null) timer = setInterval(() => void refresh(), IDLE_REFRESH_MS);

  return () => {
    watchers.delete(onCount);
    if (watchers.size === 0 && timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  };
}

/** Signed out: stop asking, and say zero rather than leaving the last member's number on screen. */
function reset(): void {
  if (timer !== null) {
    clearInterval(timer);
    timer = null;
  }
  publish(0);
}

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
  const [count, setCount] = useState(current);

  /*
   * The subscription, keyed on `authState` ALONE.
   *
   * Not on `revision` or `pathname`, which is the second half of the old defect: the interval was
   * torn down and rebuilt on every navigation and every socket event, so the fallback that exists
   * to fire when nothing is happening was continually reset by things happening. It now keeps its
   * own steady minute.
   */
  useEffect(() => {
    if (authState !== 'signed-in') {
      reset();
      setCount(0);
      return;
    }

    const stop = watch(setCount);
    void refresh();
    return stop;
  }, [authState]);

  // The triggers. Cheap now: each one asks, and asking twice inside one moment is one request.
  useEffect(() => {
    if (authState !== 'signed-in') return;
    void refresh();
  }, [authState, revision, pathname]);

  return count;
}
