/**
 * Tests for the notification catalogue.
 *
 * ADR-0013 removed the stored `body` and `target`, which moves a class of risk from
 * "wrong data frozen in history" to "a case missing from a renderer". These tests are
 * the compensating control: every type must render non-empty text and resolve to a
 * target, asserted by iterating the union rather than by listing cases by hand - a
 * hand-written list is exactly what would silently omit the new type someone adds.
 */

import { describe, expect, it } from 'vitest';
import {
  notificationParams,
  notificationTarget,
  notificationTypes,
  parseNotificationParams,
  renderNotification,
  PENDING_REQUEST_TYPES,
  type NotificationType,
} from './notifications.ts';

const CLUB = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const RACE = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const EBOARD = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const CHANNEL = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const USER = '11111111-1111-4111-8111-111111111111';
const POLL = '22222222-2222-4222-8222-222222222222';
const EVENT = '33333333-3333-4333-8333-333333333333';
const MEETING = '44444444-4444-4444-8444-444444444444';
const POST = '55555555-5555-4555-8555-555555555555';
const DM = '66666666-6666-4666-8666-666666666666';

/** A valid params object per type, for the exhaustive sweep below. */
const fixtures: { [K in NotificationType]: Record<string, unknown> } = {
  club_join_request: {
    clubId: CLUB,
    clubName: 'Hillside Running Club',
    requesterName: 'Sam',
    requesterId: USER,
  },
  race_join_request: {
    clubId: CLUB,
    clubName: 'Hillside',
    raceId: RACE,
    raceName: 'Spring Half',
    requesterName: 'Sam',
    requesterId: USER,
  },
  eboard_join_request: {
    clubId: CLUB,
    clubName: 'Hillside',
    eboardId: EBOARD,
    requesterName: 'Sam',
    requesterId: USER,
  },
  request_approved: {
    clubId: CLUB,
    clubName: 'Hillside',
    actorName: 'Riley',
    scope: 'race',
    scopeName: 'Spring Half',
    scopeId: RACE,
  },
  request_denied: {
    clubId: CLUB,
    clubName: 'Hillside',
    actorName: 'Riley',
    scope: 'club',
    scopeName: 'Hillside',
  },
  member_added: {
    clubId: CLUB,
    clubName: 'Hillside',
    actorName: 'Riley',
    scope: 'eboard',
    scopeName: 'Eboard & Council',
    scopeId: EBOARD,
  },
  member_removed: {
    clubId: CLUB,
    clubName: 'Hillside',
    actorName: 'Riley',
    scope: 'race',
    scopeName: 'Spring Half',
  },
  role_changed: { clubId: CLUB, clubName: 'Hillside', actorName: 'Riley', newRole: 'admin' },
  poll_created: {
    clubId: CLUB,
    clubName: 'Hillside',
    actorName: 'Riley',
    pollId: POLL,
    question: 'Carpool or bus?',
  },
  poll_closing_soon: { clubId: CLUB, clubName: 'Hillside', pollId: POLL, question: 'Carpool?' },
  event_created: {
    clubId: CLUB,
    clubName: 'Hillside',
    actorName: 'Riley',
    eventId: EVENT,
    title: 'Track night',
  },
  race_created: {
    clubId: CLUB,
    clubName: 'Hillside',
    actorName: 'Riley',
    raceId: RACE,
    raceName: 'Spring Half',
  },
  meeting_created: {
    clubId: CLUB,
    clubName: 'Hillside',
    actorName: 'Riley',
    eboardId: EBOARD,
    meetingId: MEETING,
    title: 'Budget review',
  },
  news_post_created: {
    clubId: CLUB,
    clubName: 'Hillside',
    actorName: 'Riley',
    postId: POST,
  },
  announcement: {
    clubId: CLUB,
    channelId: CHANNEL,
    channelName: 'Hillside',
    seq: 42,
    preview: 'Bus leaves at 6am sharp',
    actorName: 'Riley',
  },
  mentioned: {
    clubId: CLUB,
    channelId: CHANNEL,
    channelName: 'Hillside',
    seq: 43,
    preview: 'can you drive?',
    actorName: 'Riley',
  },
  message_reported: {
    clubId: CLUB,
    channelId: CHANNEL,
    channelName: 'Hillside',
    seq: 43,
    actorName: 'Riley',
  },
  car_group_incharge_left: {
    clubId: CLUB,
    clubName: 'Hillside',
    raceId: RACE,
    raceName: 'Spring Half',
    groupNumber: 2,
    departedName: 'Sam',
  },
  chat_caught_up: {
    clubId: CLUB,
    channelId: CHANNEL,
    channelName: 'Hillside',
    count: 7,
  },
  dm_message: {
    clubId: null,
    channelId: CHANNEL,
    conversationId: DM,
    channelName: 'Riley',
    seq: 12,
    preview: 'can you pick me up on the way',
    actorName: 'Riley',
  },
};

