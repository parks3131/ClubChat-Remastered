-- Seed the reserved system actor.
--
-- System messages ("X joined the club", a poll card) are authored by this row and
-- never by NULL. That is not a style preference. Postgres treats NULLs as distinct
-- inside a unique index, so a nullable sender_id would silently defeat
-- `UNIQUE (channel_id, sender_id, client_msg_id)` - and system messages are exactly
-- the class of message the worker retries after a crash, so they are exactly the
-- class that must not slip past the idempotency constraint. A redelivered outbox
-- event would otherwise post "X was added to the club" twice.
--
-- A sentinel row is preferred over UNIQUE NULLS NOT DISTINCT because it also removes
-- a NULL branch from every render path, roster join and avatar lookup in the client.
--
-- The UUID is fixed and is duplicated as SYSTEM_ACTOR_ID in
-- packages/shared/src/domain.ts. It must match. See SPEC/TECH/03-message-flows.md.

INSERT INTO "users" (
  "id",
  "full_name",
  "email",
  "email_verified",
  -- Blocked from signing in for its whole existence: this row is an author, never
  -- an account. Nothing should ever be able to authenticate as it.
  "signin_blocked_at"
) VALUES (
  '00000000-0000-4000-8000-000000000001',
  'ClubChat',
  'system@clubchat.invalid',
  true,
  now()
)
-- Idempotent so the migration replays cleanly from zero against a database that
-- already has it (AGENTS.md non-negotiable 2: migrations must replay from zero).
ON CONFLICT ("id") DO NOTHING;
