/**
 * Who holds the platform-moderator capability, decided by configuration.
 *
 * > **A platform moderator is an operator, not a product role.** Every other authority in this
 * > product is earned inside it - you are an Owner because you made a club, an Eboard member
 * > because somebody promoted you. `is_platform_moderator` is not like that. It says "this person
 * > runs the service", it is granted by whoever holds the deployment, and there is deliberately no
 * > way to earn it from inside the app. So it belongs with the other facts about how this process
 * > is wired - the mail transport, the proxy count, the media signer - which all come from config.
 *
 * Before this existed the flag was set by hand, with SQL, against whichever database was in front
 * of you. That has no inverse anybody remembers, no record of who did it, and does not survive a
 * restore or a `db:nuke` - so the queue could silently end up with nobody reading it, which is the
 * one failure this whole subsystem exists to prevent.
 *
 * **The column stays.** `loadAccessContext` answers everything in one round trip and must keep
 * doing so, and plumbing config into the policy layer would give one rule two homes. So the
 * database flag remains what predicates read; it is now a **cache of the configured list**,
 * reconciled when the API boots.
 *
 * Reconciled by the **API only**, not the gateway or the worker. One writer, so a disagreement
 * between processes is not representable - and the API is the process that serves the queue.
 */

import { sql } from 'drizzle-orm';
import type { Db } from '../db/client.ts';

/** One account the reconcile has to decide about. */
export type ModeratorAccount = {
  readonly userId: string;
  /** Already lowercased by the caller, matching how `configured` is normalised. */
  readonly email: string;
  readonly isModerator: boolean;
};

export type ModeratorPlan = {
  /** User ids to grant the flag to. Already-granted accounts are absent, so this is a real diff. */
  readonly grant: readonly string[];
  /** User ids to take it from: they hold it and are no longer named in config. */
  readonly revoke: readonly string[];
  /**
   * Configured emails matching no account at all.
   *
   * Reported rather than ignored, because a typo here grants nobody and looks exactly like
   * success. That is the shape of failure modes 12 and 19 - a rule that reads correct and never
   * fires - and one log line is the whole defence against it.
   */
  readonly unmatched: readonly string[];
};

/**
 * Read the configured list.
 *
 * Comma-separated, whitespace-tolerant, lowercased and deduped, because this is typed into a
 * secret store by a human under no validation at all.
 */
export function parseModeratorList(value: string | undefined): string[] {
  if (value === undefined) return [];
  const seen = new Set<string>();
  for (const part of value.split(',')) {
    const email = part.trim().toLowerCase();
    if (email !== '') seen.add(email);
  }
  return [...seen];
}

/**
 * Diff the configured list against who currently holds the flag.
 *
 * Pure, so the interesting half of this feature is testable with no database and no container.
 * `accounts` is every account that is either named in `configured` or currently a moderator -
 * which is exactly the set the answer can depend on.
 */
export function planModerators(
  configured: readonly string[],
  accounts: readonly ModeratorAccount[],
): ModeratorPlan {
  const wanted = new Set(configured);
  const grant: string[] = [];
  const revoke: string[] = [];
  const matched = new Set<string>();

  for (const account of accounts) {
    if (wanted.has(account.email)) {
      matched.add(account.email);
      if (!account.isModerator) grant.push(account.userId);
    } else if (account.isModerator) {
      revoke.push(account.userId);
    }
  }

  return {
    grant,
    revoke,
    unmatched: configured.filter((email) => !matched.has(email)),
  };
}

export type ReconcileOutcome = ModeratorPlan & {
  /**
   * True when the list was empty and nothing was touched.
   *
   * > **An empty list never revokes, and that is a deliberate refusal rather than an oversight.**
   * > Reconciling to zero moderators would mean DM reports arrive and nobody can read them, which
   * > is the exact state Apple's guideline 1.2 forbids and the reason this subsystem exists. It is
   * > also indistinguishable from the commonest operator mistake - a deploy where the secret was
   * > not carried over - and the cost of the two cases is wildly different: refusing to act on an
   * > empty list costs one warning, and acting on it silently unstaffs moderation.
   *
   * Reducing the list to one person still works, because that list is not empty. Going to nobody
   * is the only thing this will not do for you.
   */
  readonly skipped: boolean;
};

/**
 * Make the database agree with the configured list.
 *
 * Idempotent, so every API instance can run it at boot and a restart is a no-op. Runs in one
 * transaction: a grant and a revoke are halves of one decision, and applying only one of them
 * would leave the platform in a state nobody configured.
 */
export async function reconcilePlatformModerators(
  db: Db,
  configured: readonly string[],
): Promise<ReconcileOutcome> {
  const empty: ModeratorPlan = { grant: [], revoke: [], unmatched: [] };
  if (configured.length === 0) return { ...empty, skipped: true };

  /*
   * Everybody the decision could touch: named in config, or holding the flag today.
   *
   * Matched on `lower(email)` because the configured list is lowercased and what a person typed
   * into a secret store is not something to be case-sensitive about. An anonymised account is
   * deliberately not excluded - if a deleted account somehow holds the flag, the revoke branch
   * should take it away rather than skip over it.
   */
  const rows = await db.execute<{
    user_id: string;
    email: string;
    is_platform_moderator: boolean;
  }>(sql`
    SELECT id::text AS user_id, lower(email) AS email, is_platform_moderator
      FROM users
     WHERE is_platform_moderator
        OR lower(email) = ANY(${sql.param([...configured])}::text[])
  `);

  const plan = planModerators(
    configured,
    rows.rows.map((row) => ({
      userId: row.user_id,
      email: row.email,
      isModerator: row.is_platform_moderator,
    })),
  );

  if (plan.grant.length > 0 || plan.revoke.length > 0) {
    await db.transaction(async (tx) => {
      if (plan.grant.length > 0) {
        await tx.execute(sql`
          UPDATE users SET is_platform_moderator = true
           WHERE id = ANY(${sql.param([...plan.grant])}::uuid[])
        `);
      }
      if (plan.revoke.length > 0) {
        await tx.execute(sql`
          UPDATE users SET is_platform_moderator = false
           WHERE id = ANY(${sql.param([...plan.revoke])}::uuid[])
        `);
      }
    });
  }

  return { ...plan, skipped: false };
}
