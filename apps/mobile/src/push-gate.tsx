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
 *
 * > **Navigation goes through expo-router's imperative `router` singleton, never `useRouter()`,
 * > and that is a correctness requirement rather than a style choice.** This component reads
 * > `useSession()`, whose context bumps `revision` on every socket event - so it re-renders
 * > constantly while a conversation is live. `useRouter()` hands back a fresh object identity on
 * > each of those renders, which as an effect dependency meant the tap subscription was town down
 * > and re-added on every incoming message, and the cold-start effect's `cancelled` cleanup could
 * > fire while its `await` was still in flight and silently drop the navigation. The symptom was
 * > a notification that opened the app and left you where you were. The singleton is stable, so
 * > both effects now depend on `authState` alone and are set up exactly once per session.
 */

import { useEffect, useRef } from 'react';
import { router } from 'expo-router';
import { useSession } from './chat-provider.tsx';
import { onNotificationTap, pendingLaunchHref, registerForPush } from './push.ts';

export function PushGate() {
  const { authState } = useSession();
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

  /*
   * Taps while the app is running.
   *
   * The navigation is deferred a tick rather than issued inline, because this fires from a native
   * callback as the app is coming back to the foreground, and expo-router drops a navigation
   * issued before its root has finished mounting.
   */
  useEffect(() => {
    if (authState !== 'signed-in') return;
    return onNotificationTap((href) => {
      setTimeout(() => router.push(href), 0);
    });
  }, [authState]);

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
   *
   * Deliberately NOT cancelled on cleanup. An earlier version set a `cancelled` flag in the
   * teardown, which read as tidy and meant an unrelated re-render landing between the `await` and
   * the navigate threw the destination away.
   */
  useEffect(() => {
    if (authState !== 'signed-in') return;
    void (async () => {
      const href = await pendingLaunchHref();
      if (href === undefined) return;
      console.log('[push] cold launch →', href);
      setTimeout(() => router.replace(href), 0);
    })();
  }, [authState]);

  return null;
}
