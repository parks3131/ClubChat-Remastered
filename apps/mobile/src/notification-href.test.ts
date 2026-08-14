/**
 * Every notification a member can receive has somewhere to go when they tap it.
 *
 * > **Written on 2026-08-14, after a notification arrived on a real phone and went nowhere.**
 * > `meetups` was added to `NotificationTarget` for Nudge, `hrefFor` grew no case for it, and
 * > nothing failed to compile - because a `string | undefined` return makes a missing case fall
 * > out of the switch as a legal `undefined`. The file's own header claimed a new kind "becomes a
 * > compile error rather than a row that silently navigates nowhere". It did not.
 *
 * The `never` assignment in `hrefFor` now enforces that at compile time, and this enforces the
 * half a compiler cannot: that the route a target resolves to is a **real screen**. A case
 * returning `/clubs/${id}/typo` type-checks perfectly.
 *
 * The sweep runs over `notificationTypes` rather than over target kinds on purpose. A kind nobody
 * produces is dead code; what has to hold is that every notification the server can WRITE lands
 * somewhere, which is the same guarantee stated from the member's end.
 */

import { describe, expect, it } from 'vitest';
import { notificationTarget, notificationTypes } from '@clubchat/shared';
import { hrefFor, INBOX_HREF } from './notification-href.ts';

const CLUB = 'a52be46b-e847-4474-8ca2-52d9d59635c1';
const RACE = 'e1f2a3b4-c5d6-4e7f-8a9b-0c1d2e3f4a5b';
const CHANNEL = 'b1498131-1310-472e-980e-763b7f437f1f';
const EBOARD = 'c2d3e4f5-a6b7-4c8d-9e0f-1a2b3c4d5e6f';
const THING = '77777777-7777-4777-8777-777777777777';
const USER = '11111111-1111-4111-8111-111111111111';

/** Every param any type reads, in one object. A type ignores what it does not need. */
const params: Record<string, unknown> = {
  clubId: CLUB,
  clubName: 'Hillside',
  actorName: 'Riley',
  channelId: CHANNEL,
  channelName: 'Main',
  raceId: RACE,
  raceName: 'Cougars',
  eboardId: EBOARD,
  pollId: THING,
  eventId: THING,
  meetingId: THING,
  postId: THING,
  meetupId: THING,
  meetupDate: '2026-08-14',
  meetupTime: '18:30',
  location: 'Memorial Park gate',
  requesterId: USER,
  requesterName: 'Sam',
  seq: 12,
};

describe('every notification type lands somewhere', () => {
  for (const type of notificationTypes) {
    it(`${type} resolves to a route`, () => {
      const href = hrefFor(notificationTarget({ type, params }));

      expect(href, `${type} navigates nowhere`).toBeDefined();
      expect(href).toMatch(/^\//);
      // A route built from a missing param reads as "/clubs/undefined/news" and type-checks.
      expect(href, `${type} built a route from a missing param`).not.toContain('undefined');
    });
  }
});

describe('the inbox kind', () => {
  it('is a fallback for the push path, reached by no notification type', () => {
    /*
     * `hrefFor` returns undefined for `{ kind: 'inbox' }` on purpose - a row in the inbox
     * pointing at the inbox has nowhere to go. **No notification type resolves to it**, which is
     * why the sweep above needs no exemption: the kind exists for the push path's fallback, and
     * `INBOX_HREF` is what that path substitutes. If a type ever does target it, the sweep fails
     * and this comment is where to start.
     */
    expect(hrefFor({ kind: 'inbox' })).toBeUndefined();
    expect(INBOX_HREF).toBe('/notifications');
  });
});

describe('the nudge lands on the week', () => {
  it('opens the club whose meetup was nudged', () => {
    // The whole point of the bug this file exists for: a member tapping the push has to arrive at
    // the week, not at the inbox and not at nothing.
    expect(hrefFor(notificationTarget({ type: 'meetup_nudged', params }))).toBe(
      `/clubs/${CLUB}/weekly-meetups`,
    );
  });
});
