/**
 * Which club the viewer is inside, and which SPACE within it they are looking at.
 *
 * Two facts, one context, because they change together and are read apart.
 *
 *  - **The club** is "anywhere in that club's world" - the hub, its chat, Highlights, news,
 *    calendar, routines, polls, a race hub, a race chat, the Eboard space, any of it. That
 *    breadth is the whole point: the Clubs tab and the Calendar destination sit in *other tabs*
 *    and cannot see the club's route params, so a car-groups screen four levels down still has
 *    to say which club it belongs to.
 *  - **The space** is the narrower thing the header wears: the club on a club screen, the race
 *    on a race screen, Eboard & Council on its own. v1 gives each of the three its own identity
 *    in the bar rather than the club's, and it is right to - a race chat wearing its club's name
 *    and face makes "which conversation is this" unanswerable from the header, which is the one
 *    job the header has.
 *
 * A race screen therefore declares BOTH at once: club = the parent, space = the race. They are
 * set in a single update rather than by two hooks, because two would take turns overwriting each
 * other on every focus.
 */

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { useFocusEffect } from 'expo-router';

export type CurrentClub = { clubId: string; name: string; image: string | null } | null;

/** The three things that have an identity of their own. A DM has none - it is not in a club. */
export type SpaceKind = 'club' | 'race' | 'eboard';

/**
 * The space whose identity the header should be wearing.
 *
 * `id` is the id in that space's OWN route - a club id, a race id, an eboard id - which is what
 * lets a header check the declaration against the route it is drawing for.
 */
export type CurrentSpace = {
  kind: SpaceKind;
  id: string;
  name: string;
  image: string | null;
} | null;

/** The two facts, held together so one update sets both. */
type Current = { club: CurrentClub; space: CurrentSpace };

/**
 * Whether an update would change anything.
 *
 * Declarations re-run on every focus and on every re-render of the declaring screen, and almost
 * all of them re-state exactly what is already there. Returning the previous object makes React
 * skip the re-render entirely, which matters because every consumer of this context is a header.
 */
function unchanged(a: Current, b: Current): boolean {
  return (
    a.club?.clubId === b.club?.clubId &&
    a.club?.name === b.club?.name &&
    a.club?.image === b.club?.image &&
    a.space?.kind === b.space?.kind &&
    a.space?.id === b.space?.id &&
    a.space?.name === b.space?.name &&
    a.space?.image === b.space?.image
  );
}

type Store = {
  currentClub: CurrentClub;
  currentSpace: CurrentSpace;
  /** Takes an updater, so a caller can decide based on what is already known. */
  setCurrent: (next: Current | ((previous: Current) => Current)) => void;
  clearCurrent: () => void;
};

const CurrentSpaceContext = createContext<Store>({
  currentClub: null,
  currentSpace: null,
  setCurrent: () => undefined,
  clearCurrent: () => undefined,
});

export function CurrentSpaceProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<Current>({ club: null, space: null });

  /*
   * **Stable, and it has to be**, which is the whole reason this is a `useCallback` with no
   * dependencies rather than an inline arrow.
   *
   * `useClearClub` runs it from a focus effect keyed on this function. Rebuilt on every state
   * change, the effect re-ran, cleared again, produced a new state object, rebuilt the function,
   * and the clubs list died with "Maximum update depth exceeded" before it finished painting.
   */
  const clearCurrent = useCallback(() => {
    // Bails out rather than storing a fresh pair of nulls: an update that changes nothing still
    // re-renders every consumer, and this one fires on focus of four different screens.
    setState((previous) =>
      previous.club === null && previous.space === null ? previous : { club: null, space: null },
    );
  }, []);

  const value = useMemo<Store>(
    () => ({
      currentClub: state.club,
      currentSpace: state.space,
      // `setState` from `useState` is already stable, so it is passed through unwrapped.
      setCurrent: setState,
      clearCurrent,
    }),
    [state, clearCurrent],
  );

  return <CurrentSpaceContext.Provider value={value}>{children}</CurrentSpaceContext.Provider>;
}

export function useCurrentSpace(): Store {
  return useContext(CurrentSpaceContext);
}

/**
 * Declare which club this screen is in and which space it is showing.
 *
 * Every club-, race- and Eboard-scoped screen calls this, directly or through one of the three
 * wrappers below. `clubId` and `id` may be undefined while a read is still resolving which club
 * a race belongs to; an undefined id simply claims nothing yet, which is handled here rather
 * than guarded at forty call sites.
 */
