-- Proof that every domain invariant is enforced AT THE DATA LAYER.
--
-- SPEC/templates/migration-checklist.md requires attempting to violate each new
-- constraint directly in SQL and watching it be rejected. Reading the DDL and
-- concluding it looks right is not verification: a partial unique index with a
-- slightly wrong WHERE clause, or a unique index containing a nullable column,
-- both look correct and enforce nothing.
--
-- The harness fails loudly in the direction that matters. If a statement that
-- SHOULD be rejected succeeds, that is a raised exception and a non-zero exit -
-- a silent pass is the one outcome this file must never produce.
--
-- Everything runs inside a transaction that is rolled back, so this leaves no rows
-- behind and is safe to run against a development database repeatedly.
--
-- Run with:  npm run db:prove -w @clubchat/server

BEGIN;

CREATE FUNCTION pg_temp.assert_rejected(label text, stmt text) RETURNS void AS $fn$
BEGIN
  BEGIN
    EXECUTE stmt;
  EXCEPTION
    WHEN others THEN
      RAISE NOTICE 'PASS  rejected: %', label;
      RETURN;
  END;
  -- Reaching here means the statement was accepted, so the constraint is absent or
  -- does not cover this case. That is the defect this file exists to catch.
  RAISE EXCEPTION 'FAIL  constraint did not fire: %', label;
END
$fn$ LANGUAGE plpgsql;

CREATE FUNCTION pg_temp.assert_accepted(label text, stmt text) RETURNS void AS $fn$
BEGIN
  EXECUTE stmt;
  RAISE NOTICE 'PASS  accepted: %', label;
END
$fn$ LANGUAGE plpgsql;

-- A DEFERRED constraint does not fire when the statement runs, so `assert_rejected` would
-- report a pass for a trigger that never ran and then blow up at COMMIT - which in this file
-- means at the ROLLBACK, where nothing is watching. Forcing the check with SET CONSTRAINTS
-- ALL IMMEDIATE brings the failure back inside the block that is looking for it.
--
-- Both helpers restore the deferred setting afterwards, or every later assertion in the file
-- would be running under a different constraint mode than production does.
CREATE FUNCTION pg_temp.assert_rejected_at_commit(label text, stmt text) RETURNS void AS $fn$
BEGIN
  BEGIN
    EXECUTE stmt;
    SET CONSTRAINTS ALL IMMEDIATE;
  EXCEPTION
    WHEN others THEN
      SET CONSTRAINTS ALL DEFERRED;
      RAISE NOTICE 'PASS  rejected at commit: %', label;
      RETURN;
  END;
  SET CONSTRAINTS ALL DEFERRED;
  RAISE EXCEPTION 'FAIL  deferred constraint did not fire: %', label;
END
$fn$ LANGUAGE plpgsql;

CREATE FUNCTION pg_temp.assert_accepted_at_commit(label text, stmt text) RETURNS void AS $fn$
BEGIN
  EXECUTE stmt;
  SET CONSTRAINTS ALL IMMEDIATE;
  SET CONSTRAINTS ALL DEFERRED;
  RAISE NOTICE 'PASS  accepted at commit: %', label;
END
$fn$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------------
-- Fixtures
-- ---------------------------------------------------------------------------

INSERT INTO users (id, full_name, email) VALUES
  ('11111111-1111-4111-8111-111111111111', 'Alice', 'alice@test.invalid'),
  ('22222222-2222-4222-8222-222222222222', 'Bob',   'bob@test.invalid');

INSERT INTO clubs (id, name, invite_token, member_invite_token) VALUES
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'Test Running Club', 'tok-a', 'mtok-a');

INSERT INTO club_memberships (club_id, user_id, role) VALUES
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '11111111-1111-4111-8111-111111111111', 'owner');

INSERT INTO channels (id, club_id, scope, scope_id) VALUES
  ('cccccccc-cccc-4ccc-8ccc-cccccccccccc',
   'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'club',
   'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');

INSERT INTO messages (channel_id, seq, sender_id, type, body, client_msg_id) VALUES
  ('cccccccc-cccc-4ccc-8ccc-cccccccccccc', 1,
   '11111111-1111-4111-8111-111111111111', 'text', 'first',
   'dddddddd-dddd-4ddd-8ddd-dddddddddddd');

-- ---------------------------------------------------------------------------
-- Domain invariant 1: exactly one Owner per club, always
-- ---------------------------------------------------------------------------

SELECT pg_temp.assert_rejected(
  'invariant 1 - a second owner in the same club',
  $$INSERT INTO club_memberships (club_id, user_id, role)
    VALUES ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            '22222222-2222-4222-8222-222222222222', 'owner')$$);

SELECT pg_temp.assert_accepted(
  'invariant 1 - a second ADMIN is fine, only owner is capped',
  $$INSERT INTO club_memberships (club_id, user_id, role)
    VALUES ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            '22222222-2222-4222-8222-222222222222', 'admin')$$);

-- The ownership-transfer ordering rule, proved rather than remembered. The
-- one-owner constraint is checked per statement, so promoting before demoting
-- momentarily holds two owners and must fail. Transfer therefore demotes first.
SELECT pg_temp.assert_rejected(
  'ownership transfer - promote before demote must fail',
  $$UPDATE club_memberships SET role = 'owner'
     WHERE club_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
       AND user_id = '22222222-2222-4222-8222-222222222222'$$);

-- The half of invariant 1 the index does NOT hold, asserted here because assuming otherwise
-- is what let two concurrent role changes empty a club of owners (ADR-0042). A partial UNIQUE
-- index forbids a SECOND owner; it says nothing whatsoever about the FIRST, so zero owners
-- satisfies it perfectly - and an ownerless club has no recovery path, since transferring,
-- deleting and promoting are all Owner-only. Nothing below is a defect in the schema: it is
-- the boundary of what a unique index can express, written down where somebody reaching for
-- "the constraint will catch it" will read it.
--
-- What holds the other half is `domain/membership.ts`: every write there carries the role it
-- was authorized against in its WHERE clause, or holds the row with SELECT ... FOR UPDATE and
-- re-reads it. If a deferred constraint or a trigger is ever added, this assertion flips to
-- assert_rejected and this comment goes with it.
SELECT pg_temp.assert_accepted(
  'invariant 1 - a club with ZERO owners is accepted, which is why the domain layer guards it',
  $$UPDATE club_memberships SET role = 'admin'
     WHERE club_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
       AND user_id = '11111111-1111-4111-8111-111111111111'$$);

-- Restored for everything below, and the restore is the point made twice: the ONLY way back
-- from the state above is a promotion by somebody with the authority to make one, and in an
-- ownerless club nobody has it.
SELECT pg_temp.assert_accepted(
  'invariant 1 - promoting back into an ownerless club',
  $$UPDATE club_memberships SET role = 'owner'
     WHERE club_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
       AND user_id = '11111111-1111-4111-8111-111111111111'$$);

SELECT pg_temp.assert_rejected(
  'club_memberships - an invented role tier',
  $$INSERT INTO club_memberships (club_id, user_id, role)
    VALUES ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            '00000000-0000-4000-8000-000000000001', 'superadmin')$$);

-- ---------------------------------------------------------------------------
-- The two invite links (ADR-0025)
--
-- Both are unique, and the pair is what the whole rule rests on: which string was
-- redeemed decides whether the join policy applies. A collision between the two
-- columns is the one thing that would make that decision meaningless, so the
-- cross-column case is attempted explicitly rather than assumed from two separate
-- UNIQUE declarations - neither of which says anything about the other.
-- ---------------------------------------------------------------------------

SELECT pg_temp.assert_rejected(
  'clubs - a duplicate admin invite token',
  $$INSERT INTO clubs (name, invite_token, member_invite_token)
    VALUES ('Copycat', 'tok-a', 'mtok-unique')$$);

