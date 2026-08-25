/**
 * The two legal documents, and the links that reach them.
 *
 * > **ADR-0005 left an obligation that no code change forces**: without end-to-end encryption the
 * > Privacy Policy has to say plainly that message content is readable by the service. Its own
 * > wording calls that "easy to overlook", which is exactly the kind of rule that needs a test
 * > rather than a memory. This file is that test.
 *
 * It also pins the two URLs. `docs/legal/*.md` is the single source of the text; the mobile app
 * links OUT to the pages that render them, and a typo in either link is a member sent to a 404
 * from the sentence where they agree to the documents.
 *
 * Reads the markdown from the repository rather than importing anything, because the documents
 * are prose and prose has no other harness. The mobile app has deliberately no component or hook
 * test harness (see `AGENTS.md`), so what is checked here is what can be checked as a value: the
 * URLs, the date, the disclaimer, and the sentence ADR-0005 asked for.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PRIVACY_URL, TERMS_URL } from './legal.ts';

/** Repository root, three levels up from `apps/mobile/src/`. */
const repoFile = (path: string): string =>
  readFileSync(fileURLToPath(new URL(`../../../${path}`, import.meta.url)), 'utf8');

const privacy = repoFile('docs/legal/privacy-policy.md');
const terms = repoFile('docs/legal/terms-of-service.md');

describe('the links the app opens', () => {
  it('points at the pages the apex site serves', () => {
    expect(PRIVACY_URL).toBe('https://clubchatapp.com/privacy');
    expect(TERMS_URL).toBe('https://clubchatapp.com/terms');
  });
});

describe('the Privacy Policy', () => {
  /**
   * ADR-0005, "Follow-up needed", verbatim: *"The Privacy Policy must state plainly that message
   * content is readable by the service."*
   *
   * Three separate assertions rather than one sentence match, so that softening any part of it -
   * dropping direct messages, dropping the word read - fails rather than passes on a rewrite.
   */
  it('states the ADR-0005 obligation: message content is readable by the service', () => {
    expect(privacy).toMatch(/not end-to-end encrypted/i);
    expect(privacy).toMatch(/can be read by us/i);
    expect(privacy).toMatch(/direct message/i);
  });

  it('carries the last-updated date', () => {
    expect(privacy).toMatch(/Last updated: 2026-08-25/);
  });

  it('says it is not legal advice and is waiting on a lawyer', () => {
    expect(privacy).toMatch(/not legal advice/i);
    expect(privacy).toMatch(/lawyer/i);
  });

  it('names the 18+ minimum, which the policy screen never used to', () => {
    expect(privacy).toMatch(/18 or over/i);
  });
});

describe('the Terms', () => {
  it('carries the last-updated date', () => {
    expect(terms).toMatch(/Last updated: 2026-08-25/);
  });

  it('says it is not legal advice and is waiting on a lawyer', () => {
    expect(terms).toMatch(/not legal advice/i);
    expect(terms).toMatch(/lawyer/i);
  });

  /**
   * Apple's guideline 1.2 requires the terms of a user-generated-content app to make clear that
   * there is no tolerance for objectionable content or abusive users, and requires published
   * contact information. Both were discharged by the old in-app Terms screen, and moving the text
   * to a markdown file is exactly the moment they could be lost.
   */
  it('keeps the two App Review sentences that were load-bearing', () => {
    expect(terms).toMatch(/no tolerance for objectionable content or abusive users/i);
    expect(terms).toMatch(/support@clubchatapp\.com/);
  });

  it('states the 18+ minimum', () => {
    expect(terms).toMatch(/18 or over/i);
  });
});

/**
 * `npm run lint:emdash` scans `git ls-files`, so a document that has not been staged yet is not
 * covered by it. These two are long prose files written in one sitting, which is the single most
 * likely place in this repository for the character to appear.
 */
describe('no em dash, per AGENTS.md standing instruction 1', () => {
  it.each([
    ['docs/legal/privacy-policy.md', privacy],
    ['docs/legal/terms-of-service.md', terms],
  ])('%s is clean', (_name, text) => {
    expect(text).not.toContain(String.fromCharCode(0x2014));
  });
});

/**
 * The tracing claim, pinned against the code that decides it.
 *
 * > **This block exists because the document got it wrong once.** In the change set that first
 * > published these files, one agent wrote "No performance tracing. Crash reporting is on;
 * > performance tracing is off" and another agent turned performance tracing ON in the same set:
 * > `fly/api.toml`, `fly/gateway.toml` and `fly/worker.toml` each set
 * > `SENTRY_TRACES_SAMPLE_RATE = '0.1'`, and `apps/mobile/src/config.ts` defaults the phone to the
 * > same number. The suite was green, because nothing here pinned the claim.
 *
 * A privacy policy is the one document where a stale sentence is not a documentation bug. So the
 * rate the policy quotes is READ OUT OF THE DEPLOYMENT rather than typed here: turn tracing down
 * to 0.01 and this fails until somebody changes the published sentence to match.
 */

