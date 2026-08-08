/**
 * Push notifications on the device: permission, token, registration, and the tap.
 *
 * The server half of push has existed since Phase 1 - the device registry, per-device fan-out,
 * suppression by read cursor (ADR-0008), the Expo transport, the DM push (ADR-0015). **None of
 * it had a client.** `POST /devices` had never been called by anything but a test, which is why
 * `SPEC/PRD/17`'s verification table records the only push ever sent as one to a fake token that
 * was correctly rejected. This module is the missing half.
 *
 * Four things have to be true for a notification to arrive, and each fails differently:
 *
 *  1. **A real device.** The iOS simulator has no APNs connection and cannot produce a token.
 *  2. **Permission**, which iOS grants once and never re-prompts for. A member who declined
 *     must go to Settings, so we never re-ask and never treat it as an error.
 *  3. **A project id**, because an Expo push token is scoped to an EAS project. Without one
 *     `getExpoPushTokenAsync` throws rather than returning null.
 *  4. **APNs credentials** held by Expo for this bundle id, which is the one link in the chain
 *     that is invisible from here: the token is issued happily and delivery silently fails.
 *
 * Every failure is logged and swallowed. Push is an enhancement - the in-app inbox is the
 * durable record and is correct whether or not a banner ever appeared - so nothing here may
 * block sign-in or leave the app on a spinner.
 */

import Constants from 'expo-constants';
import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';
import type { NotificationTarget } from '@clubchat/shared';
import { devicesApi } from './api.ts';
import { hrefFor, INBOX_HREF } from './notification-href.ts';

/**
 * What to do with a notification that arrives while the app is open.
 *
 * **Shown, not suppressed**, and that is a deliberate reversal of the usual default. The server
 * has already decided this member has not read the message: dispatch waits out
 * `PUSH_DEFERRAL_MS` and then checks the read cursor, so anything that survives to the device is
 * about a conversation they are demonstrably not looking at. Suppressing it here because the app
 * happens to be foregrounded would re-introduce exactly the liveness-based suppression that
 * ADR-0008 exists to forbid - a member reading one chat would silently lose the banner for
 * another.
 */
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

/** Why registration did not happen, for the log. `registered` is the success case. */
export type PushOutcome =
  | 'registered'
  | 'not-a-device'
  | 'permission-denied'
  | 'no-project-id'
  | 'failed';

/**
 * The EAS project id an Expo push token is scoped to.
 *
 * Read from the two places the manifest can carry it, because they differ by how the app was
 * built and a dev build reads the one a production build does not.
 */
function projectId(): string | undefined {
  const fromEas = Constants.expoConfig?.extra?.['eas'] as { projectId?: string } | undefined;
  return fromEas?.projectId ?? Constants.easConfig?.projectId;
}

/**
 * Ask for permission, get a token, register it against the signed-in account.
 *
 * Idempotent by construction: `POST /devices` upserts on the token, so calling this on every
 * launch refreshes `last_seen_at` and re-points the row at whoever is signed in now, rather than
 * accumulating a row per launch and buzzing the phone N times per message. That upsert also
 * clears `invalidated_at`, so a token the provider once rejected comes back to life after a
 * reinstall.
 */
export async function registerForPush(): Promise<PushOutcome> {
  // The simulator cannot hold an APNs token. Worth naming rather than letting it surface as a
  // cryptic throw, because it is the single most common reason this appears broken in dev.
  if (!Device.isDevice) {
    console.log('[push] skipped: not a physical device');
    return 'not-a-device';
  }

  try {
    /*
     * Ask only if we have not already been answered.
     *
     * iOS shows the system prompt exactly once per install. Calling `requestPermissionsAsync`
     * unconditionally is harmless but pointless - it resolves instantly with the standing
     * answer - and reading first lets a denial be logged as the settled state it is rather than
     * as a fresh refusal.
     */
    const existing = await Notifications.getPermissionsAsync();
    const granted =
      existing.granted || (await Notifications.requestPermissionsAsync()).granted;

    if (!granted) {
      // Not an error. iOS will never prompt again, so there is nothing to retry and nothing to
      // report: the inbox still works and the member chose this.
      console.log('[push] permission not granted; the inbox still carries everything');
      return 'permission-denied';
    }

    const id = projectId();
    if (id === undefined) {
      // Loud, because this one is a build-configuration mistake rather than a member's choice,
      // and it is otherwise indistinguishable from silent non-delivery.
      console.warn('[push] no EAS project id in the manifest - run `eas init`; cannot get a token');
      return 'no-project-id';
    }

    const token = (await Notifications.getExpoPushTokenAsync({ projectId: id })).data;

    await devicesApi.register({
      pushToken: token,
      platform: Platform.OS === 'ios' ? 'ios' : Platform.OS === 'android' ? 'android' : 'web',
    });

    console.log('[push] registered', token);
    return 'registered';
  } catch (error) {
    // Swallowed on purpose. A failure here must never block sign-in - see the module note.
    console.warn('[push] registration failed', error);
    return 'failed';
  }
}

