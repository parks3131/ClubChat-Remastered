/**
 * Where a notification goes when it is acted on.
 *
 * Lifted out of the inbox screen on 2026-08-08, when push registration arrived and gave this
 * rule a **second** caller. A notification can now be acted on two ways - tapping the row in the
 * inbox, or tapping the banner on the lock screen - and both have to land on the same place.
 *
 * The server renders one `target` and sends it down both paths (the inbox row and the push
 * payload's `data.target` are the same value from the same `notificationTarget` call), so a
 * second copy of this switch on the client would be the only thing capable of making them
 * disagree. This project has been bitten twice by a rule written once and re-implemented twice -
 * see the note on `useGoBack` in `nav.tsx` - so it gets one definition here.
 */

import type { NotificationTarget } from '@clubchat/shared';

/**
 * Exhaustive over `NotificationTarget`, which is the reason that type is imported from
 * `@clubchat/shared` rather than restated here: the server derives the target exhaustively over the
 * notification types, and this switch is the client half of the same guarantee. A new target kind
 * becomes a compile error rather than a row that silently navigates nowhere.
 */
export function hrefFor(target: NotificationTarget): string | undefined {
  switch (target.kind) {
    case 'chat':
      // `seq` rides along for a mention or a pin, so the chat opens ON the message rather than at
      // the tail - which is what the jump-to-message window exists for.
      return target.seq === undefined
        ? `/chat/${target.channelId}`
        : `/chat/${target.channelId}?around=${target.seq}`;
    case 'club':
      return `/clubs/${target.clubId}`;
    case 'club_members':
      return `/clubs/${target.clubId}/members`;
    case 'race':
      return `/races/${target.raceId}`;
    case 'race_roster':
      return `/races/${target.raceId}/roster`;
    case 'race_car_groups':
      return `/races/${target.raceId}/car-groups`;
    case 'eboard':
      return `/eboard/${target.eboardId}`;
    case 'eboard_roster':
      return `/eboard/${target.eboardId}/members`;
    case 'poll':
      return `/polls/${target.pollId}`;
    case 'event':
      return `/events/${target.eventId}`;
    case 'meeting':
      return `/meetings/${target.meetingId}`;
    case 'news':
      return `/clubs/${target.clubId}/news`;
    // The Reports tab of that channel's Highlights, opened ON that tab rather than on Pinned -
    // the reviewer was sent here by a report, so landing them anywhere else is a second tap.
    case 'chat_reports':
      return `/channels/${target.channelId}/highlights?tab=reports`;
    /*
     * The platform moderation queue.
     *
     * > **This returned `undefined` until 2026-08-08**, because there was no screen to send
     * > anybody to - the row appeared, said a report was waiting, and went nowhere when tapped.
     * > A moderator being told about a queue they could not open was the last part of the one
     * > safety path in the product that dead-ended.
     */
    case 'platform_moderation':
      return '/moderation';
    case 'inbox':
      /*
       * The inbox itself, which the two callers read differently and both correctly.
       *
       * A ROW in the inbox that points at the inbox has nowhere to go: you are already looking
       * at it. A PUSH banner that points at the inbox does - the app may be backgrounded or
       * cold - so the push path substitutes the tab rather than treating this as unnavigable.
       * That substitution lives at the call site, because "already here" is only true for one
       * of them.
       */
      return undefined;
  }
}

/** Where the inbox lives, for the push path's `inbox` fallback. */
export const INBOX_HREF = '/notifications';
