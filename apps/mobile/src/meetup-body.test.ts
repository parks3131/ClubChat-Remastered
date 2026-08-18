import { describe, expect, it } from 'vitest';

import { toMeetupBody, type MeetupDraft } from './meetup-body';

const draft = (over: Partial<MeetupDraft> = {}): MeetupDraft => ({
  when: new Date(2026, 7, 14, 6, 30),
  title: 'Morning Miles',
  description: '',
  locationNotes: '',
  mapUrl: '',
  ...over,
});

describe('the meetup composer body', () => {
  it('splits one local moment into a wall-clock date and time', () => {
    /*
     * Never an instant. A club's week is its own day, so a member reading from another country
     * must see Tuesday's meetup on Tuesday - ADR-0029.
     */
    const body = toMeetupBody(draft(), null);
    expect(body.meetupDate).toBe('2026-08-14');
    expect(body.meetupTime).toBe('06:30');
  });

  it('pads a single-digit hour and minute', () => {
    const body = toMeetupBody(draft({ when: new Date(2026, 0, 5, 9, 5) }), null);
    expect(body.meetupDate).toBe('2026-01-05');
    expect(body.meetupTime).toBe('09:05');
  });

  it('sends blanks as null rather than as empty strings', () => {
    // "" is a value the row would then hold, and every reader downstream would have to know it
    // means the same as absent.
    const body = toMeetupBody(draft(), null);
    expect(body.description).toBeNull();
    expect(body.locationNotes).toBeNull();
    expect(body.mapUrl).toBeNull();
  });

  it('trims what somebody typed', () => {
    const body = toMeetupBody(
      draft({ title: '  Morning Miles  ', locationNotes: '  the wooden archway  ' }),
      null,
    );
    expect(body.title).toBe('Morning Miles');
    expect(body.locationNotes).toBe('the wooden archway');
  });

  it('carries location notes, which had no control at all until 2026-08-17', () => {
    const body = toMeetupBody(draft({ locationNotes: 'Meet at the wooden archway' }), null);
    expect(body.locationNotes).toBe('Meet at the wooden archway');
  });

  /*
   * The regression this module was extracted for.
   *
   * `PATCH /meetups/:id` is a whole-form save, so an omitted field is an erased field. The
   * composer used to omit both of these, which meant opening an old meetup and pressing Save
   * destroyed the place it met at - silently, with nothing on screen having asked about it.
   */
  it('carries a place it does not edit, rather than erasing it', () => {
    const body = toMeetupBody(draft(), { location: 'Memorial Park gate' });
    expect(body.location).toBe('Memorial Park gate');
  });

  it('sends every field a whole-form save would otherwise clear', () => {
    /*
     * Asserted as a KEY SET rather than field by field, because the failure mode is omission and a
     * per-field test can only check the fields somebody remembered. A new column that the form
     * does not edit fails here until it is either carried or deliberately listed.
     */
    const body = toMeetupBody(draft(), { location: 'Track' });
    expect(Object.keys(body).sort()).toEqual([
      'description',
      'location',
      'locationNotes',
      'mapUrl',
      'meetupDate',
      'meetupTime',
      'title',
    ]);
  });

  it('has nothing to carry when creating', () => {
    const body = toMeetupBody(draft(), null);
    expect(body.location).toBeNull();
  });
});
