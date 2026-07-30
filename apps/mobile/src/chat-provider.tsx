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
      } catch (error) {
        // Realtime is an enhancement, not a requirement. A failed socket must leave the
        // app usable over REST rather than blocking sign-in, so this is logged and the
        // user is let through.
        console.warn('[chat] initial connect failed, continuing over REST', error);
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

      // Raced against a timeout inside verifySession: a hung check falls back to
      // signed-out rather than leaving the app on a spinner forever.
      const valid = await verifySession(config.apiUrl, token);
      if (cancelled) return;

      if (!valid) {
        await sessionStore.clear();
        setAuthState('signed-out');
        return;
      }

      const response = await fetch(`${config.apiUrl}/me`, {
        headers: { authorization: `Bearer ${token}` },
      });
      const body = (await response.json()) as { userId: string };
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
      revision,
      signedIn,
      signOut,
    }),
    [authState, userId, channels, revision, signedIn, signOut],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}
