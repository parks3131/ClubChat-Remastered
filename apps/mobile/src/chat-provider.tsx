/**
 * Session and chat context.
 *
 * Holds the one ChatClient for the app's lifetime and wires it to the two lifecycle
 * events that matter: **app foreground and network regained**, not merely mount. v1
 * reconciled only on mount, which is why a phone that backgrounded and resumed could
 * permanently miss messages with no error and no indication.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { AppState, Platform, type AppStateStatus } from 'react-native';
/*
 * `expo-crypto`, not the `crypto` global.
 *
 * Hermes has no `crypto`, so `crypto.randomUUID()` here threw on every iOS launch - the promise
 * rejected before the client was built, auth never resolved, and the app held its loading spinner
 * indefinitely. PRD/03's "never hang on a spinner" was being violated on the primary platform,
 * and only ever on the primary platform: web has the global, so every browser check passed.
 */
import { randomUUID } from 'expo-crypto';
import {
  AuthRejectedError,
  ChatClient,
  TERMINAL_AUTH_CODES,
  type SocketLike,
} from '@clubchat/client-core';
import type { ChannelState } from '@clubchat/shared';
import { config } from './config.ts';
import { capture } from './monitoring.ts';
import { unregisterForPush } from './push.ts';
import { openMessageStore } from './sqlite-store.ts';
import { sessionStore, verifySession } from './session.ts';

export type AuthState = 'checking' | 'signed-out' | 'signed-in';

type SessionContextValue = {
  authState: AuthState;
  userId: string | null;
  client: ChatClient | null;
  channels: ChannelState[];
  /**
   * True when we are running on a stored session we could not verify.
   *
   * Read-only reality rather than a guess: history comes from the local cache, sends queue in
   * the outbox, and the flag exists so the UI can say so rather than looking broken.
   */
  offline: boolean;
  /** Bumped whenever the client's state changes, so screens can re-read the store. */
  revision: number;
  /**
   * Say that something a screen watches has changed.
   *
   * The socket bumps `revision` for everything it hears about, and this is the door for the
   * things it does not: an HTTP call that clears notifications server-side raises no frame, so
   * nothing tells the badge. Marking the inbox read is exactly that case - it fired at the same
   * instant the badge re-read on navigation, the read won the race and fetched the pre-mark
   * count, and the number then sat wrong until the next navigation.
   *
   * Call it AFTER the write lands, never beside it.
   */
  notifyChanged: () => void;
  signedIn: (token: string, userId: string) => Promise<void>;
  signOut: () => Promise<void>;
};

const SessionContext = createContext<SessionContextValue | null>(null);

