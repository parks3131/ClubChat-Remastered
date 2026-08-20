/**
 * The two hot-path reads that had no index behind them, asserted at the PLAN.
 *
 * > **A statement counter cannot see either of these.** `batch-reads.test.ts` locks
 * > `GET /polls?ids=` to the same number of statements however many polls are asked for, and it
 * > was true and still is - but two of those statements were sequential scans of `poll_votes`,
 * > so the cost of drawing one poll card grew with every vote ever cast anywhere on the
 * > platform. The same shape sat behind every join-request decision: one `UPDATE notifications`
 * > filtered by `type` and three `jsonb` paths, none of which any of that table's four indexes
 * > covered, against a table with no retention job at all. A round-trip counter calls both of
 * > these cheap, because it counts round trips and this is about what one round trip does.
 *
 * So the assertion here is the plan, and a plan is only meaningful over enough rows. **On the
 * 1,692-row `notifications` and 75-row `poll_votes` of the development database Postgres scans
 * sequentially whether or not a usable index exists**, so an `EXPLAIN` there proves nothing in
 * either direction - a seq scan is not evidence of a missing index, and it would not have
 * become an index scan the moment one was added. This file seeds `ROW_TARGET` rows into each
 * table first, which is what makes the planner's choice carry information.
 *
 * **The statements are captured from the real code path rather than copied into this file.**
 * `resolvePendingRequests` and `readPolls` are called for real, every statement they issue is
 * recorded off the pool along with its bound parameters, and the recorded text is what gets
 * explained. A predicate copied into a test is failure mode 9 with a green tick on it: it keeps
 * passing after the code it claims to guard has moved on.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { sql } from 'drizzle-orm';
import { loadAccessContext } from '../policy/context.ts';
import { readPolls } from '../domain/polls.ts';
import { REQUEST_SCOPE_KEY, resolvePendingRequests } from '../worker/notify.ts';
import { startTestDb, type TestDb } from './harness.ts';

let h: TestDb;

/**
 * Enough rows that a sequential scan is the WRONG answer, and not one more.
 *
 * Twenty thousand rows per table is a few megabytes and seeds in about a second, and it puts a
 * full scan an order of magnitude above an index lookup of the handful of rows these predicates
 * actually select - so a planner that still chooses a scan is telling us something rather than
 * shrugging. The production numbers this stands in for are unbounded in both directions:
 * `notifications` has no retention job, and `poll_votes` accumulates for the life of the
 * platform.
 */
const ROW_TARGET = 20_000;

/** Every statement the pool ran, with its parameters, newest last. */
type Statement = { text: string; values: unknown[] };
let statements: Statement[] = [];

/**
 * Record what each pooled client is asked to run.
 *
 * The same chokepoint `dev/queries.ts` counts at, and for the same reason: drizzle checks a
 * client out of the pool for everything, so wrapping `pool.query` instead would miss every
 * transaction and double-count every ordinary read.
 */
function recordStatements(pool: pg.Pool): void {
  const wrapped = new WeakSet<object>();
  const connect = pool.connect.bind(pool);
  const wrap = (client: pg.PoolClient): pg.PoolClient => {
    if (wrapped.has(client)) return client;
    wrapped.add(client);
    const original = client.query.bind(client) as (...a: unknown[]) => unknown;
    client.query = function (...args: unknown[]) {
      const first = args[0];
      // Both call shapes, because drizzle uses the second and nothing else does: it passes a
      // query CONFIG object with the text on it and the parameters as a separate argument, so
      // reading `config.values` alone captures every statement with an empty parameter list -
      // which then explains as "there is no parameter $1" rather than as a plan.
      const separate = Array.isArray(args[1]) ? (args[1] as unknown[]) : undefined;
      if (typeof first === 'string') {
        statements.push({ text: first, values: separate ?? [] });
      } else if (first !== null && typeof first === 'object' && 'text' in first) {
        const config = first as { text: string; values?: unknown[] };
        statements.push({ text: config.text, values: separate ?? config.values ?? [] });
      }
      return original(...args);
    } as typeof client.query;
    return client;
  };
  pool.connect = function (callback?: unknown) {
    if (typeof callback === 'function') {
      return (connect as (cb: unknown) => unknown)(
        (error: unknown, client: pg.PoolClient | undefined, done: unknown) => {
          if (client) wrap(client);
          (callback as (...a: unknown[]) => unknown)(error, client, done);
        },
      );
    }
    return (connect as () => Promise<pg.PoolClient>)().then(wrap);
  } as typeof pool.connect;
}

