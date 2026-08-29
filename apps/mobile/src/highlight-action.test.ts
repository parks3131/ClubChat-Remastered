/**
 * Where a pinned row goes when it is tapped.
 *
 * > **Written on 2026-08-29, because a pinned photograph went nowhere from either surface that
 * > lists pins.** The strip sent it to Highlights, which is the fallback for a pin that is only a
 * > message; Highlights then drew the word "Photo" as inert text and offered nothing. So the one
 * > kind of pin whose entire content IS the thing pinned was the one kind you could not look at.
 * > The media id had been on the wire the whole time and neither surface read it.
 *
 * This is the same argument `PRD/05` already makes for a poll card, applied to the case it did
 * not cover: a list that shows somebody a pin while giving them no way to reach what it is a pin
 * OF is worse than a list that does not show it at all.
 *
 * The tests are over the decision function rather than the screens on purpose. The mobile app has
 * no component harness by design (`AGENTS.md` section 0, instruction 12), so the testable part is
 * the rule, and the drawing is proved on a device.
 */

import { describe, expect, it } from 'vitest';
import type { MessageEnvelope } from '@clubchat/shared';
import { highlightAction } from './highlight-action.ts';

const CHANNEL = 'b1498131-1310-472e-980e-763b7f437f1f';
const SENDER = '11111111-1111-4111-8111-111111111111';
const MEDIA = '22222222-2222-4222-8222-222222222222';
const THING = '77777777-7777-4777-8777-777777777777';

/** A plain text message, which every case below varies from by one or two fields. */
function message(over: Partial<MessageEnvelope> = {}): MessageEnvelope {
  return {
    id: '33333333-3333-4333-8333-333333333333',
    channelId: CHANNEL,
    seq: 12,
    senderId: SENDER,
    senderName: 'Riley',
    senderImage: null,
    type: 'text',
    body: 'See you at the gate',
    clientMsgId: '44444444-4444-4444-8444-444444444444',
    pinned: true,
    pinnedAt: '2026-08-29T09:00:00.000Z',
    reactions: [],
    mentions: [],
    mediaId: null,
    documentName: null,
    documentSize: null,
    linkedPollId: null,
    linkedEventId: null,
    linkedMeetingId: null,
    replyTo: null,
    deletedAt: null,
    editedAt: null,
    createdAt: '2026-08-29T08:00:00.000Z',
    ...over,
  };
}

describe('a pinned card opens the object it announces', () => {
  it('sends a poll card to that poll', () => {
    expect(highlightAction(message({ type: 'poll', linkedPollId: THING }))).toEqual({
      kind: 'route',
      href: `/polls/${THING}`,
    });
  });

  it('sends an event card to that event', () => {
    expect(highlightAction(message({ type: 'event', linkedEventId: THING }))).toEqual({
      kind: 'route',
      href: `/events/${THING}`,
    });
  });

  it('sends a meeting card to that meeting', () => {
    expect(highlightAction(message({ type: 'meeting', linkedMeetingId: THING }))).toEqual({
      kind: 'route',
      href: `/meetings/${THING}`,
    });
  });
});

describe('a pinned photo opens the photo', () => {
  /*
   * The defect this file was written for. A photograph is the one pin whose content is the thing
   * itself, so a row that says "Photo" and does nothing is showing somebody a picture they cannot
   * look at.
   */
  it('answers with the media id rather than a route', () => {
    expect(highlightAction(message({ type: 'photo', mediaId: MEDIA, body: null }))).toEqual({
      kind: 'photo',
      mediaId: MEDIA,
    });
  });

  it('is a photo action even when a caption came with it', () => {
    expect(
      highlightAction(message({ type: 'photo', mediaId: MEDIA, body: 'The finish' })),
    ).toEqual({ kind: 'photo', mediaId: MEDIA });
  });

  /*
   * Highlights does not filter on the upload having finished - `readHighlights` has no
   * `media_objects.status = 'ready'` check, unlike the gallery read - so a pin can arrive with a
   * null media id. Opening a viewer onto nothing is a control that looks like it did something
   * and did not, which is the exact failure this whole change exists to remove.
   */
  it('does nothing when there are no bytes to show', () => {
    expect(highlightAction(message({ type: 'photo', mediaId: null }))).toBeNull();
  });
});

describe('everything else stays view-only', () => {
  it('does nothing for an ordinary message, because Highlights is already its destination', () => {
    expect(highlightAction(message())).toBeNull();
  });

  it('does nothing for an announcement', () => {
    expect(highlightAction(message({ type: 'announcement' }))).toBeNull();
  });

  /*
   * A document is not covered yet. Chat hands one to the share sheet; neither pin surface does,
   * and that is a known gap rather than a decision - recorded here so the day it is closed, this
   * expectation is the thing that fails and asks to be rewritten.
   */
  it('does nothing for a document, which is a gap and not a rule', () => {
    expect(
      highlightAction(message({ type: 'document', mediaId: MEDIA, documentName: 'route.pdf' })),
    ).toBeNull();
  });
});

describe('a tombstone links nowhere', () => {
  const deletedAt = '2026-08-29T10:00:00.000Z';

  /*
   * Both surfaces already drop deleted rows before they get here - the strip filters them out of
   * `pinnedRows` and `readHighlights` filters them in SQL - so this is belt and braces, and it is
   * worth having because the two filters live in different processes and either could move.
   */
  it('refuses a deleted photo, whose bytes are gone', () => {
    expect(highlightAction(message({ type: 'photo', mediaId: MEDIA, deletedAt }))).toBeNull();
  });

  it('refuses a deleted card, whose object went with it', () => {
    expect(
      highlightAction(message({ type: 'poll', linkedPollId: THING, deletedAt })),
    ).toBeNull();
  });
});