SELECT pg_temp.assert_rejected(
  'clubs - a duplicate member invite token',
  $$INSERT INTO clubs (name, invite_token, member_invite_token)
    VALUES ('Copycat', 'tok-unique', 'mtok-a')$$);

-- One club cannot hold the same string in both columns. Nothing in the DDL forbids
-- it, so this asserts the application never mints such a pair by proving what the
-- database WILL take - and pins the reason: two links that are the same string are
-- one link that quietly bypasses the join policy for everybody.
SELECT pg_temp.assert_accepted(
  'clubs - the database itself does not stop one club reusing its own token, so the app must not',
  $$INSERT INTO clubs (id, name, invite_token, member_invite_token)
    VALUES ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaab', 'Same String Club',
            'tok-same', 'tok-same')$$);

SELECT pg_temp.assert_accepted(
  'clubs - cleaning up that row so nothing below sees it',
  $$DELETE FROM clubs WHERE id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaab'$$);

-- ---------------------------------------------------------------------------
-- Domain invariant 2: exactly one main channel per club
-- ---------------------------------------------------------------------------

SELECT pg_temp.assert_rejected(
  'invariant 2 - a second club-scoped channel for one club',
  $$INSERT INTO channels (club_id, scope, scope_id)
    VALUES ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'club',
            'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')$$);

-- A race-scoped channel in the same club is fine, and must be: the partial index
-- has to be scoped to WHERE scope = 'club' or it would forbid this.
SELECT pg_temp.assert_accepted(
  'invariant 2 - a race-scoped channel in the same club is allowed',
  $$INSERT INTO channels (club_id, scope, scope_id)
    VALUES ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'race',
            'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee')$$);

SELECT pg_temp.assert_rejected(
  'channels - duplicate (scope, scope_id)',
  $$INSERT INTO channels (club_id, scope, scope_id)
    VALUES ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'race',
            'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee')$$);

-- ---------------------------------------------------------------------------
-- The dm nullability check: club_id is relaxed for one scope only
-- ---------------------------------------------------------------------------

SELECT pg_temp.assert_rejected(
  'dm check - a club-scoped channel with no club',
  $$INSERT INTO channels (club_id, scope, scope_id)
    VALUES (NULL, 'club', 'ffffffff-ffff-4fff-8fff-ffffffffffff')$$);

SELECT pg_temp.assert_rejected(
  'dm check - a dm channel that claims a club',
  $$INSERT INTO channels (club_id, scope, scope_id)
    VALUES ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'dm',
            'ffffffff-ffff-4fff-8fff-ffffffffffff')$$);

SELECT pg_temp.assert_accepted(
  'dm check - a clubless dm channel is allowed',
  $$INSERT INTO channels (club_id, scope, scope_id)
    VALUES (NULL, 'dm', 'ffffffff-ffff-4fff-8fff-ffffffffffff')$$);

SELECT pg_temp.assert_rejected(
  'channels - an invented scope',
  $$INSERT INTO channels (club_id, scope, scope_id)
    VALUES ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'tournament',
            '99999999-9999-4999-8999-999999999999')$$);

-- ---------------------------------------------------------------------------
-- The channel log: gapless ordering and idempotency
-- ---------------------------------------------------------------------------

SELECT pg_temp.assert_rejected(
  'channel log - two messages at the same seq in one channel',
  $$INSERT INTO messages (channel_id, seq, sender_id, type, body, client_msg_id)
    VALUES ('cccccccc-cccc-4ccc-8ccc-cccccccccccc', 1,
            '22222222-2222-4222-8222-222222222222', 'text', 'collides',
            '88888888-8888-4888-8888-888888888888')$$);

SELECT pg_temp.assert_rejected(
  'idempotency - the same client_msg_id resent by the same sender',
  $$INSERT INTO messages (channel_id, seq, sender_id, type, body, client_msg_id)
    VALUES ('cccccccc-cccc-4ccc-8ccc-cccccccccccc', 2,
            '11111111-1111-4111-8111-111111111111', 'text', 'retry',
            'dddddddd-dddd-4ddd-8ddd-dddddddddddd')$$);

-- The same client_msg_id from a DIFFERENT sender is a different message. Two
-- devices can independently generate the same UUID only by accident, and scoping
-- idempotency per sender is what keeps one member's retry from suppressing
-- another member's message.
SELECT pg_temp.assert_accepted(
  'idempotency - the same client_msg_id from a different sender is distinct',
  $$INSERT INTO messages (channel_id, seq, sender_id, type, body, client_msg_id)
    VALUES ('cccccccc-cccc-4ccc-8ccc-cccccccccccc', 2,
            '22222222-2222-4222-8222-222222222222', 'text', 'different sender',
            'dddddddd-dddd-4ddd-8ddd-dddddddddddd')$$);

SELECT pg_temp.assert_rejected(
  'channel log - seq must be positive, so 0 cannot masquerade as "no messages yet"',
  $$INSERT INTO messages (channel_id, seq, sender_id, type, body, client_msg_id)
    VALUES ('cccccccc-cccc-4ccc-8ccc-cccccccccccc', 0,
            '11111111-1111-4111-8111-111111111111', 'text', 'zero',
            '77777777-7777-4777-8777-777777777777')$$);

-- ---------------------------------------------------------------------------
-- Replies: a quote points at a real message in the SAME channel, said earlier
-- ---------------------------------------------------------------------------

SELECT pg_temp.assert_accepted(
  'reply - quoting an earlier message in the same channel',
  $$INSERT INTO messages (channel_id, seq, sender_id, type, body, client_msg_id, reply_to_seq)
    VALUES ('cccccccc-cccc-4ccc-8ccc-cccccccccccc', 3,
            '11111111-1111-4111-8111-111111111111', 'text', 'answering the first',
            '11111111-2222-4333-8444-555555555551', 1)$$);

SELECT pg_temp.assert_rejected(
  'reply - quoting a seq that does not exist',
  $$INSERT INTO messages (channel_id, seq, sender_id, type, body, client_msg_id, reply_to_seq)
    VALUES ('cccccccc-cccc-4ccc-8ccc-cccccccccccc', 4,
            '11111111-1111-4111-8111-111111111111', 'text', 'answering nothing',
            '11111111-2222-4333-8444-555555555552', 99)$$);

-- The composite foreign key is what makes this impossible, and it is the reason the
-- reference is (channel_id, seq) rather than a message id. With an id reference this
-- insert would succeed and the read that draws the quote would have to re-check the
-- channel itself - the same predicate written in a second place.
INSERT INTO channels (id, club_id, scope, scope_id) VALUES
  ('c2c2c2c2-cccc-4ccc-8ccc-cccccccccccc',
   'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'race',
   'e2e2e2e2-eeee-4eee-8eee-eeeeeeeeeeee');

SELECT pg_temp.assert_rejected(
  'reply - quoting a message that lives in another channel',
  $$INSERT INTO messages (channel_id, seq, sender_id, type, body, client_msg_id, reply_to_seq)
    VALUES ('c2c2c2c2-cccc-4ccc-8ccc-cccccccccccc', 1,
            '11111111-1111-4111-8111-111111111111', 'text', 'reaching across',
            '11111111-2222-4333-8444-555555555553', 1)$$);

-- A self-referencing foreign key is satisfied by the row being inserted, so the FK alone
-- would accept a message quoting itself. The check constraint is what rules it out.
SELECT pg_temp.assert_rejected(
  'reply - a message quoting itself',
  $$INSERT INTO messages (channel_id, seq, sender_id, type, body, client_msg_id, reply_to_seq)
    VALUES ('cccccccc-cccc-4ccc-8ccc-cccccccccccc', 5,
            '11111111-1111-4111-8111-111111111111', 'text', 'quoting myself',
            '11111111-2222-4333-8444-555555555554', 5)$$);