export function useSession(): SessionContextValue {
  const value = useContext(SessionContext);
  if (!value) throw new Error('useSession used outside SessionProvider');
  return value;
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const [authState, setAuthState] = useState<AuthState>('checking');
  const [offline, setOffline] = useState(false);
  const [userId, setUserId] = useState<string | null>(null);
  const [channels, setChannels] = useState<ChannelState[]>([]);
  const [revision, setRevision] = useState(0);
  const clientRef = useRef<ChatClient | null>(null);

  const bump = useCallback(() => setRevision((n) => n + 1), []);

  /**
   * How long the store's changes are folded together before a second announcement.
   *
   * Long enough to cover one send end to end - optimistic bubble, `msg.ack`, `msg.new`, read
   * cursor - and short enough that a person who does something immediately afterwards is not
   * waiting on it.
   */
  const settleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const settlePending = useRef(false);

  /*
   * The socket's own notification, and the ONLY caller that is coalesced.
   *
   * > **`revision` is read by eight screens, and every one of them re-fetches when it changes.**
   * > The clubs list, a club's page, a poll, the inbox, the profile, the tab badge and the chat
   * > screen all stay mounted behind whatever you are looking at, so one announcement is not one
   * > request - it is one request per loaded screen. And the store announces far more often than
   * > anything a screen draws has changed: connecting announces, finishing a sync announces, and
   * > a single send announces four or five times on its own.
   * >
   * > Measured on the trace: `/conversations`, `/notifications/badge` and `/polls/:id` all fired
   * > twice within 130ms of each other, from three different screens, because connecting and
   * > then catching up announced twice in a row.
   *
   * Leading edge, so the FIRST change is still instant: a message arriving must appear as it
   * arrives, and a notification that waits is a chat that feels slow. Everything inside the
   * window after it is folded into one trailing announcement, which is what collapses a burst.
   *
   * Deliberately wrapping the client's `onChange` rather than `bump` itself. Signing in, signing
   * out and a rejected socket also announce, and those are single deliberate lifecycle events
   * rather than a stream - delaying one would mean an app that has signed out still drawing the
   * previous member's screens.
   */
  const announce = useCallback(() => {
    if (settleTimer.current !== null) {
      settlePending.current = true;
      return;
    }

    bump();
    settleTimer.current = setTimeout(() => {
      settleTimer.current = null;
      if (settlePending.current) {
        settlePending.current = false;
        bump();
      }
    }, 400);
  }, [bump]);

  // A pending trailing announcement must not outlive the provider, or it lands on an unmounted
  // tree - the "setState on an unmounted component" warning, and a timer nothing will clear.
  useEffect(
    () => () => {
      if (settleTimer.current !== null) clearTimeout(settleTimer.current);
    },
    [],
  );

  const start = useCallback(
    async (token: string, id: string) => {
      const { store, persistent } = await openMessageStore();
      /*
       * Said out loud, every time, because the fallback is invisible from inside the app:
       * an in-memory cache behaves identically until you close the app, and "offline chat is
       * empty" is the only symptom. It also names how many times a session has been started,
       * which is the difference between one cache and two over the same connection.
       */
      console.log('[chat] local cache opened', { persistent });

      const client = new ChatClient({
        wsUrl: config.wsUrl,
        apiUrl: config.apiUrl,
        token,
        deviceId: randomUUID(),
        /*
         * The platform we are actually on, not a hardcoded 'web'.
         *
         * It rides on the auth frame and is what a device registration and any per-platform
         * push routing key off, so an iPhone announcing itself as a browser is wrong in the
         * one place it is expensive to notice later.
         */
        platform: Platform.OS === 'ios' ? 'ios' : Platform.OS === 'android' ? 'android' : 'web',
        // The RN and browser global WebSocket already matches the interface.
        createSocket: (url) => new WebSocket(url) as unknown as SocketLike,
        randomUuid: randomUUID,
        store,
        // Coalesced. See `announce`: eight screens re-fetch on `revision`, and the store
        // announces several times per send.
        onChange: announce,
        log: (message, extra) => console.log('[chat]', message, extra ?? ''),
      });

      clientRef.current = client;
      setUserId(id);

      try {
        await client.connect();
        const ids = client.channels.map((channel) => channel.id);
        if (ids.length > 0) client.subscribe(ids);
        await client.syncAll();
        setChannels(client.channels);
        setOffline(false);
      } catch (error) {
        /*
         * **A refusal is not an outage, and treating it as one strands the member.**
         *
         * The gateway answering `invalid_token` is proof the session is dead - the same proof a
         * 401 gives on the HTTP path, where `verifySession` has always acted on it. Falling
         * through to `setOffline(true)` here meant a stale token presented as an app that looked
         * signed in, loaded every screen, and sat on a frozen conversation behind a thin
         * "Offline. Showing saved messages." banner. Nothing re-checked, so it never recovered:
         * the founder hit exactly this on web and the only cure anybody could find was guessing
         * to sign out and back in.
         *
         * `signin_blocked` is the same category - the server has refused this account, not
         * failed to answer - so both end the session rather than degrading.
         */
        /*
         * The same set the client's own reconnect loop stops on, imported rather than repeated.
         * Two copies of "which refusals are final" is one copy too many: the loop and this
         * branch have to agree, or a session ends in one place and retries forever in the other.
         */
        if (error instanceof AuthRejectedError && TERMINAL_AUTH_CODES.has(error.code)) {
          console.warn('[chat] the gateway rejected this session, signing out', error.code);
          /*
           * Reported, because this is the one refusal that ENDS somebody's session, and on
           * 2026-08-09 it did that to a member whose token the API was answering 200 for. The
           * cause was a race in the gateway's frame handling, and it was invisible until the
           * founder said he had been signed out. If it ever recurs, this is the line that says so.
           *
           * The code travels; the token does not. There is nothing here a report may not carry.
           */
          capture(error, 'chat.authRejected', { code: error.code });
          await sessionStore.clear();
          setUserId(null);
          setChannels([]);
          setAuthState('signed-out');
          bump();
          return;
        }

        // Realtime is an enhancement, not a requirement. A failed socket must leave the app
        // usable rather than blocking sign-in - and with a local cache behind it, "usable"
        // now means chat history actually renders rather than showing an empty screen.
        console.warn('[chat] initial connect failed, running from the local cache', error);
        setOffline(true);
      }

      setAuthState('signed-in');
      bump();
    },
    [bump, announce],
  );

  // Restore a stored session on launch.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const token = await sessionStore.load();
      if (!token) {
        if (!cancelled) setAuthState('signed-out');
        return;
      }

      // Raced against a timeout: a hung check never leaves the app on a spinner. But the
      // THREE-way answer matters. Only a server that answered and rejected us is grounds to
      // sign somebody out; being unable to reach it means carrying on with what we know.
      const check = await verifySession(config.apiUrl, token);
      if (cancelled) return;

      if (check === 'invalid') {
        await sessionStore.clear();
        setAuthState('signed-out');
        return;
      }

      if (check === 'unreachable') {
        // Airplane mode, or a dead server. Trust the stored session, run from the local
        // cache, and let `start` re-verify when the socket comes back. Signing out here
        // would make "no signal" indistinguishable from "you have been logged out", and
        // would lock a member out of history they already have on the device.
        const cachedUserId = await sessionStore.loadUserId();
        setOffline(true);
        await start(token, cachedUserId ?? '');
        return;
      }

      const response = await fetch(`${config.apiUrl}/me`, {
        headers: { authorization: `Bearer ${token}` },
      });
      const body = (await response.json()) as { userId: string };
      await sessionStore.saveUserId(body.userId);
      await start(token, body.userId);
    })();

    return () => {
      cancelled = true;
    };
  }, [start]);

  /*
   * Reconcile on foreground. The other trigger, socket reconnect, lives in the client - and
   * from 2026-08-19 it genuinely does: `ChatClient` pings every thirty seconds and reconnects
   * a dropped socket on its own, with backoff. This comment described that arrangement for two
   * phases before any of it existed, which is how a socket reaped while somebody was reading a
   * screen went unnoticed: the app was already foregrounded, so this listener never fired, and
   * nothing else was watching.
   *
   * Both triggers are kept. This one is not redundant: coming back from the background needs a
   * reconcile whether or not the socket survived, because a suspended app misses frames without
   * the socket ever closing.
   */
  useEffect(() => {
    const onAppStateChange = (next: AppStateStatus) => {
      if (next !== 'active') return;
      const client = clientRef.current;
      if (!client) return;
      void client
        .reconnect()
        .then(() => {
          setChannels(client.channels);
          bump();
        })
        .catch((error) => {
          console.warn('[chat] foreground reconcile failed', error);
          /*
           * **The most valuable report in the client**, and the reason this whole module exists.
           *
           * `TECH/14` pitfall 25 is the dangerous bug class in this project: a phone that
           * backgrounds and resumes can permanently miss messages with no error and no
           * indication. This reconcile is the cure. A cure that fails silently is the state the
           * app was in for months on iOS - `/sync` answered 200 and reconciled nothing, and the
           * socket hid it - so a failure here has to reach somebody.
           */
          capture(error, 'chat.foregroundReconcile');
        });
    };

    const subscription = AppState.addEventListener('change', onAppStateChange);
    return () => subscription.remove();
  }, [bump]);

  const signedIn = useCallback(
    async (token: string, id: string) => {
      await sessionStore.save(token);
      // Cached so an offline launch knows whose messages are "mine" without a round trip -
      // otherwise every bubble would render as received.
      await sessionStore.saveUserId(id);
      await start(token, id);
    },
    [start],
  );

  const signOut = useCallback(async () => {
    await clientRef.current?.close();
    clientRef.current = null;
    /*
     * Deregister the phone BEFORE the session is cleared, because that call needs the token.
     *
     * Getting this order wrong is silent: the request 401s, sign-out still completes, and the
     * device stays bound to the account that left - so the next person to pick the phone up
     * keeps receiving their mentions and DMs, sender name and message preview included.
     * Awaited rather than fired off, so a slow network cannot let the clear below win the race.
     */
    await unregisterForPush();
    await sessionStore.clear();
    setUserId(null);
    setChannels([]);
    setAuthState('signed-out');
    bump();
  }, [bump]);

  const value = useMemo<SessionContextValue>(
    () => ({
      authState,
      userId,
      client: clientRef.current,
      channels,
      offline,
      revision,
      signedIn,
      signOut,
      notifyChanged: bump,
    }),
    [authState, userId, channels, offline, revision, signedIn, signOut, bump],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}