/** The captured statements that mention a table, in the order they ran. */
const touching = (table: string): Statement[] =>
  statements.filter((s) => s.text.includes(table) && !s.text.startsWith('EXPLAIN'));

/**
 * Every node of a plan, flattened.
 *
 * `EXPLAIN (FORMAT JSON)` nests children under `Plans`, and a sequential scan hiding under a
 * `ModifyTable` or a `Nested Loop` is precisely the one that must not be missed.
 */
type PlanNode = {
  'Node Type': string;
  'Relation Name'?: string;
  'Index Name'?: string;
  Plans?: PlanNode[];
};

const flatten = (node: PlanNode): PlanNode[] => [node, ...(node.Plans ?? []).flatMap(flatten)];

/** Explain one captured statement, with the parameters it really ran with. */
async function explain(statement: Statement): Promise<PlanNode[]> {
  const result = await h.pool.query<{ 'QUERY PLAN': Array<{ Plan: PlanNode }> }>({
    text: `EXPLAIN (FORMAT JSON) ${statement.text}`,
    values: statement.values,
  });
  const plan = result.rows[0]?.['QUERY PLAN'][0]?.Plan;
  if (!plan) throw new Error(`EXPLAIN returned no plan for: ${statement.text}`);
  return flatten(plan);
}

/**
 * The whole assertion, in one place: this statement reaches this table through this index.
 *
 * Both halves matter. The named index proves the one that was added is the one being used, and
 * the absence of a sequential scan on that relation proves there is no second access path
 * quietly doing the full read anyway.
 */
async function expectIndexed(statement: Statement, relation: string, index: string): Promise<void> {
  const nodes = await explain(statement);
  const onRelation = nodes
    .filter((n) => n['Relation Name'] === relation)
    .map((n) => `${n['Node Type']}${n['Index Name'] ? ` using ${n['Index Name']}` : ''}`);
  expect(onRelation.join(' | '), statement.text).not.toContain('Seq Scan');
  expect(
    nodes.map((n) => n['Index Name']).filter((name): name is string => name !== undefined),
    statement.text,
  ).toContain(index);
}

/** Ids the tests then ask about, filled in by `seed`. */
let clubId = '';
let voterId = '';
let requesterId = '';
let raceId = '';
let eboardId = '';
let pollIds: string[] = [];

const scopeIdFor = (key: string): string =>
  key === 'clubId' ? clubId : key === 'raceId' ? raceId : eboardId;

/**
 * A platform's worth of rows, built with `generate_series` rather than through the handlers.
 *
 * Twenty thousand votes cast through the API would take minutes and would prove nothing extra:
 * what these tests need is a table the planner takes seriously, and every constraint on the way
 * in is the same one the handlers have to satisfy.
 */