SELECT pg_temp.assert_rejected(
  'reply - quoting a message that has not been said yet',
  $$INSERT INTO messages (channel_id, seq, sender_id, type, body, client_msg_id, reply_to_seq)
    VALUES ('cccccccc-cccc-4ccc-8ccc-cccccccccccc', 6,
            '11111111-1111-4111-8111-111111111111', 'text', 'answering the future',
            '11111111-2222-4333-8444-555555555555', 7)$$);

-- ---------------------------------------------------------------------------
-- Domain invariant 10: deleting an account anonymises, it does not remove content
-- ---------------------------------------------------------------------------

-- messages.sender_id is ON DELETE RESTRICT specifically so that a hard delete of a
-- user who has posted is impossible at the database level. Deletion must go through
-- the anonymise path, which keeps their messages in their conversations so history
-- stays readable.
SELECT pg_temp.assert_rejected(
  'invariant 10 - hard-deleting a user who has posted messages',
  $$DELETE FROM users WHERE id = '11111111-1111-4111-8111-111111111111'$$);

-- ---------------------------------------------------------------------------
-- Read cursors
-- ---------------------------------------------------------------------------

SELECT pg_temp.assert_accepted(
  'read cursor - one row per (user, channel)',
  $$INSERT INTO read_cursors (user_id, channel_id, last_read_seq)
    VALUES ('11111111-1111-4111-8111-111111111111',
            'cccccccc-cccc-4ccc-8ccc-cccccccccccc', 1)$$);

SELECT pg_temp.assert_rejected(
  'read cursor - a second row for the same (user, channel)',
  $$INSERT INTO read_cursors (user_id, channel_id, last_read_seq)
    VALUES ('11111111-1111-4111-8111-111111111111',
            'cccccccc-cccc-4ccc-8ccc-cccccccccccc', 2)$$);

-- ---------------------------------------------------------------------------
-- Eboard
-- ---------------------------------------------------------------------------

SELECT pg_temp.assert_accepted(
  'eboard - one space per club',
  $$INSERT INTO eboard_channels (id, club_id)
    VALUES ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
            'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')$$);

SELECT pg_temp.assert_rejected(
  'eboard - a second space for the same club',
  $$INSERT INTO eboard_channels (club_id)
    VALUES ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')$$);

-- Rejoin requests, added in Phase 3.75a. Shaped exactly like the club and race request tables,
-- so the same three properties are proved here: one pending row per person, a denied request can
-- be re-filed, and an invented status cannot be stored.
SELECT pg_temp.assert_accepted(
  'eboard requests - a first pending request',
  $$INSERT INTO eboard_join_requests (eboard_id, user_id)
    VALUES ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
            '22222222-2222-4222-8222-222222222222')$$);

SELECT pg_temp.assert_rejected(
  'eboard requests - a second pending request from the same person',
  $$INSERT INTO eboard_join_requests (eboard_id, user_id)
    VALUES ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
            '22222222-2222-4222-8222-222222222222')$$);

SELECT pg_temp.assert_rejected(
  'eboard requests - an invented status',
  $$INSERT INTO eboard_join_requests (eboard_id, user_id, status)
    VALUES ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
            '33333333-3333-4333-8333-333333333333', 'maybe')$$);

-- The partial index is scoped to pending precisely so this works: somebody turned down once is
-- not barred forever.
SELECT pg_temp.assert_accepted(
  'eboard requests - re-filing after a denial',
  $$WITH denied AS (
      UPDATE eboard_join_requests SET status = 'denied'
       WHERE eboard_id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
         AND user_id = '22222222-2222-4222-8222-222222222222'
      RETURNING 1
    )
    INSERT INTO eboard_join_requests (eboard_id, user_id)
    SELECT 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
           '22222222-2222-4222-8222-222222222222'
      FROM denied$$);

-- ---------------------------------------------------------------------------
-- Phase 1: notifications, devices, mutes
-- ---------------------------------------------------------------------------

INSERT INTO notifications (recipient_id, actor_id, club_id, type, params, outbox_event_id)
VALUES ('11111111-1111-4111-8111-111111111111',
        '22222222-2222-4222-8222-222222222222',
        'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        'announcement', '{"preview":"hi"}'::jsonb, 4242);

-- At-least-once delivery WILL redeliver an outbox event. Without this the second pass
-- fans out a duplicate of every notification the first pass produced.
SELECT pg_temp.assert_rejected(
  'notifications - the same outbox event fanning out twice to one recipient',
  $$INSERT INTO notifications (recipient_id, type, params, outbox_event_id)
    VALUES ('11111111-1111-4111-8111-111111111111',
            'announcement', '{"preview":"hi again"}'::jsonb, 4242)$$);

-- The same event reaching a DIFFERENT recipient is a different notification, so the
-- index must be scoped per recipient rather than per event.
SELECT pg_temp.assert_accepted(
  'notifications - the same event to a different recipient is distinct',
  $$INSERT INTO notifications (recipient_id, type, params, outbox_event_id)
    VALUES ('22222222-2222-4222-8222-222222222222',
            'announcement', '{"preview":"hi"}'::jsonb, 4242)$$);

-- outbox_event_id must be supplied, not defaulted. It was bigserial in the first draft
-- of this migration, which would have silently handed out sequence values and defeated
-- the idempotency index above.
SELECT pg_temp.assert_rejected(
  'notifications - outbox_event_id has no default to fall back on',
  $$INSERT INTO notifications (recipient_id, type, params)
    VALUES ('11111111-1111-4111-8111-111111111111', 'announcement', '{}'::jsonb)$$);

INSERT INTO devices (id, user_id, push_token, platform) VALUES
  ('dddd0000-dddd-4ddd-8ddd-dddddddddddd',
   '11111111-1111-4111-8111-111111111111', 'ExponentPushToken[aaa]', 'ios');

-- One physical device, one row. Otherwise re-registering the same token gives that
-- phone N copies of every push.
SELECT pg_temp.assert_rejected(
  'devices - the same push token registered twice',
  $$INSERT INTO devices (user_id, push_token, platform)
    VALUES ('22222222-2222-4222-8222-222222222222', 'ExponentPushToken[aaa]', 'android')$$);

SELECT pg_temp.assert_rejected(
  'devices - an invented platform',
  $$INSERT INTO devices (user_id, push_token, platform)
    VALUES ('11111111-1111-4111-8111-111111111111', 'ExponentPushToken[bbb]', 'blackberry')$$);

INSERT INTO push_deliveries (outbox_event_id, device_id)
VALUES (4242, 'dddd0000-dddd-4ddd-8ddd-dddddddddddd');

-- A duplicated database row can be cleaned up. A duplicated push has already buzzed
-- somebody's phone and cannot be taken back, which is why this ledger exists.
SELECT pg_temp.assert_rejected(
  'push_deliveries - pushing the same event to the same device twice',
  $$INSERT INTO push_deliveries (outbox_event_id, device_id)
    VALUES (4242, 'dddd0000-dddd-4ddd-8ddd-dddddddddddd')$$);

INSERT INTO channel_mutes (user_id, channel_id)
VALUES ('11111111-1111-4111-8111-111111111111', 'cccccccc-cccc-4ccc-8ccc-cccccccccccc');

SELECT pg_temp.assert_rejected(
  'channel_mutes - one mute per (user, channel)',
  $$INSERT INTO channel_mutes (user_id, channel_id)
    VALUES ('11111111-1111-4111-8111-111111111111',
            'cccccccc-cccc-4ccc-8ccc-cccccccccccc')$$);

INSERT INTO message_mentions (message_id, user_id)
SELECT id, '22222222-2222-4222-8222-222222222222' FROM messages
 WHERE channel_id = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' AND seq = 1;

SELECT pg_temp.assert_rejected(
  'message_mentions - mentioning the same person twice in one message',
  $$INSERT INTO message_mentions (message_id, user_id)
    SELECT id, '22222222-2222-4222-8222-222222222222' FROM messages
     WHERE channel_id = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' AND seq = 1$$);

-- ---------------------------------------------------------------------------
-- Join requests: idempotent decisions, and a refusal that is not permanent
-- ---------------------------------------------------------------------------

INSERT INTO club_join_requests (club_id, user_id)
VALUES ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '22222222-2222-4222-8222-222222222222');

-- Two admins hitting Approve must produce ONE membership, one notification and one
-- recorded decider. The partial index is what makes the decision idempotent.
SELECT pg_temp.assert_rejected(
  'join requests - a second pending request from the same person',
  $$INSERT INTO club_join_requests (club_id, user_id)
    VALUES ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            '22222222-2222-4222-8222-222222222222')$$);

