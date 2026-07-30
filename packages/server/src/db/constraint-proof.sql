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

-- ---------------------------------------------------------------------------
-- Fixtures
-- ---------------------------------------------------------------------------

INSERT INTO users (id, full_name, email) VALUES
  ('11111111-1111-4111-8111-111111111111', 'Alice', 'alice@test.invalid'),
  ('22222222-2222-4222-8222-222222222222', 'Bob',   'bob@test.invalid');

INSERT INTO clubs (id, name, sport, invite_token) VALUES
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'Test Running Club', 'running', 'tok-a');

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

SELECT pg_temp.assert_rejected(
  'club_memberships - an invented role tier',
  $$INSERT INTO club_memberships (club_id, user_id, role)
    VALUES ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            '00000000-0000-4000-8000-000000000001', 'superadmin')$$);

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

ROLLBACK;
