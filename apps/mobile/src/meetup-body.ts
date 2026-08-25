/**
 * The body the meetup composer sends, built as one pure function.
 *
 * **A module of its own so it can be tested**, the same reason `document-name.ts` and
 * `photo-size.ts` exist beside the screens that use them: the composer imports `react-native`,
 * vitest cannot parse React Native's sources, and so anything left inside that file is
 * unreachable from a test. Failure mode 34 states the general form - list arithmetic, and any
 * other rule a screen happens to hold, has no business being untestable.
 *
 * The rule this exists to make assertable is in `toMeetupBody` below, and it cost real data.
 */

import type { MeetupBody } from './api-types';

/** What the composer's own controls hold. Every one of these is edited on screen. */
export type MeetupDraft = {
  /** The local moment the wheel settled on. Split into a wall-clock date and time, never sent as an instant. */
  when: Date;
  title: string;
  description: string;
  locationNotes: string;
  mapUrl: string;
};

/** `HH:MM`, 24-hour, in the club's own day. */
function wallClock(when: Date): string {
  const hh = String(when.getHours()).padStart(2, '0');
  const mm = String(when.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

/** `YYYY-MM-DD`, built from split components rather than from an ISO string. */
function dateKey(when: Date): string {
  const y = when.getFullYear();
  const m = String(when.getMonth() + 1).padStart(2, '0');
  const d = String(when.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** Blank is `null`, never `""`, so no reader downstream has to know the two mean the same thing. */
function orNull(text: string): string | null {
  const trimmed = text.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Build the whole-form body for a create or an edit.
 *
 * **`PATCH /meetups/:id` is a whole-form save: an absent field means empty.** That is the right
 * rule for something saved as one form (`TECH/10`), and it is what makes clearing a description
 * work at all. It also means **every field the form does not edit has to be sent back**, or
 * saving destroys it.
 *
 * That is not hypothetical. Until 2026-08-17 this body omitted both `locationNotes` - which had
 * no control anywhere, though the route accepted it and the meetup's screen drew it - and
 * `location`. So opening the composer on a meetup written before the place was dropped, changing
 * nothing, and pressing Save silently erased where the club met.
 *
 * **Every field of a meetup now has a control on the form**, since ADR-0049 removed `location`,
 * which was the last one that did not. The second parameter this function used to take existed
 * only to carry that field through untouched, and went with it. The rule it enforced has not
 * gone anywhere: a field this screen does not edit is a field it must not erase, so anything
 * added to the row later either gets a control here or gets carried the same way.
 */
export function toMeetupBody(draft: MeetupDraft): MeetupBody {
  return {
    // Split from ONE local moment. The wire carries a wall-clock date and time, never an instant,
    // because a club's week is its own day and not the reader's - see ADR-0029.
    meetupDate: dateKey(draft.when),
    meetupTime: wallClock(draft.when),
    title: draft.title.trim(),
    description: orNull(draft.description),
    locationNotes: orNull(draft.locationNotes),
    /*
     * The link, and nothing derived from it. This client places no pin and neither does the
     * server: the map picture was taken out on 2026-08-15 and the coordinates it would have used
     * were removed by ADR-0049, having been empty on every meetup a phone ever created. Directions
     * opens the pasted link itself, which is exact.
     */
    mapUrl: orNull(draft.mapUrl),
  };
}
