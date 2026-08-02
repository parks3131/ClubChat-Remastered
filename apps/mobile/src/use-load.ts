/**
 * One read, three states.
 *
 * > **`SPEC/PRD/16` rules 1 and 2 are requirements, not polish**: every data-loading screen has
 * > loading, loaded and a **retryable** error, and no screen may fail to a blank page. Forty
 * > hand-written copies of that is how one of them ends up rendering nothing on a 500.
 *
 * The hook owns the state machine; `<DataScreen>` owns what each state looks like. Splitting them
 * is what lets a screen keep its own layout while still being unable to forget the error branch.
 *
 * Realtime is an enhancement, not a requirement (rule 4), so every screen loads its data through
 * this rather than waiting for a socket - a dropped connection degrades to stale-until-refresh.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError } from './api.ts';

export type LoadState = 'loading' | 'loaded' | 'error';

export type Loaded<T> = {
  state: LoadState;
  data: T | null;
  /** Set on error. `notFound` is separated because a screen usually redirects rather than retries. */
  error: { message: string; notFound: boolean } | null;
  reload: () => void;
  /**
   * Read again **without** announcing a load.
   *
   * > **A background refresh is not a first load and must not claim to be one.** `reload` moves
   * > the state to `loading`, which is right when somebody pulled to refresh and wrong when a
   * > screen is merely being returned to: a list bound to that state fires its refresh spinner
   * > every single time, which was reported as the chats "reloading again and again, weird and
   * > seeable".
   *
   * The data still updates when it arrives. What does not happen is the screen claiming to be
   * busy while perfectly good content is on it.
   */
  refresh: () => void;
  /** For optimistic updates: patch what is on screen without a round trip. */
  set: (next: T) => void;
};

/**
 * Run `read` on mount and whenever `deps` change.
 *
 * `read` is expected to be a binding from `api.ts`. A screen that builds its own URL here has
 * skipped the data layer, which is the one rule this hook cannot enforce for itself.
 */
export function useLoad<T>(read: () => Promise<T>, deps: readonly unknown[] = []): Loaded<T> {
  const [state, setState] = useState<LoadState>('loading');
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<{ message: string; notFound: boolean } | null>(null);

  /*
   * Two guards, both learned the hard way in this codebase.
   *
   * `alive` stops a resolve landing after unmount, which React warns about and which on a fast
   * navigation would set state on a screen the user has already left. `attempt` stops an EARLIER
   * request overwriting a later one - a slow first load resolving after a fast reload would
   * otherwise show the stale answer, which reads as a screen that ignores its own refresh.
   */
  const attempt = useRef(0);
  const read_ = useRef(read);
  read_.current = read;

  const run = useCallback((announce = true) => {
    const mine = ++attempt.current;
    // A quiet refresh leaves both alone: the screen keeps showing what it has, and an error
    // from a background read does not replace working content with a retry button.
    if (announce) {
      setState('loading');
      setError(null);
    }

    let alive = true;
    void (async () => {
      try {
        const result = await read_.current();
        if (!alive || mine !== attempt.current) return;
        setData(result);
        setState('loaded');
      } catch (caught) {
        if (!alive || mine !== attempt.current) return;
        // A quiet refresh that fails keeps the last good answer. The screen was already
        // showing something true; replacing it with an error because a background poll missed
        // would be a worse lie than being slightly stale.
        if (!announce) return;
        // A thrown ApiError is a server answer; anything else is almost always the network,
        // and the two deserve different words on screen.
        const notFound = caught instanceof ApiError && caught.status === 404;
        setError({
          message:
            caught instanceof ApiError
              ? notFound
                ? 'Not found'
                : `Could not load this (${caught.status})`
              : 'You appear to be offline',
          notFound,
        });
        setState('error');
      }
    })();

    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    const cancel = run();
    return cancel;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return {
    state,
    data,
    error,
    reload: () => run(true),
    refresh: () => run(false),
    set: setData,
  };
}