async function seed(): Promise<void> {
  await h.db.execute(sql`
    INSERT INTO users (full_name, email)
    SELECT 'Member ' || g, 'member-' || lpad(g::text, 4, '0') || '@plans.invalid'
      FROM generate_series(1, 100) g
  `);
  const club = await h.db.execute<{ id: string }>(sql`
    INSERT INTO clubs (name, invite_token, member_invite_token)
    VALUES ('Plan Club', 'plans-admin-token', 'plans-member-token') RETURNING id
  `);
  clubId = club.rows[0]!.id;
  await h.db.execute(sql`
    INSERT INTO club_memberships (club_id, user_id, role)
    SELECT ${clubId}::uuid, id, 'member' FROM users WHERE email LIKE '%@plans.invalid'
  `);
  const chosen = await h.db.execute<{ id: string }>(sql`
    SELECT id FROM users WHERE email LIKE '%@plans.invalid' ORDER BY email LIMIT 2
  `);
  voterId = chosen.rows[0]!.id;
  requesterId = chosen.rows[1]!.id;

  // A race and an Eboard, so the two non-club request types have a real scope to point at.
  const race = await h.db.execute<{ id: string }>(sql`
    INSERT INTO races (club_id, name, race_date)
    VALUES (${clubId}::uuid, 'Plan Race', '2027-05-05') RETURNING id
  `);
  raceId = race.rows[0]!.id;
  const eboard = await h.db.execute<{ id: string }>(sql`
    INSERT INTO eboard_channels (club_id, name)
    VALUES (${clubId}::uuid, 'Plan Eboard') RETURNING id
  `);
  eboardId = eboard.rows[0]!.id;

  /*
   * Notifications, in something like the proportion the real table holds them.
   *
   * Nearly all of it is ordinary traffic - a mention, a reply, an announcement - and only a
   * sliver is an undecided join request. That proportion is the argument for the shape of the
   * index: the rows this UPDATE cares about are a rounding error on the table it searches.
   */
  await h.db.execute(sql`
    WITH numbered AS (
      SELECT id, (row_number() OVER (ORDER BY email)) - 1 AS rn
        FROM users WHERE email LIKE '%@plans.invalid'
    )
    INSERT INTO notifications (recipient_id, club_id, type, params, outbox_event_id)
    SELECT n.id, ${clubId}::uuid, 'message_mention',
           jsonb_build_object('channelId', ${clubId}::text, 'seq', g), g * 4
      FROM generate_series(1, ${ROW_TARGET}) g
      JOIN numbered n ON n.rn = g % 100
  `);

  // The pending requests themselves: one copy per admin, which is how the fan-out writes them.
  // Synthetic outbox keys stay negative and distinct per type, exactly as `notify.ts` requires.
  let block = 1;
  for (const [type, key] of Object.entries(REQUEST_SCOPE_KEY)) {
    await h.db.execute(sql`
      WITH numbered AS (
        SELECT id, (row_number() OVER (ORDER BY email)) - 1 AS rn
          FROM users WHERE email LIKE '%@plans.invalid'
      )
      INSERT INTO notifications (recipient_id, club_id, type, params, outbox_event_id)
      SELECT n.id, ${clubId}::uuid, ${type},
             jsonb_build_object(
               ${key}::text, ${scopeIdFor(key)}::text,
               'requesterId', ${requesterId}::text
             ),
             -(${block * 1000} + n.rn)
        FROM numbered n WHERE n.rn < 20
    `);
    block += 1;
  }

  /*
   * Polls and votes. Half the polls allow multiple answers, because the index that exists today
   * covers only the half that does not - which is the whole of the second finding.
   */
  await h.db.execute(sql`
    INSERT INTO polls (club_id, scope, scope_id, creator_id, question, allow_multiple)
    SELECT ${clubId}::uuid, 'club', ${clubId}::uuid, ${voterId}::uuid,
           'Question ' || lpad(g::text, 4, '0'), g % 2 = 0
      FROM generate_series(1, 1000) g
  `);
  await h.db.execute(sql`
    INSERT INTO poll_options (poll_id, label, position)
    SELECT p.id, 'Option ' || n, n FROM polls p CROSS JOIN generate_series(1, 2) n
  `);
  await h.db.execute(sql`
    WITH numbered AS (
      SELECT id, row_number() OVER (ORDER BY email) AS rn
        FROM users WHERE email LIKE '%@plans.invalid'
    )
    INSERT INTO poll_votes (poll_id, option_id, user_id, allow_multiple)
    SELECT o.poll_id, o.id, n.id, p.allow_multiple
      FROM poll_options o
      JOIN polls p ON p.id = o.poll_id
      JOIN numbered n ON (n.rn % 2) + 1 = o.position
     WHERE n.rn <= 20
  `);
  await h.db.execute(sql`
    UPDATE poll_options o
       SET vote_count = (SELECT count(*) FROM poll_votes v WHERE v.option_id = o.id)
  `);
  const chosenPolls = await h.db.execute<{ id: string }>(sql`
    SELECT id FROM polls ORDER BY question LIMIT 8
  `);
  pollIds = chosenPolls.rows.map((r) => r.id);

  // The planner works off statistics, so without this it would explain tables it believes are
  // empty - which is the same nothing the development database's 75 rows prove.
  await h.db.execute(sql`ANALYZE`);
}

