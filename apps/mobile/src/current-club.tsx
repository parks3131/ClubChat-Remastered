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

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { useFocusEffect } from 'expo-router';

export type CurrentClub = { clubId: string; name: string } | null;

type Store = {
  currentClub: CurrentClub;
  /** Takes an updater so a caller can decide based on what is already known. */
  setCurrentClub: (next: CurrentClub | ((previous: CurrentClub) => CurrentClub)) => void;
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

  /*
   * On FOCUS, not on mount.
   *
   * A pushed screen does not unmount the one beneath it, so a mount-only declaration is made once
   * and never again. Going hub -> chat -> back therefore left the context cleared by chat's own
   * unmount with nothing to restore it, and the header fell back to the word "Club" on a screen
   * that had shown the club's name a moment earlier. Focus is the event that actually matches
   * "this screen is the one you are looking at".
   */
  useFocusEffect(
    useCallback(() => {
      if (clubId === undefined || clubId === null || clubId.length === 0) return;
      setCurrentClub((previous) => ({
        clubId,
        /*
         * A declaration without a name never erases one already known for the same club.
         *
         * Chat knows its club id from the channel meta but not the club's name, so it declared an
         * empty one and blanked the header for every screen after it. A screen that does not know
         * the name is saying "I am in this club", not "this club has no name".
         */
        name: name ?? (previous?.clubId === clubId ? previous.name : ''),
      }));
      return () => setCurrentClub(null);
    }, [clubId, name, setCurrentClub]),
  );
}