/**
 * Signing out: tell the server to forget this device.
 *
 * **Called before the session is cleared**, because it is an authenticated request - the ordering
 * is the whole correctness of it and is enforced at the call site in `chat-provider.tsx`.
 *
 * Reads the token back from the OS rather than caching what was registered, so a token that was
 * refreshed mid-session still names the row that actually exists. Failure is swallowed and
 * logged: a phone that cannot reach the server must still be able to sign out, and the worst case
 * is a stale row that the next sign-in re-points at whoever signs in then.
 */
export async function unregisterForPush(): Promise<void> {
  if (!Device.isDevice) return;

  try {
    const id = projectId();
    if (id === undefined) return;

    // Only if permission still stands. Asking for a token without it prompts or throws, and a
    // sign-out is the wrong moment to put a permission dialog in somebody's way.
    const permission = await Notifications.getPermissionsAsync();
    if (!permission.granted) return;

    const token = (await Notifications.getExpoPushTokenAsync({ projectId: id })).data;
    await devicesApi.unregister({ pushToken: token });
    console.log('[push] unregistered on sign-out');
  } catch (error) {
    console.warn('[push] unregister failed; the row will be re-pointed on next sign-in', error);
  }
}

/**
 * The href a tapped notification should open, or undefined if it carries no usable target.
 *
 * The payload is **untrusted input** in the ordinary sense - it has been through APNs and back -
 * so this narrows rather than casts. A malformed `data` yields no href and the tap merely opens
 * the app, which is the correct degradation: the alternative is navigating to a route assembled
 * from a `undefined` id.
 */
export function hrefForResponse(response: Notifications.NotificationResponse): string | undefined {
  const data = response.notification.request.content.data as
    | { target?: NotificationTarget }
    | undefined;
  const target = data?.target;
  if (target === undefined || typeof target !== 'object' || !('kind' in target)) return undefined;

  // The one case the two callers read differently: a row already in the inbox has nowhere to go,
  // but a banner tapped from the lock screen does. See the note in `notification-href.ts`.
  return hrefFor(target) ?? (target.kind === 'inbox' ? INBOX_HREF : undefined);
}

/**
 * The notification that launched the app from cold, if that is how it was launched.
 *
 * Separate from the listener because a listener registered in an effect is **too late** for this
 * case: the tap that started the process happened before any React code ran, and the event is
 * long gone by the time a component mounts. Expo holds the last response for exactly this, and
 * missing it is the classic "deep link works when the app is open, does nothing when it is not"
 * bug.
 */
export async function pendingLaunchHref(): Promise<string | undefined> {
  const response = await Notifications.getLastNotificationResponseAsync();
  if (response === null) return undefined;
  const href = hrefForResponse(response);
  if (href === undefined) {
    console.warn(
      '[push] launch tap resolved to no destination; payload data was',
      JSON.stringify(response.notification.request.content.data),
    );
  }
  return href;
}

/**
 * Subscribe to taps that arrive while the app is already running. Returns the unsubscribe.
 *
 * Logs both outcomes, and the raw `data` when it resolves to nothing. A tap that navigates
 * nowhere is indistinguishable from a tap that merely foregrounded the app, so without this the
 * only symptom is "it opened but stayed where I was" - which is equally consistent with a payload
 * that lost its target, a route that did not take, and nothing being wrong at all.
 */
export function onNotificationTap(handler: (href: string) => void): () => void {
  const subscription = Notifications.addNotificationResponseReceivedListener((response) => {
    const href = hrefForResponse(response);
    if (href === undefined) {
      console.warn(
        '[push] tap resolved to no destination; payload data was',
        JSON.stringify(response.notification.request.content.data),
      );
      return;
    }
    console.log('[push] tap →', href);
    handler(href);
  });
  return () => subscription.remove();
}