describe('the catalogue is complete', () => {
  it('declares 20 types: the PRD table, the push-only dm_message, and the report', () => {
    // PRD/12's catalogue lists 18. dm_message is the nineteenth and never appears in that
    // table because it never becomes an inbox row - it exists so a direct message can buzz a
    // phone, which is what makes muting a conversation mean anything. See ADR-0015.
    // message_reported is the twentieth, added on 2026-08-01: reporting used to write a row
    // into a work queue and tell nobody there was work in it.
    expect(notificationTypes).toHaveLength(20);
  });

  it('has a params schema for every type', () => {
    for (const type of notificationTypes) {
      expect(notificationParams[type], `no schema for ${type}`).toBeDefined();
    }
  });

  it('has a fixture for every type, so the sweeps below cover all of them', () => {
    // Guards the tests themselves: a new type with no fixture would otherwise quietly
    // shrink the coverage of every `for (const type of notificationTypes)` below.
    expect(Object.keys(fixtures).sort()).toEqual([...notificationTypes].sort());
  });
});

describe('params validation happens at write time', () => {
  it('accepts every valid fixture', () => {
    for (const type of notificationTypes) {
      expect(() => parseNotificationParams(type, fixtures[type]), type).not.toThrow();
    }
  });

  it('rejects a malformed param rather than storing it', () => {
    // The point of validating on write: a bad param surfaces here, not as broken text in
    // somebody's inbox months later, by which time the row is history.
    expect(() => parseNotificationParams('announcement', { channelId: 'not-a-uuid' })).toThrow();
    expect(() =>
      parseNotificationParams('role_changed', {
        clubId: CLUB,
        clubName: 'X',
        actorName: 'Y',
        newRole: 'supreme-leader',
      }),
    ).toThrow();
  });

  it('rejects a missing required param', () => {
    expect(() =>
      parseNotificationParams('announcement', {
        clubId: CLUB,
        channelId: CHANNEL,
        channelName: 'Hillside',
        // seq omitted
        preview: 'hello',
        actorName: 'Riley',
      }),
    ).toThrow();
  });
});

describe('rendering', () => {
  it('produces non-empty title and body for every type', () => {
    for (const type of notificationTypes) {
      const rendered = renderNotification({ type, params: fixtures[type] });
      expect(rendered.title.length, `${type} title`).toBeGreaterThan(0);
      expect(rendered.body.length, `${type} body`).toBeGreaterThan(0);
      // A missing param surfacing as the literal "undefined" in someone's inbox is the
      // most likely rendering bug, and the easiest to miss by eye.
      expect(rendered.body, `${type} body`).not.toContain('undefined');
      expect(rendered.title, `${type} title`).not.toContain('undefined');
    }
  });

  it('pluralises the caught-up count', () => {
    expect(
      renderNotification({
        type: 'chat_caught_up',
        params: { ...fixtures.chat_caught_up, count: 1 },
      }).body,
    ).toContain('1 message in');
    expect(
      renderNotification({
        type: 'chat_caught_up',
        params: { ...fixtures.chat_caught_up, count: 7 },
      }).body,
    ).toContain('7 messages in');
  });

  it('words a demotion differently from a promotion', () => {
    const promoted = renderNotification({
      type: 'role_changed',
      params: { ...fixtures.role_changed, newRole: 'admin' },
    }).body;
    const demoted = renderNotification({
      type: 'role_changed',
      params: { ...fixtures.role_changed, newRole: 'member' },
    }).body;
    expect(promoted).toContain('an admin');
    expect(demoted).toContain('to member');
    expect(promoted).not.toBe(demoted);
  });

  /**
   * A removal names the space it took away, not the club it happened in.
   *
   * The three writers of this type cover three different spaces, and only one of them is the
   * club. Rendering `clubName` for the other two says "you were removed from Hillside" to
   * somebody who lost one race and kept everything else - a false alarm about the membership
   * they still hold.
   */
  it('names the space somebody was removed from, not the club around it', () => {
    const fromRace = renderNotification({
      type: 'member_removed',
      params: { ...fixtures.member_removed, scope: 'race', scopeName: 'Spring Half' },
    });
    expect(fromRace.body).toBe('Riley removed you from Spring Half');
    // The title stays the club, because that is where the row navigates - see the case comment.
    expect(fromRace.title).toBe('Hillside');

    expect(
      renderNotification({
        type: 'member_removed',
        params: { ...fixtures.member_removed, scope: 'eboard', scopeName: 'Eboard & Council' },
      }).body,
    ).toBe('Riley removed you from Eboard & Council');
  });

  it('falls back to the club for a removal row written before it knew about scopes', () => {
    // PRD/12 rule 6: a row must still render years later. Rows written before 2026-08-05 carry
    // no scope at all, and the club is what they always said.
    expect(
      renderNotification({
        type: 'member_removed',
        params: { clubId: CLUB, clubName: 'Hillside', actorName: 'Riley' },
      }).body,
    ).toBe('Riley removed you from Hillside');
  });
});

