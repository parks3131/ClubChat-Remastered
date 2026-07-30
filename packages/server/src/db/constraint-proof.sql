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

-- A news post must have a body, a photo, or both. An entirely empty post cannot exist even
-- if a handler forgets to check.
SELECT pg_temp.assert_rejected(
  'news - an entirely empty post',
  $$INSERT INTO news_posts (club_id, author_id)
    VALUES ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            '11111111-1111-4111-8111-111111111111')$$);

SELECT pg_temp.assert_accepted(
  'news - body only is a valid post',
  $$INSERT INTO news_posts (club_id, author_id, body)
    VALUES ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            '11111111-1111-4111-8111-111111111111', 'We won.')$$);

SELECT pg_temp.assert_rejected(
  'routines - an invented activity type',
  $$INSERT INTO routine_workouts (club_id, workout_date, activity_type, title)
    VALUES ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '2026-04-01', 'quidditch', 'nope')$$);

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
-- Reactions: the fixed emoji set, enforced by the database
-- ---------------------------------------------------------------------------

-- The whole point of the check constraint. A handler that forgot to validate, or a second
-- write path that never knew it had to, cannot put arbitrary text in this column - which
-- matters because the column renders directly into every client.
SELECT pg_temp.assert_rejected(
  'reactions - an emoji outside the fixed set',
  $$INSERT INTO message_reactions (message_id, user_id, emoji)
    SELECT id, '11111111-1111-4111-8111-111111111111', '🦄' FROM messages LIMIT 1$$);

SELECT pg_temp.assert_rejected(
  'reactions - arbitrary text in the emoji column',
  $$INSERT INTO message_reactions (message_id, user_id, emoji)
    SELECT id, '11111111-1111-4111-8111-111111111111', 'lgtm' FROM messages LIMIT 1$$);

SELECT pg_temp.assert_accepted(
  'reactions - one of the six is allowed',
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

ROLLBACK;