export function useDeclareSpace(declaration: {
  kind: SpaceKind;
  /** The space's own id. */
  id: string | undefined | null;
  /** The club this space belongs to. The same value as `id` when the space IS the club. */
  clubId: string | undefined | null;
  name?: string | undefined;
  image?: string | null | undefined;
}): void {
  const { setCurrent } = useCurrentSpace();
  const { kind, id, clubId, name, image } = declaration;

  /*
   * On FOCUS, not on mount.
   *
   * A pushed screen does not unmount the one beneath it, so a mount-only declaration is made
   * once and never again. Going hub -> chat -> back therefore left the context cleared by chat's
   * own unmount with nothing to restore it, and the header fell back to the word "Club" on a
   * screen that had shown the club's name a moment earlier. Focus is the event that actually
   * matches "this screen is the one you are looking at".
   */
  useFocusEffect(
    useCallback(() => {
      if (id === undefined || id === null || id.length === 0) return undefined;

      setCurrent((previous) => {
        /*
         * A declaration without a name never erases one already known for the SAME space.
         *
         * Chat knows its ids before it knows what anything is called, so it declared an empty
         * name and blanked the header for every screen after it. A screen that does not know the
         * name is saying "I am here", not "this place has no name". Same rule for the picture.
         */
        const sameSpace = previous.space?.kind === kind && previous.space.id === id;
        const space: CurrentSpace = {
          kind,
          id,
          name: name ?? (sameSpace ? previous.space?.name ?? '' : ''),
          image: image ?? (sameSpace ? previous.space?.image ?? null : null),
        };

        // The club id can lag the space's - a race screen knows its race id from the route and
        // its club id only once the read lands - so an unknown club never unsets a known one.
        const nextClubId = clubId ?? previous.club?.clubId ?? null;
        if (nextClubId === null) {
          const next: Current = { club: previous.club, space };
          return unchanged(previous, next) ? previous : next;
        }

        const sameClub = previous.club?.clubId === nextClubId;
        const next: Current = {
          club: {
            clubId: nextClubId,
            // Only a CLUB declaration carries the club's own name and picture. A race
            // declaration's name is the race's, and writing it here would put "Maine
            // Invitational" in the Clubs tab.
            name: (kind === 'club' ? name : undefined) ?? (sameClub ? previous.club?.name ?? '' : ''),
            image:
              (kind === 'club' ? image : undefined) ??
              (sameClub ? previous.club?.image ?? null : null),
          },
          space,
        };
        return unchanged(previous, next) ? previous : next;
      });

      /*
       * **Deliberately no cleanup.**
       *
       * Clearing on blur meant the OUTGOING screen wiped what the INCOMING one had just set:
       * navigating between two screens of the same club ran B's focus effect, then A's blur
       * cleanup, leaving the context null until B's own data landed. The header showed the word
       * "Club" for that instant and then swapped to the club's name - a visible flicker on every
       * push inside a club.
       *
       * Leaving is therefore declared by the screens that are OUTSIDE a club, through
       * `useClearClub`, rather than inferred from a blur that also fires for an ordinary push.
       * Blur cannot tell "went deeper into this club" from "left it", and treating both the same
       * is what produced the flicker.
       */
      return undefined;
    }, [kind, id, clubId, name, image, setCurrent]),
  );
}

/** A screen inside a club, showing the club itself. */
export function useDeclareClub(
  clubId: string | undefined | null,
  name?: string | undefined,
  image?: string | null | undefined,
): void {
  useDeclareSpace({ kind: 'club', id: clubId, clubId, name, image });
}

/** A screen inside a race. The club is the race's parent, and usually arrives a beat later. */
export function useDeclareRace(
  raceId: string | undefined | null,
  clubId: string | undefined | null,
  name?: string | undefined,
  image?: string | null | undefined,
): void {
  useDeclareSpace({ kind: 'race', id: raceId, clubId, name, image });
}

/** A screen inside Eboard & Council. */
export function useDeclareEboard(
  eboardId: string | undefined | null,
  clubId: string | undefined | null,
  name?: string | undefined,
  image?: string | null | undefined,
): void {
  useDeclareSpace({ kind: 'eboard', id: eboardId, clubId, name, image });
}

/**
 * Declare that this screen is NOT inside any club.
 *
 * The counterpart to the declarations above, for the four destinations and the My Clubs list.
 * Somebody has to say when the club's world has been left, and a blur cannot: it fires just as
 * loudly for a push one level deeper.
 */
export function useClearClub(): void {
  const { clearCurrent } = useCurrentSpace();
  useFocusEffect(
    useCallback(() => {
      clearCurrent();
      return undefined;
    }, [clearCurrent]),
  );
}