-- Scoped to `pending` on purpose. A plain UNIQUE would permanently bar anyone who was ever
-- turned down, so a denied request must be re-fileable.
SELECT pg_temp.assert_accepted(
  'join requests - re-filing after a denial is allowed',
  $$UPDATE club_join_requests SET status = 'denied', decided_at = now()
     WHERE club_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
       AND user_id = '22222222-2222-4222-8222-222222222222'$$);

SELECT pg_temp.assert_accepted(
  'join requests - a fresh request after a denial',
  $$INSERT INTO club_join_requests (club_id, user_id)
    VALUES ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            '22222222-2222-4222-8222-222222222222')$$);

SELECT pg_temp.assert_rejected(
  'join requests - an invented status',
  $$INSERT INTO club_join_requests (club_id, user_id, status)
    VALUES ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            '00000000-0000-4000-8000-000000000001', 'maybe')$$);

-- ---------------------------------------------------------------------------
-- Phase 2: the two invariants the DATABASE enforces via composite foreign keys
-- ---------------------------------------------------------------------------

INSERT INTO races (id, club_id, name, race_date) VALUES
  ('11110000-1111-4111-8111-111111111111',
   'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'Spring Half', '2026-04-12'),
  ('22220000-2222-4222-8222-222222222222',
   'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'Autumn 10k', '2026-10-04');

INSERT INTO car_groups (id, race_id, number) VALUES
  ('ca110000-1111-4111-8111-111111111111', '11110000-1111-4111-8111-111111111111', 1),
  ('ca120000-1111-4111-8111-111111111111', '11110000-1111-4111-8111-111111111111', 2),
  ('ca210000-2222-4222-8222-222222222222', '22220000-2222-4222-8222-222222222222', 1);

INSERT INTO car_group_members (car_group_id, race_id, user_id) VALUES
  ('ca110000-1111-4111-8111-111111111111', '11110000-1111-4111-8111-111111111111',
   '11111111-1111-4111-8111-111111111111');

-- Domain invariant 5.
SELECT pg_temp.assert_rejected(
  'invariant 5 - the same person in two car groups for one race',
  $$INSERT INTO car_group_members (car_group_id, race_id, user_id)
    VALUES ('ca120000-1111-4111-8111-111111111111',
            '11110000-1111-4111-8111-111111111111',
            '11111111-1111-4111-8111-111111111111')$$);

-- One group per RACE, not one group ever. The same person travelling to a different race
-- is a different assignment.
SELECT pg_temp.assert_accepted(
  'invariant 5 - a group in a DIFFERENT race is allowed',
  $$INSERT INTO car_group_members (car_group_id, race_id, user_id)
    VALUES ('ca210000-2222-4222-8222-222222222222',
            '22220000-2222-4222-8222-222222222222',
            '11111111-1111-4111-8111-111111111111')$$);

-- THE POINT OF THE COMPOSITE FK. The denormalised race_id cannot be made to disagree with
-- the group's actual race. Without this, the unique index above would be guarding a lie:
-- a handler could write a mismatched race_id and slip a second group past it.
SELECT pg_temp.assert_rejected(
  'composite FK - a car_group_member whose race_id does not match its group',
  $$INSERT INTO car_group_members (car_group_id, race_id, user_id)
    VALUES ('ca110000-1111-4111-8111-111111111111',
            '22220000-2222-4222-8222-222222222222',
            '22222222-2222-4222-8222-222222222222')$$);

INSERT INTO polls (id, club_id, scope, scope_id, creator_id, question, allow_multiple) VALUES
  ('fa110000-1111-4111-8111-111111111111',
   'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'club',
   'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
   '11111111-1111-4111-8111-111111111111', 'Carpool or bus?', false),
  ('fa220000-2222-4222-8222-222222222222',
   'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'club',
   '11110000-1111-4111-8111-111111111111',
   '11111111-1111-4111-8111-111111111111', 'Which kit colours?', true);

INSERT INTO poll_options (id, poll_id, label, position) VALUES
  ('fb110000-1111-4111-8111-111111111111', 'fa110000-1111-4111-8111-111111111111', 'Carpool', 1),
  ('fb120000-1111-4111-8111-111111111111', 'fa110000-1111-4111-8111-111111111111', 'Bus', 2),
  ('fb210000-2222-4222-8222-222222222222', 'fa220000-2222-4222-8222-222222222222', 'Navy', 1),
  ('fb220000-2222-4222-8222-222222222222', 'fa220000-2222-4222-8222-222222222222', 'Orange', 2);

INSERT INTO poll_votes (poll_id, option_id, user_id, allow_multiple) VALUES
  ('fa110000-1111-4111-8111-111111111111', 'fb110000-1111-4111-8111-111111111111',
   '11111111-1111-4111-8111-111111111111', false);

-- "Tapping a different option MOVES the vote rather than adding a second" is guaranteed by
-- the database on a single-choice poll, not merely implemented in the handler.
SELECT pg_temp.assert_rejected(
  'single-choice poll - a second vote by the same member',
  $$INSERT INTO poll_votes (poll_id, option_id, user_id, allow_multiple)
    VALUES ('fa110000-1111-4111-8111-111111111111',
            'fb120000-1111-4111-8111-111111111111',
            '11111111-1111-4111-8111-111111111111', false)$$);

-- A multi-select poll must still allow the second vote, which is why the index is partial.
SELECT pg_temp.assert_accepted(
  'multi-select poll - a second vote is allowed',
  $$INSERT INTO poll_votes (poll_id, option_id, user_id, allow_multiple)
    VALUES ('fa220000-2222-4222-8222-222222222222',
            'fb210000-2222-4222-8222-222222222222',
            '11111111-1111-4111-8111-111111111111', true),
           ('fa220000-2222-4222-8222-222222222222',
            'fb220000-2222-4222-8222-222222222222',
            '11111111-1111-4111-8111-111111111111', true)$$);

-- The composite FK again: a vote cannot lie about its poll's multi-select setting to escape
-- the single-choice index.
SELECT pg_temp.assert_rejected(
  'composite FK - a vote claiming allow_multiple its poll does not have',
  $$INSERT INTO poll_votes (poll_id, option_id, user_id, allow_multiple)
    VALUES ('fa110000-1111-4111-8111-111111111111',
            'fb120000-1111-4111-8111-111111111111',
            '22222222-2222-4222-8222-222222222222', true)$$);

SELECT pg_temp.assert_rejected(
  'poll options - two options at the same position',
  $$INSERT INTO poll_options (poll_id, label, position)
    VALUES ('fa110000-1111-4111-8111-111111111111', 'Train', 1)$$);

SELECT pg_temp.assert_rejected(
  'polls - an invented scope',
  $$INSERT INTO polls (club_id, scope, scope_id, creator_id, question)
    VALUES ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'tournament',
            'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            '11111111-1111-4111-8111-111111111111', 'nope')$$);

-- Seven photographs to build galleries out of. `ready`, because a post only ever references an
-- object that finished uploading.
INSERT INTO media_objects (id, owner_type, uploader_id, bucket, object_key, mime, bytes, status)
SELECT ('dddddddd-dddd-4ddd-8ddd-00000000000' || n)::uuid,
       'news_post', '11111111-1111-4111-8111-111111111111',
       'content', 'news/' || n, 'image/jpeg', 1000, 'ready'
FROM generate_series(0, 6) AS n;

-- PRD/06 rule 1: a post must have a title, body text, or at least one photo.
--
-- **These are the deferred ones.** The rule spans `news_posts` and `news_post_media`, so it is a
-- CONSTRAINT TRIGGER rather than a CHECK and it does not fire until the transaction ends. Proving
-- it with `assert_rejected` would prove nothing - the INSERT succeeds, and the trigger would take
-- the ROLLBACK down instead, where no assertion is looking.
SELECT pg_temp.assert_rejected_at_commit(
  'news - an entirely empty post',
  $$INSERT INTO news_posts (club_id, author_id)
    VALUES ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            '11111111-1111-4111-8111-111111111111')$$);

SELECT pg_temp.assert_accepted_at_commit(
  'news - body only is a valid post',
  $$INSERT INTO news_posts (club_id, author_id, body)
    VALUES ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            '11111111-1111-4111-8111-111111111111', 'We won.')$$);

SELECT pg_temp.assert_accepted_at_commit(
  'news - title only is a valid post',
  $$INSERT INTO news_posts (club_id, author_id, title)
    VALUES ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            '11111111-1111-4111-8111-111111111111', 'Evening Run in Binghamton')$$);

