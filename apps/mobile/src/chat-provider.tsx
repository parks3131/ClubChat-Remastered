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
import { AppState, type AppStateStatus } from 'react-native';
import { ChatClient, type SocketLike } from '@clubchat/client-core';
import type { ChannelState } from '@clubchat/shared';
import { config } from './config.ts';
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

  const start = useCallback(
    async (token: string, id: string) => {
      const { store } = await openMessageStore();

      const client = new ChatClient({
        wsUrl: config.wsUrl,
        apiUrl: config.apiUrl,
        token,
        deviceId: crypto.randomUUID(),
        platform: 'web',
        // The RN and browser global WebSocket already matches the interface.
        createSocket: (url) => new WebSocket(url) as unknown as SocketLike,
        store,
        onChange: bump,
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
        // Realtime is an enhancement, not a requirement. A failed socket must leave the app
        // usable rather than blocking sign-in - and with a local cache behind it, "usable"
        // now means chat history actually renders rather than showing an empty screen.
        console.warn('[chat] initial connect failed, running from the local cache', error);
        setOffline(true);
      }

      setAuthState('signed-in');
      bump();
    },
    [bump],
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

  // Reconcile on foreground. The other trigger, socket reconnect, lives in the client.
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
        .catch((error) => console.warn('[chat] foreground reconcile failed', error));
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
    }),
    [authState, userId, channels, offline, revision, signedIn, signOut],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}
