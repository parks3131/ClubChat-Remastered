/**
 * Deciding who moderates, with no database in sight.
 *
 * The whole point of splitting `planModerators` out of the reconcile is that the interesting half
 * - who gains the flag, who loses it, and which configured email matched nothing - is a pure diff
 * over two lists. The SQL around it is asserted separately against a real Postgres in
 * `test/platform-moderation.test.ts`; everything below runs in milliseconds and covers the cases
 * an operator will actually produce.
 */

import { describe, expect, it } from 'vitest';
import { parseModeratorList, planModerators } from './platform-moderators.ts';

describe('reading the configured list', () => {
  it('is empty when unset, which is what stops a missing secret revoking anybody', () => {
    expect(parseModeratorList(undefined)).toEqual([]);
  });

  it('is empty for a blank or punctuation-only value', () => {
    expect(parseModeratorList('')).toEqual([]);
    expect(parseModeratorList('   ')).toEqual([]);
    expect(parseModeratorList(',, ,')).toEqual([]);
  });

  it('trims and lowercases, because this is typed by hand into a secret store', () => {
    expect(parseModeratorList('  RPKParks@Gmail.com ,  Second@Test.invalid ')).toEqual([
      'rpkparks@gmail.com',
      'second@test.invalid',
    ]);
  });

  it('dedupes, including across case', () => {
    expect(parseModeratorList('a@test.invalid,A@TEST.INVALID,a@test.invalid')).toEqual([
      'a@test.invalid',
    ]);
  });
});

describe('planning the reconcile', () => {
  const account = (email: string, isModerator: boolean, userId = `id-${email}`) => ({
    userId,
    email,
    isModerator,
  });

  it('grants the flag to a configured account that does not hold it', () => {
    const plan = planModerators(
      ['a@test.invalid'],
      [account('a@test.invalid', false, 'user-a')],
    );

    expect(plan.grant).toEqual(['user-a']);
    expect(plan.revoke).toEqual([]);
    expect(plan.unmatched).toEqual([]);
  });

  it('is a real diff, so an account already holding it is not re-granted', () => {
    const plan = planModerators(['a@test.invalid'], [account('a@test.invalid', true, 'user-a')]);

    expect(plan.grant).toEqual([]);
    expect(plan.revoke).toEqual([]);
  });

  it('revokes from a holder who is no longer named', () => {
    const plan = planModerators(
      ['a@test.invalid'],
      [account('a@test.invalid', true, 'user-a'), account('gone@test.invalid', true, 'user-b')],
    );

    expect(plan.grant).toEqual([]);
    expect(plan.revoke).toEqual(['user-b']);
  });

  it('grants and revokes in the same plan, since they are halves of one decision', () => {
    const plan = planModerators(
      ['new@test.invalid'],
      [account('new@test.invalid', false, 'user-new'), account('old@test.invalid', true, 'user-old')],
    );

    expect(plan.grant).toEqual(['user-new']);
    expect(plan.revoke).toEqual(['user-old']);
  });

  it('names a configured email that matched no account, rather than passing silently', () => {
    // The failure this exists for: a typo grants nobody and is otherwise indistinguishable from
    // success. Compare AGENTS.md failure modes 12 and 19.
    const plan = planModerators(
      ['real@test.invalid', 'typo@tset.invalid'],
      [account('real@test.invalid', true, 'user-real')],
    );

    expect(plan.grant).toEqual([]);
    expect(plan.unmatched).toEqual(['typo@tset.invalid']);
  });

  it('does nothing at all when the configured list already matches reality', () => {
    const plan = planModerators(
      ['a@test.invalid', 'b@test.invalid'],
      [account('a@test.invalid', true), account('b@test.invalid', true)],
    );

    expect(plan).toEqual({ grant: [], revoke: [], unmatched: [] });
  });

  it('leaves accounts that are neither configured nor moderators completely alone', () => {
    const plan = planModerators(
      ['a@test.invalid'],
      [account('a@test.invalid', true), account('ordinary@test.invalid', false)],
    );

    expect(plan.grant).toEqual([]);
    expect(plan.revoke).toEqual([]);
  });
});