-- A photo-only post: the case the trigger has to be DEFERRED for. The post is inserted before
-- the photo that makes it valid can reference it, so an immediate check would refuse it here.
SELECT pg_temp.assert_accepted_at_commit(
  'news - photo only is a valid post',
  $$WITH p AS (
      INSERT INTO news_posts (id, club_id, author_id)
      VALUES ('bbbbbbbb-0000-4000-8000-000000000001',
              'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
              '11111111-1111-4111-8111-111111111111')
      RETURNING id)
    INSERT INTO news_post_media (post_id, media_id, ordinal)
    SELECT id, 'dddddddd-dddd-4ddd-8ddd-000000000000', 0 FROM p$$);

-- ...and it stops being valid the moment that photo goes, which is the other direction the rule
-- can be broken in and the reason there is a trigger on the media table too.
SELECT pg_temp.assert_rejected_at_commit(
  'news - removing the last photo from a photo-only post',
  $$DELETE FROM news_post_media
    WHERE post_id = 'bbbbbbbb-0000-4000-8000-000000000001'$$);

-- ADR-0038: six photos, and the cap is a consequence of the primary key rather than a count.
INSERT INTO news_posts (id, club_id, author_id, body)
VALUES ('bbbbbbbb-0000-4000-8000-000000000002',
        'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        '11111111-1111-4111-8111-111111111111', 'Six of them.');

SELECT pg_temp.assert_accepted(
  'news - six photos in one post',
  $$INSERT INTO news_post_media (post_id, media_id, ordinal)
    SELECT 'bbbbbbbb-0000-4000-8000-000000000002',
           ('dddddddd-dddd-4ddd-8ddd-00000000000' || n)::uuid, n
    FROM generate_series(0, 5) AS n$$);

SELECT pg_temp.assert_rejected(
  'news - a seventh photo has no ordinal to sit at',
  $$INSERT INTO news_post_media (post_id, media_id, ordinal)
    VALUES ('bbbbbbbb-0000-4000-8000-000000000002',
            'dddddddd-dddd-4ddd-8ddd-000000000006', 6)$$);

SELECT pg_temp.assert_rejected(
  'news - the same photo twice in one carousel',
  $$INSERT INTO news_post_media (post_id, media_id, ordinal)
    VALUES ('bbbbbbbb-0000-4000-8000-000000000002',
            'dddddddd-dddd-4ddd-8ddd-000000000000', 5)$$);

SELECT pg_temp.assert_rejected(
  'news - an aspect ratio the carousel cannot draw',
  $$UPDATE news_posts SET aspect = '3:2'
    WHERE id = 'bbbbbbbb-0000-4000-8000-000000000002'$$);

-- ADR-0039: a link with no name is data the card can never reach, since the row is drawn from
-- the name.
SELECT pg_temp.assert_rejected(
  'news - a location link with nothing to attach it to',
  $$UPDATE news_posts SET location_url = 'https://maps.example.invalid/x'
    WHERE id = 'bbbbbbbb-0000-4000-8000-000000000002'$$);

SELECT pg_temp.assert_accepted(
  'news - a location name and link together',
  $$UPDATE news_posts
    SET location_name = 'Lincoln Memorial, Washington DC',
        location_url = 'https://maps.example.invalid/x'
    WHERE id = 'bbbbbbbb-0000-4000-8000-000000000002'$$);

-- Tags are stored lowercased, or a club's own vocabulary splits by whoever typed it first.
SELECT pg_temp.assert_rejected(
  'news tags - a tag carrying capitals',
  $$INSERT INTO news_post_tags (post_id, tag)
    VALUES ('bbbbbbbb-0000-4000-8000-000000000002', 'longRun')$$);

SELECT pg_temp.assert_rejected(
  'news tags - the empty tag',
  $$INSERT INTO news_post_tags (post_id, tag)
    VALUES ('bbbbbbbb-0000-4000-8000-000000000002', '')$$);

SELECT pg_temp.assert_accepted(
  'news tags - a normalised tag',
  $$INSERT INTO news_post_tags (post_id, tag)
    VALUES ('bbbbbbbb-0000-4000-8000-000000000002', 'longrun')$$);

-- One post to react to, with an id of its own.
--
-- **These statements used to read `FROM news_posts LIMIT 1`**, which was deterministic only
-- because the fixtures held exactly one post. The gallery work above added four more, and the
-- last two assertions in this block only mean anything if they land on the SAME post - an
-- unordered LIMIT 1 does not promise that, so the pair would have started passing for the wrong
-- reason on whichever day the planner changed its mind.
INSERT INTO news_posts (id, club_id, author_id, body)
VALUES ('bbbbbbbb-0000-4000-8000-000000000003',
        'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        '11111111-1111-4111-8111-111111111111', 'React to me.');

-- PRD/06 rule 4: news reactions use the same emoji set as chat. The set became the whole
-- catalog on 2026-08-13 (ADR-0028) and the rule survives, because both tables key into the
-- SAME table - which is the point of it being a table. The property being proved is unchanged
-- from when this was a six-value check: the column renders directly into every client, and no
-- write path may widen it.
SELECT pg_temp.assert_rejected(
  'news reactions - arbitrary text in the emoji column',
  $$INSERT INTO news_reactions (post_id, user_id, emoji)
    SELECT id, '11111111-1111-4111-8111-111111111111', 'nice one' FROM news_posts WHERE id = 'bbbbbbbb-0000-4000-8000-000000000003'$$);

-- The normalisation half, and the reason the catalog is worth having. These two strings are
-- the same emoji to a reader and different bytes to the primary key. Exactly one is canonical,
-- so a client sending the other is refused at the boundary rather than creating a second pill
-- with a count of one - which is the failure PRD/05 recorded and this dissolves.
SELECT pg_temp.assert_rejected(
  'news reactions - a thumbs up WITHOUT the variation selector the catalog carries',
  $$INSERT INTO news_reactions (post_id, user_id, emoji)
    SELECT id, '11111111-1111-4111-8111-111111111111', '👍' FROM news_posts WHERE id = 'bbbbbbbb-0000-4000-8000-000000000003'$$);

SELECT pg_temp.assert_accepted(
  'news reactions - the canonical thumbs up',
  $$INSERT INTO news_reactions (post_id, user_id, emoji)
    SELECT id, '11111111-1111-4111-8111-111111111111', '👍️' FROM news_posts WHERE id = 'bbbbbbbb-0000-4000-8000-000000000003'$$);

SELECT pg_temp.assert_accepted(
  'news reactions - an emoji that was NOT one of the six',
  $$INSERT INTO news_reactions (post_id, user_id, emoji)
    SELECT id, '11111111-1111-4111-8111-111111111111', '🦄' FROM news_posts WHERE id = 'bbbbbbbb-0000-4000-8000-000000000003'$$);

-- The duplicate assertion below needs a row to duplicate, so this one earns its place twice.
SELECT pg_temp.assert_accepted(
  'news reactions - one of the six still works',
  $$INSERT INTO news_reactions (post_id, user_id, emoji)
    SELECT id, '11111111-1111-4111-8111-111111111111', '🔥' FROM news_posts WHERE id = 'bbbbbbbb-0000-4000-8000-000000000003'$$);

SELECT pg_temp.assert_rejected(
  'news reactions - the same emoji twice from the same member',
  $$INSERT INTO news_reactions (post_id, user_id, emoji)
    SELECT id, '11111111-1111-4111-8111-111111111111', '🔥' FROM news_posts WHERE id = 'bbbbbbbb-0000-4000-8000-000000000003'$$);

-- Weekly Meetups has no activity-type CHECK left to prove. ADR-0029 deleted the field rather
-- than generalising it, so the invariants that remain are that a meetup answers WHERE and WHEN.
-- The absence of a type assertion here is the decision, not a dropped test.
-- The place stopped being required on 2026-08-15 and the NAME took its place: the form asks for
-- a link rather than a place, and something still has to name a meetup. So the assertion that
-- used to be here - an insert with no location is rejected - is deliberately gone rather than
-- dropped, and this is the same invariant pointed at the column that now carries it.
SELECT pg_temp.assert_rejected(
  'meetups - no name',
  $$INSERT INTO meetups (club_id, meetup_date, meetup_time, title)
    VALUES ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '2026-04-01', '18:00', NULL)$$);

SELECT pg_temp.assert_rejected(
  'meetups - no time',
  $$INSERT INTO meetups (club_id, meetup_date, meetup_time, title)
    VALUES ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '2026-04-01', NULL, 'Track session')$$);