beforeAll(async () => {
  h = await startTestDb();
  await seed();
  recordStatements(h.pool);
}, 180_000);

afterAll(async () => {
  await h?.stop().catch(() => undefined);
});

describe('a join-request decision does not scan the notifications table', () => {
  /*
   * Every request type, driven off the same map the production code reads its scope key from.
   *
   * A fourth type added to `REQUEST_SCOPE_KEY` and not to the index's predicate fails here
   * rather than silently reintroducing the full scan for that one type. That is the price of a
   * partial index whose predicate names its types, and this is what pays it.
   */
  for (const [type, key] of Object.entries(REQUEST_SCOPE_KEY)) {
    it(`uses an index for ${type}`, async () => {
      statements.length = 0;
      const resolved = await resolvePendingRequests(h.db, {
        type: type as keyof typeof REQUEST_SCOPE_KEY,
        scopeId: scopeIdFor(key),
        requesterId,
        decision: 'approved',
        decidedByName: 'Plan Tester',
      });
      // Behaviour first: the statement being explained has to be one that really matches rows,
      // or an index scan over nothing would look exactly like a pass.
      expect(resolved.resolved).toBeGreaterThan(0);

      const [update] = touching('notifications');
      expect(update).toBeDefined();
      await expectIndexed(update!, 'notifications', 'notifications_pending_request');
    });
  }
});

describe('a batch poll read does not scan the poll_votes table', () => {
  it('reads my own votes and every voter through an index', async () => {
    const ctx = await loadAccessContext(h.db, voterId);
    statements.length = 0;
    const views = await readPolls(h.db, ctx, pollIds);
    expect(views).toHaveLength(pollIds.length);

    const votes = touching('poll_votes');
    // Two of them: this caller's own votes across the batch, then the voter list for the polls
    // whose voters they may see. Both filter by `poll_id` and neither restates the partial
    // index's `NOT allow_multiple`, which is why neither could ever have used it.
    expect(votes).toHaveLength(2);
    for (const statement of votes) {
      await expectIndexed(statement, 'poll_votes', 'poll_votes_by_poll');
    }
  });

  it('finds a vote on a multiple-answer poll through an index rather than a scan', async () => {
    // `toggleVote` clears any existing vote with `WHERE poll_id = $1 AND user_id = $2`, and the
    // scope poll list asks the same question once per poll as an `EXISTS`. The partial unique
    // index can serve those only while the poll is single-choice; this is the other half.
    const multiPoll = await h.db.execute<{ id: string }>(sql`
      SELECT id FROM polls WHERE allow_multiple ORDER BY question LIMIT 1
    `);
    statements.length = 0;
    const found = await h.db.execute<{ option_id: string }>(sql`
      SELECT option_id FROM poll_votes
       WHERE poll_id = ${multiPoll.rows[0]!.id} AND user_id = ${voterId}
    `);
    expect(found.rows.length).toBeGreaterThan(0);

    const [lookup] = touching('poll_votes');
    expect(lookup).toBeDefined();
    await expectIndexed(lookup!, 'poll_votes', 'poll_votes_by_poll');
  });
});
