/**
 * The marker lookup, at both depths that occur in this app.
 *
 * The flat case always worked - chat is a leaf of the root stack, so its params carry `arrived`
 * directly. The nested case is the one that shipped broken: `(tabs)` is a group, and a group is
 * handed the route TO the leaf rather than the leaf's own params.
 */

import { describe, expect, it } from 'vitest';
import { arrivedMarker } from './arrived.ts';

describe('finding the arrived marker', () => {
  it('reads it off a leaf route', () => {
    // What `chat/[channelId]` gets: a leaf of the root stack.
    expect(arrivedMarker({ channelId: 'abc', arrived: 'forward' })).toBe('forward');
  });

  it('reads it through a nested navigator, which is where it was being missed', () => {
    // What `(tabs)` gets for /clubs?arrived=forward. Reading `params.arrived` here answers
    // undefined, which is how signing in and leaving a chat became indistinguishable.
    expect(
      arrivedMarker({
        screen: '(main)',
        params: { screen: 'clubs/index', params: { arrived: 'forward' } },
      }),
    ).toBe('forward');
  });

  it('carries the redirect marker too, so the landing-screen rule survives nesting', () => {
    expect(arrivedMarker({ screen: '(main)', params: { arrived: 'redirect' } })).toBe('redirect');
  });

  it('answers undefined when nothing marked the route', () => {
    // The default, and it must be reachable: it is what makes a plain replace read as a way OUT.
    expect(arrivedMarker(undefined)).toBe(undefined);
    expect(arrivedMarker({})).toBe(undefined);
    expect(arrivedMarker({ screen: '(main)', params: { screen: 'clubs/index' } })).toBe(undefined);
    expect(arrivedMarker({ channelId: 'abc' })).toBe(undefined);
  });

  it('stops rather than looping on a params chain that points at itself', () => {
    const cycle: Record<string, unknown> = { screen: '(main)' };
    cycle['params'] = cycle;
    expect(arrivedMarker(cycle)).toBe(undefined);
  });

  it('ignores a non-string arrived rather than treating it as a marker', () => {
    expect(arrivedMarker({ arrived: 1 })).toBe(undefined);
  });
});
