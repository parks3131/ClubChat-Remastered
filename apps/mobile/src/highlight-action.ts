/**
 * What tapping a pinned row does, defined once for the two surfaces that list pins.
 *
 * The pinned strip floating over chat and the Pinned tab in Highlights show the same rows, and
 * `DESIGN/03` rule "the strip and the Highlights list must send a pin to the same destination"
 * is the reason this is a function rather than a branch written twice. It has already been
 * learned the expensive way in this area: the strip's ordering and the Highlights read answered
 * "which pin is most recent" differently for a month, because the two were never made to share
 * the rule (see `reads.ts`, `readHighlights`).
 *
 * The two surfaces still differ in what they do with `null`, and that difference is deliberate
 * rather than an oversight. The strip falls back to Highlights, because Highlights is where a
 * pin that is only a message belongs. Highlights does nothing, because it IS that destination -
 * there is nothing further to open.
 */

import type { MessageEnvelope } from '@clubchat/shared';
import { hrefForCard } from './notification-href.ts';

/**
 * Where a tap goes, or `null` when the row has nothing to open.
 *
 * A route and a photo are different kinds of answer rather than one string, because they are
 * different kinds of destination. A card LEAVES the surface for the poll, event or meeting it
 * announces. A photo does not leave at all: the viewer opens over the list, so a pin found in
 * Highlights can be looked at without losing the place in a list that may be long.
 */
export type HighlightAction =
  | { kind: 'route'; href: string }
  | { kind: 'photo'; mediaId: string };

export function highlightAction(message: MessageEnvelope): HighlightAction | null {
  // A tombstone links nowhere even if the row still remembers what it once pointed at.
  if (message.deletedAt !== null) return null;

  const card = hrefForCard(message);
  if (card !== null) return { kind: 'route', href: card };

  /*
   * A photograph, which is the one pin whose content IS the thing pinned.
   *
   * > **Both surfaces drew the word "Photo" and did nothing with it until 2026-08-29**, while
   * > `mediaId` sat unread on the envelope the whole time. A poll card at least names a poll
   * > somebody could go and find; a picture named "Photo" is not a reference to anything.
   *
   * The media id is checked rather than assumed. `readHighlights` has no
   * `media_objects.status = 'ready'` filter - unlike the gallery read - so a pin whose upload
   * never finished still appears here, and opening a viewer onto nothing would be a control that
   * looks like it worked and did not.
   */
  if (message.type === 'photo' && message.mediaId !== null) {
    return { kind: 'photo', mediaId: message.mediaId };
  }

  return null;
}
