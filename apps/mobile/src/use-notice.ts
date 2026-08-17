import { useCallback, useEffect, useState } from 'react';

/**
 * The confirmation line a screen shows after an action, which clears itself.
 *
 * Every notice in this app used to sit where it was put until somebody tapped it - so "Muted"
 * stayed on a conversation indefinitely, reporting something that had already visibly happened.
 * A banner that outlives the thing it describes stops being read at all, which costs you the one
 * case it exists for: the refusal nobody expected.
 *
 * Written as a hook rather than as a timer copied into each screen because there were five of
 * them by the time this was noticed, and `AGENTS.md` is explicit that the second time you write
 * something is when to extract it. A sixth screen now gets the behaviour by using the same state
 * it would have used anyway.
 */

/**
 * Long enough to read, and no longer.
 *
 * The duration comes from the message's own length rather than being a constant, because this
 * app's notices run from `Muted` to "That message was not sent. It contains language this app
 * does not allow. Edit it and try again." - and no single number serves both. Short enough for
 * the first cuts the second off mid-sentence; long enough for the second leaves an
 * acknowledgement on screen well past the point anybody is still looking at it.
 *
 * The ceiling exists because past about five seconds a banner is furniture rather than news, and
 * every notice is tappable, so somebody who has finished reading is never made to wait.
 */
const BASE_MS = 2500;
const PER_CHARACTER_MS = 40;
const CEILING_MS = 5000;

export function noticeDurationMs(text: string): number {
  return Math.min(BASE_MS + text.length * PER_CHARACTER_MS, CEILING_MS);
}

/**
 * Drop-in for `useState<string | null>(null)` on any screen that shows a notice.
 *
 * The token is not decoration. Without it, setting the *same* message twice in a row is not a
 * state change, so the effect would not re-run and the second notice would inherit whatever was
 * left of the first one's timer - which is exactly the case a retried action produces, where the
 * message is identical by definition. Bumping a counter on every call makes each show its own
 * event regardless of the text.
 */
export function useNotice(): [string | null, (text: string | null) => void] {
  const [state, setState] = useState<{ text: string | null; token: number }>({
    text: null,
    token: 0,
  });

  const show = useCallback((text: string | null) => {
    setState((previous) => ({ text, token: previous.token + 1 }));
  }, []);

  useEffect(() => {
    if (state.text === null) return;
    const timer = setTimeout(() => show(null), noticeDurationMs(state.text));
    return () => clearTimeout(timer);
  }, [state, show]);

  return [state.text, show];
}
