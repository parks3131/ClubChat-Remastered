/**
 * How a build-time string becomes a sampling rate, and what it does with a bad one.
 *
 * Pulled out of `config.ts` to be testable at all: that module imports `react-native` for
 * `Platform`, so nothing under vitest can load it. The same reason `tab-bar-routes.ts` is its own
 * module. The parsing is four lines and would be beneath a test if it were not for the trap in
 * the middle of it - `Number('')` is `0`, and an empty `EXPO_PUBLIC_*` variable is the normal
 * result of an EAS build profile that does not set one.
 */

import { describe, expect, it } from 'vitest';
import { traceSampleRate } from './trace-rate.ts';

describe('a value that is not there', () => {
  it('falls back when the variable is unset', () => {
    expect(traceSampleRate(undefined, 0.1)).toBe(0.1);
  });

  /**
   * The one that would have been silent. `EXPO_PUBLIC_SENTRY_TRACES_SAMPLE_RATE=` in an eas.json
   * profile inlines the empty string into the bundle, and `Number('')` is `0` - so the app would
   * ship with tracing off while every config file said it was on at a tenth.
   */
  it('falls back on an empty string rather than reading it as zero', () => {
    expect(traceSampleRate('', 0.1)).toBe(0.1);
  });

  it('falls back on whitespace, which is what a padded value looks like', () => {
    expect(traceSampleRate('  \n', 0.1)).toBe(0.1);
  });
});

describe('a value that is there', () => {
  it('takes an explicit zero, which is how a build turns tracing off', () => {
    expect(traceSampleRate('0', 0.1)).toBe(0);
  });

  it('takes a fraction', () => {
    expect(traceSampleRate('0.25', 0.1)).toBe(0.25);
  });

  it('takes one, and trims what a build system padded', () => {
    expect(traceSampleRate(' 1 ', 0.1)).toBe(1);
  });
});

/**
 * A phone is not a server, and this is the one place the two halves of this system deliberately
 * disagree. `config.ts` on the server REFUSES to boot on a rate it cannot read, because a server
 * that will not start is a loud, fixable deploy failure. An app that refused to start over a
 * telemetry value would be a black screen in a member's hand, caused by a number nobody in the
 * room can see. So a bad value here is ignored and the default stands.
 */
describe('a value that makes no sense', () => {
  it.each(['off', 'true', 'NaN', '10%'])('falls back on %s rather than crashing a launch', (raw) => {
    expect(traceSampleRate(raw, 0.1)).toBe(0.1);
  });

  it.each(['-1', '2', 'Infinity'])('falls back on %s, which is outside a rate', (raw) => {
    expect(traceSampleRate(raw, 0.1)).toBe(0.1);
  });
});