describe('targets', () => {
  it('resolves a target for every type', () => {
    for (const type of notificationTypes) {
      const target = notificationTarget({ type, params: fixtures[type] });
      expect(target, `${type} target`).toBeDefined();
      expect(typeof target.kind, `${type} kind`).toBe('string');
    }
  });

  it('points a pending request at the roster whose opening clears it', () => {
    // These two must agree. A row that clears when you open screen A but navigates to
    // screen B can never be cleared by following it, which is how the founder lost real
    // join requests.
    expect(notificationTarget({ type: 'club_join_request', params: fixtures.club_join_request }))
      .toEqual({ kind: 'club_members', clubId: CLUB });
    expect(notificationTarget({ type: 'race_join_request', params: fixtures.race_join_request }))
      .toEqual({ kind: 'race_roster', raceId: RACE });
    expect(
      notificationTarget({ type: 'eboard_join_request', params: fixtures.eboard_join_request }),
    ).toEqual({ kind: 'eboard_roster', eboardId: EBOARD });
  });

  it('deep-links an announcement to the exact message, not just the conversation', () => {
    // This is the Phase 1 gate: a push must land on the right message.
    expect(notificationTarget({ type: 'announcement', params: fixtures.announcement })).toEqual({
      kind: 'chat',
      channelId: CHANNEL,
      seq: 42,
    });
  });

  it('opens a DM at the first unread message rather than at one fixed seq', () => {
    // Deliberately no seq. A DM push that deep-linked to the seq it was built from would land
    // above anything that arrived in between; chat already opens on the first unread message,
    // which is the behaviour wanted here.
    expect(notificationTarget({ type: 'dm_message', params: fixtures.dm_message })).toEqual({
      kind: 'chat',
      channelId: CHANNEL,
    });
  });

  it('titles a DM push with the sender and does not repeat them in the body', () => {
    const rendered = renderNotification({ type: 'dm_message', params: fixtures.dm_message });
    expect(rendered.title).toBe('Riley');
    expect(rendered.body).toBe('can you pick me up on the way');
    // In a one-to-one conversation the sender IS the title, so a "Riley:" prefix reads as a
    // bug on a lock screen.
    expect(rendered.body).not.toContain('Riley');
  });

  it('routes an approval by the scope it was for', () => {
    const race = notificationTarget({
      type: 'request_approved',
      params: { ...fixtures.request_approved, scope: 'race', scopeId: RACE },
    });
    const eboard = notificationTarget({
      type: 'request_approved',
      params: { ...fixtures.request_approved, scope: 'eboard', scopeId: EBOARD },
    });
    const club = notificationTarget({
      type: 'request_approved',
      params: { ...fixtures.request_approved, scope: 'club', scopeId: CLUB },
    });
    expect(race).toEqual({ kind: 'race', raceId: RACE });
    expect(eboard).toEqual({ kind: 'eboard', eboardId: EBOARD });
    expect(club).toEqual({ kind: 'club', clubId: CLUB });
  });
});

describe('the pending-request set', () => {
  it('is exactly the three join-request types', () => {
    // The set that opening the inbox must not clear. Stated once, here, so the inbox and
    // the roster screens cannot disagree about which rows are protected.
    expect([...PENDING_REQUEST_TYPES].sort()).toEqual([
      'club_join_request',
      'eboard_join_request',
      'race_join_request',
    ]);
  });

  it('contains only declared types', () => {
    for (const type of PENDING_REQUEST_TYPES) {
      expect(notificationTypes).toContain(type);
    }
  });
});