-- Nudge is rate limited by an EXCLUDE constraint, not by a check in a handler, because two
-- admins tapping the bell in the same second is exactly what a read-then-write loses (ADR-0030).
-- The window is per MEETUP since ADR-0031, which is what the second and third inserts prove
-- together: the same meetup twice is refused, a different meetup in the same hour is not.
INSERT INTO meetups (id, club_id, meetup_date, meetup_time, title) VALUES
  ('dddddddd-dddd-4ddd-8ddd-dddddddddddd',
   'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '2026-04-01', '06:30', 'Track'),
  ('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
   'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '2026-04-01', '19:00', 'The Anchor');

SELECT pg_temp.assert_accepted(
  'nudge - the first one for a meetup',
  $$INSERT INTO meetup_nudges (club_id, meetup_id)
    VALUES ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'dddddddd-dddd-4ddd-8ddd-dddddddddddd')$$);

SELECT pg_temp.assert_rejected(
  'nudge - the SAME meetup again inside the hour',
  $$INSERT INTO meetup_nudges (club_id, meetup_id)
    VALUES ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'dddddddd-dddd-4ddd-8ddd-dddddddddddd')$$);

-- The morning run and the evening social are two things to tell people about. This is the whole
-- point of ADR-0031 and would have been REJECTED under the per-club rule it replaced.
SELECT pg_temp.assert_accepted(
  'nudge - a DIFFERENT meetup in the same hour, same club',
  $$INSERT INTO meetup_nudges (club_id, meetup_id)
    VALUES ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee')$$);

-- ...and the window really is an hour rather than "any two rows", so a nudge whose hour has
-- already passed does not block the next one.
SELECT pg_temp.assert_accepted(
  'nudge - the same meetup again once the hour is up',
  $$INSERT INTO meetup_nudges (club_id, meetup_id, created_at, cooldown_until)
    VALUES ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
            now() + interval '2 hours', now() + interval '3 hours')$$);

-- A day holds as many meetups as the club needs. There is deliberately NO unique key on
-- (club_id, meetup_date), and this is what proves it: a morning session and an evening social
-- on one day must both be accepted.
SELECT pg_temp.assert_accepted(
  'meetups - two on the same day',
  $$INSERT INTO meetups (club_id, meetup_date, meetup_time, title) VALUES
      ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '2026-04-01', '06:30', 'Morning miles'),
      ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '2026-04-01', '19:00', 'Evening social')$$);

SELECT pg_temp.assert_rejected(
  'calendar - an invented event type',
  $$INSERT INTO calendar_events (club_id, type, title, starts_at)
    VALUES ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'wedding', 'nope', now())$$);

SELECT pg_temp.assert_rejected(
  'car groups - two groups numbered the same in one race',
  $$INSERT INTO car_groups (race_id, number)
    VALUES ('11110000-1111-4111-8111-111111111111', 1)$$);

SELECT pg_temp.assert_rejected(
  'race pins - pinning the same race twice for one member',
  $$INSERT INTO race_pins (race_id, user_id) VALUES
    ('11110000-1111-4111-8111-111111111111', '11111111-1111-4111-8111-111111111111'),
    ('11110000-1111-4111-8111-111111111111', '11111111-1111-4111-8111-111111111111')$$);

-- ---------------------------------------------------------------------------
-- Reactions: the emoji catalog, enforced by the database
-- ---------------------------------------------------------------------------

-- The whole point of the foreign key, and it is the same point the check constraint made
-- before the set was opened on 2026-08-13 (ADR-0028). A handler that forgot to validate, or a
-- second write path that never knew it had to, cannot put arbitrary text in this column -
-- which matters because the column renders directly into every client.
SELECT pg_temp.assert_rejected(
  'reactions - arbitrary text in the emoji column',
  $$INSERT INTO message_reactions (message_id, user_id, emoji)
    SELECT id, '11111111-1111-4111-8111-111111111111', 'lgtm' FROM messages LIMIT 1$$);

-- Text with an emoji in front of it, which is the shape a naive "starts with an emoji" check
-- admits. The catalog has no opinion to be fooled: the whole string either is a row or is not.
SELECT pg_temp.assert_rejected(
  'reactions - an emoji followed by a sentence',
  $$INSERT INTO message_reactions (message_id, user_id, emoji)
    SELECT id, '11111111-1111-4111-8111-111111111111', '🔥 and here is my opinion'
    FROM messages LIMIT 1$$);

-- Normalisation, which is the reason this is a catalog rather than a validator. These are the
-- same emoji to a reader and different bytes to the primary key; exactly one is canonical, so
-- the other cannot become a second pill with a count of one.
SELECT pg_temp.assert_rejected(
  'reactions - a thumbs up WITHOUT the variation selector the catalog carries',
  $$INSERT INTO message_reactions (message_id, user_id, emoji)
    SELECT id, '11111111-1111-4111-8111-111111111111', '👍' FROM messages LIMIT 1$$);

SELECT pg_temp.assert_accepted(
  'reactions - the canonical thumbs up',
  $$INSERT INTO message_reactions (message_id, user_id, emoji)
    SELECT id, '11111111-1111-4111-8111-111111111111', '👍️' FROM messages LIMIT 1$$);

-- What the change is FOR: an emoji that was not one of the six is now a reaction.
SELECT pg_temp.assert_accepted(
  'reactions - an emoji outside the old fixed six',
  $$INSERT INTO message_reactions (message_id, user_id, emoji)
    SELECT id, '11111111-1111-4111-8111-111111111111', '🦄' FROM messages LIMIT 1$$);

SELECT pg_temp.assert_accepted(
  'reactions - one of the six still works',
  $$INSERT INTO message_reactions (message_id, user_id, emoji)
    SELECT id, '11111111-1111-4111-8111-111111111111', '🔥' FROM messages LIMIT 1$$);

