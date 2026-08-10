/**
 * Meet Information, read-only: the five fields as one card.
 *
 * Two screens draw this - the race hub, and the Meet Information screen a member reaches from
 * chat's quick-nav - and they are two renderings of one read. Kept here for the reason the other
 * modules in this directory are: a second hand-written copy does not diverge loudly, it diverges
 * silently, and each copy stays individually correct while the empty-state rule drifts apart
 * between them.
 *
 * **The per-field empty-state rule is the thing being shared**, and it is deliberately not
 * uniform ([`PRD/09`](../../../SPEC/PRD/09-races-and-meets.md) rule 12):
 *
 * | Field | When empty |
 * |---|---|
 * | Details, Location, Hotel | hidden entirely |
 * | Photos, Results | a "Stay tuned" placeholder |
 *
 * Photos and results are expected to arrive later, so their absence is a "not yet" worth saying
 * out loud. A missing hotel link usually means there is no hotel, and a row announcing that is
 * noise. `DetailLine` implements hide-or-placeholder; which field gets which is this module.
 *
 * No heading here. The race hub puts a section header above it; the Meet Information screen
 * already carries the words in its own route header, and a second copy of them would be the
 * screen saying its name twice.
 */

import { Card, DetailLine } from '../ui.tsx';

/** Exactly the five columns the product edits as one atomic form. */
export type MeetInformationFields = {
  meetDescription: string | null;
  meetLocationUrl: string | null;
  meetHotelUrl: string | null;
  meetPhotosUrl: string | null;
  meetResultsUrl: string | null;
};

export function MeetInformationCard({ race }: { race: MeetInformationFields }) {
  return (
    <Card>
      <DetailLine label="Details" value={race.meetDescription} />
      <DetailLine label="Location" value={race.meetLocationUrl} />
      <DetailLine label="Hotel" value={race.meetHotelUrl} />
      <DetailLine label="Photos" value={race.meetPhotosUrl} placeholder="Stay tuned" />
      <DetailLine label="Results" value={race.meetResultsUrl} placeholder="Stay tuned" />
    </Card>
  );
}
