/**
 * Push, wired to the session.
 *
 * Renders nothing. It exists because push registration and notification taps are both bound to
 * **being signed in**, and neither has a screen to live on:
 *
 *  - A token registered before sign-in would have no account to attach to. `POST /devices`
 *    registers against the caller, so it is meaningless without one.
 *  - A tap that navigates before sign-in would push a screen behind the auth guard, which
 *    bounces straight back out and loses the destination on the way.
 *
 * Placed inside `SessionProvider` and beside the `Stack` rather than inside a screen, so it
 * survives every navigation - a listener that unmounted with a screen would stop hearing taps
 * the moment somebody moved.
 */

import { useEffect, useRef } from 'react';
import { useRouter } from 'expo-router';
import { useSession } from './chat-provider.tsx';
import { onNotificationTap, pendingLaunchHref, registerForPush } from './push.ts';

export function PushGate() {
  const { authState } = useSession();
  const router = useRouter();
  /**
   * Registration runs once per signed-in session, not once per render.
   *
   * `authState` settles on `signed-in` and then this component re-renders for every unrelated
   * session change. Without the latch each one would re-request the token and re-POST it -
   * harmless, because the server upserts, but a network call per render is not something to
   * leave running.
   */
  const registered = useRef(false);

  useEffect(() => {
    if (authState !== 'signed-in') {
      // Reset on sign-out so the next account registers this device against itself.
      registered.current = false;
      return;
    }
    if (registered.current) return;
    registered.current = true;
    void registerForPush();
  }, [authState]);

  // Taps while the app is running.
  useEffect(() => {
    if (authState !== 'signed-in') return;
    return onNotificationTap((href) => router.push(href));
  }, [authState, router]);

  /*
   * The tap that LAUNCHED the app, which the listener above can never see.
   *
   * That tap happened before any React code ran, so by the time this mounts the event is gone;
   * Expo holds the last response precisely so it can be collected late. Reading it only once
   * signed-in also means a cold launch from a notification lands on the destination rather than
   * on sign-in - the session restores first, then this runs.
   *
   * `replace` rather than `push`: there is nothing behind it worth keeping, and pushing would
   * leave a back control that unwinds to a bare tab root the member never chose to visit.
   */
  useEffect(() => {
    if (authState !== 'signed-in') return;
    let cancelled = false;
    void (async () => {
      const href = await pendingLaunchHref();
      if (!cancelled && href !== undefined) router.replace(href);
    })();
    return () => {
      cancelled = true;
    };
  }, [authState, router]);

  return null;
}