-- A member may add several DIFFERENT emoji to one message. The primary key includes the
-- emoji precisely so this is allowed while the same one twice is not.
SELECT pg_temp.assert_accepted(
  'reactions - a second, different emoji from the same member',
  $$INSERT INTO message_reactions (message_id, user_id, emoji)
    SELECT id, '11111111-1111-4111-8111-111111111111', '🎉' FROM messages LIMIT 1$$);

SELECT pg_temp.assert_rejected(
  'reactions - the same emoji twice from the same member',
  $$INSERT INTO message_reactions (message_id, user_id, emoji)
    SELECT id, '11111111-1111-4111-8111-111111111111', '🔥' FROM messages LIMIT 1$$);

-- ---------------------------------------------------------------------------
-- Phase 3.5: direct messages, blocking, reports
-- ---------------------------------------------------------------------------

INSERT INTO users (id, full_name, email) VALUES
  ('33333333-3333-4333-8333-333333333333', 'Carol', 'carol@test.invalid');

-- Alice (1111) < Bob (2222) < Carol (3333) as uuids, which is what makes the canonical
-- ordering assertions below readable.
INSERT INTO dm_conversations (id, user_a, user_b) VALUES
  ('d1d1d1d1-d1d1-4d1d-8d1d-d1d1d1d1d1d1',
   '11111111-1111-4111-8111-111111111111',
   '22222222-2222-4222-8222-222222222222');

INSERT INTO channels (id, club_id, scope, scope_id) VALUES
  ('c1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1c1', NULL, 'dm',
   'd1d1d1d1-d1d1-4d1d-8d1d-d1d1d1d1d1d1');

INSERT INTO messages (id, channel_id, seq, sender_id, type, body, client_msg_id) VALUES
  ('e1e1e1e1-e1e1-4e1e-8e1e-e1e1e1e1e1e1',
   'c1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1c1', 1,
   '11111111-1111-4111-8111-111111111111', 'text', 'can you drive saturday',
   'f1f1f1f1-f1f1-4f1f-8f1f-f1f1f1f1f1f1');

-- PRD/14 rule 2: exactly one thread per pair of people, ever. The reverse ordering is the
-- case that matters - two people racing to open a thread with each other would otherwise get
-- one row each, and UNIQUE (user_a, user_b) would happily allow both.
SELECT pg_temp.assert_rejected(
  'dm conversations - the same pair stored in reverse order',
  $$INSERT INTO dm_conversations (user_a, user_b)
    VALUES ('22222222-2222-4222-8222-222222222222',
            '11111111-1111-4111-8111-111111111111')$$);

SELECT pg_temp.assert_rejected(
  'dm conversations - the same pair twice',
  $$INSERT INTO dm_conversations (user_a, user_b)
    VALUES ('11111111-1111-4111-8111-111111111111',
            '22222222-2222-4222-8222-222222222222')$$);

SELECT pg_temp.assert_rejected(
  'dm conversations - a conversation with oneself',
  $$INSERT INTO dm_conversations (user_a, user_b)
    VALUES ('11111111-1111-4111-8111-111111111111',
            '11111111-1111-4111-8111-111111111111')$$);

SELECT pg_temp.assert_accepted(
  'dm conversations - a different pair, canonically ordered',
  $$INSERT INTO dm_conversations (user_a, user_b)
    VALUES ('11111111-1111-4111-8111-111111111111',
            '33333333-3333-4333-8333-333333333333')$$);

SELECT pg_temp.assert_rejected(
  'member blocks - blocking yourself',
  $$INSERT INTO member_blocks (blocker_id, blocked_id)
    VALUES ('11111111-1111-4111-8111-111111111111',
            '11111111-1111-4111-8111-111111111111')$$);

INSERT INTO member_blocks (blocker_id, blocked_id) VALUES
  ('11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222');

SELECT pg_temp.assert_rejected(
  'member blocks - the same block twice',
  $$INSERT INTO member_blocks (blocker_id, blocked_id)
    VALUES ('11111111-1111-4111-8111-111111111111',
            '22222222-2222-4222-8222-222222222222')$$);

-- A block is stored one-directionally and EVALUATED symmetrically, so a mutual block is two
-- rows and must remain representable. A unique constraint on the unordered pair would look
-- tidier and would wrongly reject this.
SELECT pg_temp.assert_accepted(
  'member blocks - the reverse block is a separate row',
  $$INSERT INTO member_blocks (blocker_id, blocked_id)
    VALUES ('22222222-2222-4222-8222-222222222222',
            '11111111-1111-4111-8111-111111111111')$$);

INSERT INTO message_reports (message_id, reporter_id) VALUES
  ('e1e1e1e1-e1e1-4e1e-8e1e-e1e1e1e1e1e1', '22222222-2222-4222-8222-222222222222');

-- PRD/05 rule 10: reporting twice is a no-op. Enforced by the key, not by the handler, so a
-- double tap cannot produce two queue entries.
SELECT pg_temp.assert_rejected(
  'message reports - the same reporter reporting the same message twice',
  $$INSERT INTO message_reports (message_id, reporter_id)
    VALUES ('e1e1e1e1-e1e1-4e1e-8e1e-e1e1e1e1e1e1',
            '22222222-2222-4222-8222-222222222222')$$);

SELECT pg_temp.assert_accepted(
  'message reports - a second person reporting the same message is a separate report',
  $$INSERT INTO message_reports (message_id, reporter_id)
    VALUES ('e1e1e1e1-e1e1-4e1e-8e1e-e1e1e1e1e1e1',
            '33333333-3333-4333-8333-333333333333')$$);

INSERT INTO user_reports (reporter_id, subject_id) VALUES
  ('22222222-2222-4222-8222-222222222222', '11111111-1111-4111-8111-111111111111');

-- The same rule as message_reports one block up, for the other noun: reporting twice is a no-op,
-- enforced by the key rather than by the handler.
SELECT pg_temp.assert_rejected(
  'user reports - the same reporter reporting the same person twice',
  $$INSERT INTO user_reports (reporter_id, subject_id)
    VALUES ('22222222-2222-4222-8222-222222222222',
            '11111111-1111-4111-8111-111111111111')$$);

SELECT pg_temp.assert_accepted(
  'user reports - a second person reporting the same member is a separate report',
  $$INSERT INTO user_reports (reporter_id, subject_id)
    VALUES ('33333333-3333-4333-8333-333333333333',
            '11111111-1111-4111-8111-111111111111')$$);

-- Note this is the OPPOSITE of the member_blocks case above, and the pair is worth reading
-- together: a mutual block is two legitimate rows, so no unordered-pair key may exist there.
-- Two people reporting each other is likewise two rows, and the key is ordered for that reason.
SELECT pg_temp.assert_accepted(
  'user reports - the reverse report is a separate row',
  $$INSERT INTO user_reports (reporter_id, subject_id)
    VALUES ('11111111-1111-4111-8111-111111111111',
            '22222222-2222-4222-8222-222222222222')$$);

-- A self-report would sit in the queue forever waiting for a moderator to work out what it was.
SELECT pg_temp.assert_rejected(
  'user reports - reporting yourself',
  $$INSERT INTO user_reports (reporter_id, subject_id)
    VALUES ('11111111-1111-4111-8111-111111111111',
            '11111111-1111-4111-8111-111111111111')$$);

-- The audit log's window has to be a window. An inverted one would record a read that could
-- not have happened, which makes the log useless as evidence.
SELECT pg_temp.assert_rejected(
  'moderation reads - an inverted context window',
  $$INSERT INTO moderation_reads
      (moderator_id, message_id, channel_id, from_seq, to_seq)
    VALUES ('33333333-3333-4333-8333-333333333333',
            'e1e1e1e1-e1e1-4e1e-8e1e-e1e1e1e1e1e1',
            'c1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1c1', 10, 4)$$);