/** The three files that set the server rate, and the phone's default, as text. */
const flyApi = repoFile('fly/api.toml');
const flyGateway = repoFile('fly/gateway.toml');
const flyWorker = repoFile('fly/worker.toml');
const mobileConfig = repoFile('apps/mobile/src/config.ts');

/** The rate a `fly/*.toml` deploys with, as a number. */
const flyTraceRate = (toml: string): number => {
  const match = /SENTRY_TRACES_SAMPLE_RATE = '([0-9.]+)'/.exec(toml);
  if (match?.[1] === undefined) throw new Error('no SENTRY_TRACES_SAMPLE_RATE in this fly config');
  return Number(match[1]);
};

/** The fallback `config.ts` hands `traceSampleRate`, which is what a build without the env uses. */
const mobileTraceRate = (source: string): number => {
  const match = /sentryTracesSampleRate: traceSampleRate\(\s*[^,]+,\s*([0-9.]+),?\s*\)/.exec(source);
  if (match?.[1] === undefined) throw new Error('no sentryTracesSampleRate default in config.ts');
  return Number(match[1]);
};

/** `0.1` as the percentage a person reads, without the floating-point tail. */
const asPercent = (rate: number): number => Number((rate * 100).toPrecision(12));

describe('the Privacy Policy on performance tracing', () => {
  it('does not claim tracing is off, because it is on', () => {
    expect(privacy).not.toMatch(/no performance tracing/i);
    expect(privacy).not.toMatch(/performance tracing is off/i);
  });

  /**
   * The short version said "No analytics, no tracking". Timing a tenth of requests and sending the
   * timings to another company is not nothing, so the blanket phrase had to go. What replaces it
   * has to survive somebody re-reading it in a year: no analytics SDK and no profile of you is
   * true and checkable, "no tracking of any kind" was not.
   */
  it('does not claim no tracking of any kind', () => {
    expect(privacy).not.toMatch(/no tracking of any kind/i);
    expect(privacy).not.toMatch(/no analytics, no tracking/i);
  });

  it('says plainly that requests are timed, and how many', () => {
    expect(privacy).toMatch(/performance tracing/i);
    expect(privacy).toContain(`${asPercent(flyTraceRate(flyApi))}% of requests are timed`);
  });

  it('names who receives the timings and what they are not', () => {
    expect(privacy).toMatch(/Sentry/);
    expect(privacy).toMatch(/not advertising/i);
    expect(privacy).toMatch(/not an analytics profile of you/i);
  });

  /**
   * The number in the sentence above is only honest while every role that is deployed agrees with
   * it. Three server roles and the phone; one policy sentence.
   */
  it('quotes the rate all three server roles are deployed with', () => {
    expect(flyTraceRate(flyGateway)).toBe(flyTraceRate(flyApi));
    expect(flyTraceRate(flyWorker)).toBe(flyTraceRate(flyApi));
  });

  it('quotes the rate the phone build defaults to', () => {
    expect(mobileTraceRate(mobileConfig)).toBe(flyTraceRate(flyApi));
  });
});

/**
 * Over-the-air updates are a third-party request from the member's own device, so they belong in
 * the third-party section whether or not anybody thinks of them as data collection. ADR-0048 wired
 * them in the same change set that published this policy, and the policy described Expo as doing
 * push delivery only.
 */
describe('the Privacy Policy on over-the-air updates', () => {
  it('discloses the update check the app makes on launch', () => {
    expect(privacy).toMatch(/update service/i);
    expect(privacy).toMatch(/JavaScript/);
    expect(privacy).toMatch(/Expo/);
  });

  /**
   * The Terms say the app can replace its own JavaScript, which is a thing a person agreeing to
   * them should know without having to read the Privacy Policy to find it.
   */
  it('is matched by the Terms, which say the app can update itself', () => {
    expect(terms).toMatch(/update itself/i);
    expect(terms).toMatch(/without putting a new version in the App Store/i);
  });

  /**
   * The other direction. If over-the-air updates are ever switched off, both claims above are
   * false, and this is what fails rather than leaving two documents over-disclosing a flow that
   * stopped.
   */
  it('is describing something app.json still configures', () => {
    const app = JSON.parse(repoFile('apps/mobile/app.json')) as {
      expo: { updates?: { url?: string } };
    };
    expect(app.expo.updates?.url).toMatch(/^https:\/\/u\.expo\.dev\//);
  });
});
