/**
 * Which club the viewer is currently inside, if any.
 *
 * **"Inside a club" means anywhere in that club's world** - the hub, its chat, Highlights, news,
 * calendar, routines, polls, the races list, a race hub, a race chat, the Eboard channel, any of
 * it. Not just the hub screen. That breadth is the whole point: the Clubs tab has to behave the
 * same way from arbitrary depth, so a car-groups screen four levels down still knows which club it
 * belongs to.
 *
 * The signal is **set when a club-scoped screen mounts and cleared when it unmounts**, which is
 * what makes it survive into race and Eboard chat without either of them knowing about this
 * module. Walking out of the club's world clears it, the same way leaving a room does.
 *
 * ---
 *
 * It powers two things, both in `SPEC/PRD/15`:
 *
 *  1. **The Clubs tab's two-stage escape hatch.** Inside a club and not on its hub, the tab goes to
 *     that club's hub; on the hub, it goes to the My Clubs list. Two taps from anywhere to the
 *     root, and never more.
 *  2. **The Calendar destination's scope.** Inside a club, the Calendar tab shows that club's feed
 *     rather than the merged cross-club one.
 *
 * A context rather than a route param because the readers are in *other tabs* - the tab bar and
 * the Calendar destination both sit outside the club's stack entirely and cannot see its params.
 */

import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

export type CurrentClub = { clubId: string; name: string } | null;

type Store = {
  currentClub: CurrentClub;
  setCurrentClub: (club: CurrentClub) => void;
};

const CurrentClubContext = createContext<Store>({
  currentClub: null,
  setCurrentClub: () => undefined,
});

export function CurrentClubProvider({ children }: { children: ReactNode }) {
  const [currentClub, setCurrentClub] = useState<CurrentClub>(null);
  const value = useMemo(() => ({ currentClub, setCurrentClub }), [currentClub]);
  return <CurrentClubContext.Provider value={value}>{children}</CurrentClubContext.Provider>;
}

export function useCurrentClub(): Store {
  return useContext(CurrentClubContext);
}

/**
 * Declare that this screen is inside a club, for as long as it is mounted.
 *
 * Called by every club-scoped screen, including the ones reached through a race or the Eboard
 * space. `clubId` may be undefined while a read is still resolving which club a race belongs to,
 * and that is handled rather than guarded at each call site - an undefined id simply does not
 * claim anything yet.
 */
export function useDeclareClub(clubId: string | undefined | null, name?: string | undefined): void {
  const { setCurrentClub } = useCurrentClub();

  useEffect(() => {
    if (clubId === undefined || clubId === null || clubId.length === 0) return;
    setCurrentClub({ clubId, name: name ?? '' });
    // Cleared on unmount: walking out of the club's world is what ends "inside a club", and
    // leaving it set would make the Clubs tab jump into a club the viewer already left.
    return () => setCurrentClub(null);
  }, [clubId, name, setCurrentClub]);
}