SELECT pg_temp.assert_accepted(
  'moderation reads - a single-message window is still a window',
  $$INSERT INTO moderation_reads
      (moderator_id, message_id, channel_id, from_seq, to_seq)
    VALUES ('33333333-3333-4333-8333-333333333333',
            'e1e1e1e1-e1e1-4e1e-8e1e-e1e1e1e1e1e1',
            'c1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1c1', 1, 1)$$);

-- A conversation pin is personal, so one member pinning a channel twice is one pin. The primary
-- key IS that rule: without it a double tap leaves two rows and the list would have to
-- de-duplicate something the database should never have accepted.
SELECT pg_temp.assert_accepted(
  'channel pins - a member pins a conversation',
  $$INSERT INTO channel_pins (user_id, channel_id)
    VALUES ('22222222-2222-4222-8222-222222222222',
            'c1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1c1')$$);

SELECT pg_temp.assert_rejected(
  'channel pins - the same member pinning the same conversation twice',
  $$INSERT INTO channel_pins (user_id, channel_id)
    VALUES ('22222222-2222-4222-8222-222222222222',
            'c1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1c1')$$);

-- And the pin is PER MEMBER, which is the whole point: a second person pinning the same
-- conversation is a different pin and must be accepted.
SELECT pg_temp.assert_accepted(
  'channel pins - a second member pinning the same conversation is their own pin',
  $$INSERT INTO channel_pins (user_id, channel_id)
    VALUES ('33333333-3333-4333-8333-333333333333',
            'c1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1c1')$$);

-- The clear floor, same shape: one floor per person per channel, and two people clearing the
-- same conversation hold two independent floors. That is what makes "clear it for me only"
-- expressible at all against a single shared log.
SELECT pg_temp.assert_accepted(
  'channel clears - a member clears their own view of a conversation',
  $$INSERT INTO channel_clears (user_id, channel_id, cleared_before_seq)
    VALUES ('22222222-2222-4222-8222-222222222222',
            'c1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1c1', 12)$$);

SELECT pg_temp.assert_rejected(
  'channel clears - a second floor for the same member and conversation',
  $$INSERT INTO channel_clears (user_id, channel_id, cleared_before_seq)
    VALUES ('22222222-2222-4222-8222-222222222222',
            'c1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1c1', 20)$$);

SELECT pg_temp.assert_accepted(
  'channel clears - the other participant holds their own floor, untouched',
  $$INSERT INTO channel_clears (user_id, channel_id, cleared_before_seq)
    VALUES ('33333333-3333-4333-8333-333333333333',
            'c1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1c1', 3)$$);

-- A negative floor hides nothing and reads as "clear did not work" rather than as a bad write,
-- so it is refused where it is written rather than diagnosed later.
SELECT pg_temp.assert_rejected(
  'channel clears - a negative floor',
  $$INSERT INTO channel_clears (user_id, channel_id, cleared_before_seq)
    VALUES ('44444444-4444-4444-8444-444444444444',
            'c1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1c1', -1)$$);

-- ---------------------------------------------------------------------------
-- Club bans (ADR-0021)
-- ---------------------------------------------------------------------------

SELECT pg_temp.assert_accepted(
  'club bans - an admin bars somebody from a club',
  $$INSERT INTO club_bans (club_id, user_id, banned_by)
    VALUES ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            '33333333-3333-4333-8333-333333333333',
            '11111111-1111-4111-8111-111111111111')$$);

-- One ban per person per club. Two admins reaching for it at the same moment must not produce
-- two rows, which is why the handler can treat a repeat as a no-op rather than an error.
SELECT pg_temp.assert_rejected(
  'club bans - the same person banned from the same club twice',
  $$INSERT INTO club_bans (club_id, user_id, banned_by)
    VALUES ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            '33333333-3333-4333-8333-333333333333',
            '22222222-2222-4222-8222-222222222222')$$);

-- A ban names a real person. A uuid belonging to nobody would otherwise sit in the table
-- barring an account that does not exist.
SELECT pg_temp.assert_rejected(
  'club bans - a ban on a user who does not exist',
  $$INSERT INTO club_bans (club_id, user_id, banned_by)
    VALUES ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            '99999999-9999-4999-8999-999999999999',
            '11111111-1111-4111-8111-111111111111')$$);

-- The attribution is the safeguard, so the BAN must outlive the admin who imposed it. Deleting
-- that account nulls `banned_by` and leaves the row standing; a cascade here would quietly unban
-- somebody every time an admin closed their account, which is the one way this table could fail
-- silently.
--
-- A throwaway pair, because the seeded members have written messages and cannot be deleted at
-- all - which is itself the correct behaviour and not what this is testing.
INSERT INTO users (id, full_name, email) VALUES
  ('dddddddd-dddd-4ddd-8ddd-dddddddddddd', 'Dana',  'dana@test.invalid'),
  ('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', 'Erin',  'erin@test.invalid');

INSERT INTO club_bans (club_id, user_id, banned_by) VALUES
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
   'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
   'dddddddd-dddd-4ddd-8ddd-dddddddddddd');

DELETE FROM users WHERE id = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

-- Written as a plain DO block rather than through assert_accepted, because the claim is about
-- what SURVIVES a statement rather than about whether the statement is allowed.
DO $ban$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM club_bans
     WHERE club_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
       AND user_id = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
       AND banned_by IS NULL
  ) THEN
    RAISE EXCEPTION 'FAIL: the ban did not survive the deletion of the admin who imposed it';
  END IF;
  RAISE NOTICE 'PASS  survived: club bans - a ban outlives the account that imposed it';
END
$ban$;

-- ---------------------------------------------------------------------------
-- moderation_actions: the record that a report was acted on  (ADR-0023)
-- ---------------------------------------------------------------------------

SELECT pg_temp.assert_accepted(
  'moderation actions - a moderator suspends an account',
  $$INSERT INTO moderation_actions (moderator_id, action, subject_user_id)
    VALUES ('11111111-1111-4111-8111-111111111111',
            'suspend',
            '33333333-3333-4333-8333-333333333333')$$);

-- The verb is closed. An action nobody can render is an audit row that says nothing, and the
-- three the product performs are the three it should be able to record.
SELECT pg_temp.assert_rejected(
  'moderation actions - an action verb nobody implements',
  $$INSERT INTO moderation_actions (moderator_id, action, subject_user_id)
    VALUES ('11111111-1111-4111-8111-111111111111',
            'shadowban',
            '33333333-3333-4333-8333-333333333333')$$);

-- An action about nobody and nothing is not a record, it is a row. Held by the database rather
-- than by the handler, because a handler races and can be forgotten.
SELECT pg_temp.assert_rejected(
  'moderation actions - an action naming neither a person nor a message',
  $$INSERT INTO moderation_actions (moderator_id, action)
    VALUES ('11111111-1111-4111-8111-111111111111', 'suspend')$$);

-- The audit trail must not be orphanable. An account is anonymised and never hard-deleted in
-- this product, so RESTRICT costs nothing and guarantees the log has no holes - which is the
-- whole property that makes it evidence rather than a table.
INSERT INTO users (id, full_name, email) VALUES
  ('ffffffff-ffff-4fff-8fff-ffffffffffff', 'Fran', 'fran@test.invalid');

INSERT INTO moderation_actions (moderator_id, action, subject_user_id) VALUES
  ('ffffffff-ffff-4fff-8fff-ffffffffffff',
   'reinstate',
   '33333333-3333-4333-8333-333333333333');

SELECT pg_temp.assert_rejected(
  'moderation actions - deleting a moderator who has acted',
  $$DELETE FROM users WHERE id = 'ffffffff-ffff-4fff-8fff-ffffffffffff'$$);

ROLLBACK;
