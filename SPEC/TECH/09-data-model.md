# Data model

Postgres throughout. Grouped by concern; [Domain model](../PRD/01-domain-model.md) is the authority on semantics.

### Identity
```
users                 id, email, full_name, avatar_media_id, bio, city, dob, school,
                      created_at, anonymized_at, signin_blocked_at,
                      is_platform_moderator
                      -- signin_blocked_at, not blocked_at: since member-to-member blocking
                      -- now exists, an unqualified "blocked" is ambiguous between "cannot
                      -- sign in" and "blocked by another member". Two very different things.
                      -- is_platform_moderator gates the DM report queue only. See [Authorization](05-authorization.md).
devices               id, user_id, push_token, platform, last_seen_at, invalidated_at
sessions              id, user_id, device_id, refresh_token_hash, expires_at
```

### Clubs and membership
```
clubs                 id, name, sport, description, avatar_media_id, join_policy,
                      invite_token, invite_token_rotated_at, created_at
                      UNIQUE (invite_token)
                      -- invite_token, not invite_code. Nobody types it: it exists only
                      -- inside a share link (Old.md 4.2 rule 5, changed 2026-07-28).
                      -- Therefore it is 32 bytes of CSPRNG, base64url, matched exactly
                      -- and case-sensitively. Do NOT use a short human-friendly code:
                      -- that shape only existed to be typed, and it is the shape that
                      -- is feasible to enumerate.
club_memberships      club_id, user_id, role ∈ {owner,admin,member}, joined_at
                      PK (club_id, user_id)
                      UNIQUE (club_id) WHERE role='owner'      ← invariant 1, at the data layer
club_join_requests    id, club_id, user_id, status, decided_by, decided_at
                      UNIQUE (club_id, user_id) WHERE status='pending'   ← idempotent decisions
```

### The channel abstraction - one concept, four scopes
```
channels              id, club_id NULL, scope ∈ {club,race,eboard,dm}, scope_id, last_seq
                      UNIQUE (club_id) WHERE scope='club'      ← invariant 2
                      UNIQUE (scope, scope_id)
                      CHECK ((club_id IS NULL) = (scope = 'dm'))
                      -- club_id is nullable ONLY for dm. The check stops the other three
                      -- scopes from ever exploiting the relaxed column. See [Channel log](02-channel-log.md).
messages              id, channel_id, seq, sender_id NOT NULL, type, body, media_id,
                      document_name, document_size, pinned, deleted_at,
                      client_msg_id NOT NULL,
                      linked_poll_id, linked_event_id, linked_meeting_id, created_at
                      UNIQUE (channel_id, seq)
                      UNIQUE (channel_id, sender_id, client_msg_id)
                      -- both columns NOT NULL is load-bearing: Postgres treats NULLs as
                      -- distinct in a unique index, so a nullable sender_id or
                      -- client_msg_id silently defeats this constraint. System messages
                      -- use the reserved system-actor UUID, never NULL. See [Message flows](03-message-flows.md).
                      INDEX (channel_id, seq DESC)
                      INDEX (channel_id, seq) WHERE pinned           ← Highlights, unbounded
                      INDEX (channel_id, seq) WHERE type='announcement'
                      INDEX (channel_id, seq) WHERE media_id IS NOT NULL   ← Gallery
message_reactions     message_id, user_id, emoji     PK (message_id, user_id, emoji)
message_mentions      message_id, user_id
message_reports       message_id, reporter_id, created_at, dismissed_at
                      UNIQUE (message_id, reporter_id)               ← reporting twice is a no-op
read_cursors          user_id, channel_id, last_read_seq, updated_at  PK (user_id, channel_id)
```

### Races
```
races                 id, club_id, name, race_date, avatar_media_id, channel_id,
                      meet_description, meet_location_url, meet_hotel_url,
                      meet_photos_url, meet_results_url
race_memberships      race_id, user_id, joined_at    PK (race_id, user_id)   ← sole access truth
race_join_requests    id, race_id, user_id, status, decided_by, decided_at
race_pins             race_id, user_id               PK (race_id, user_id)   ← personal
car_groups            id, race_id, number, incharge_user_id
                      UNIQUE (id, race_id)          -- redundant, but see below
car_group_members     car_group_id, race_id, user_id
                      UNIQUE (race_id, user_id)                             ← invariant 5
                      FOREIGN KEY (car_group_id, race_id)
                          REFERENCES car_groups (id, race_id)
                      -- race_id is denormalized onto this table on purpose. A generated
                      -- column cannot be used: Postgres generated columns may only
                      -- reference columns in their own row, and race_id lives on
                      -- car_groups. The composite FK above makes the denormalized value
                      -- provably consistent with the group's race, so the invariant is
                      -- enforced by the database rather than trusted from the handler.
```

### Eboard
```
eboard_channels       id, club_id UNIQUE, name, description, avatar_media_id, channel_id
eboard_memberships    eboard_id, user_id             PK (eboard_id, user_id)
eboard_join_requests  id, eboard_id, user_id, status, decided_by, decided_at
meetings              id, eboard_id, creator_id, title, description, starts_at, link
```

### Content
```
polls                 id, club_id, scope, scope_id, creator_id, question, allow_multiple,
                      is_private, closed_at, closes_at, closing_soon_notified_at
poll_options          id, poll_id, label, position, vote_count    ← counts public (invariant 6)
poll_votes            poll_id, option_id, user_id                 ← identity gated
calendar_events       id, club_id, type, title, starts_at, ends_at, location, description
routine_workouts      id, club_id, workout_date, activity_type, title, description
news_posts            id, club_id, author_id, body, media_id, created_at
news_reactions        post_id, user_id, emoji
```

### Direct messages and member safety
```
dm_conversations      id, user_a, user_b, channel_id, created_at
                      CHECK (user_a < user_b)      -- canonical order, enforced by the DB
                      UNIQUE (user_a, user_b)      -- exactly one thread per pair, ever
                      -- the CHECK forces the handler to sort the pair before insert, so
                      -- (alice,bob) and (bob,alice) cannot both exist. Without it the
                      -- UNIQUE is useless and two threads race into being.

blocks                blocker_id, blocked_id, created_at   PK (blocker_id, blocked_id)
                      CHECK (blocker_id <> blocked_id)
                      -- stored one-directionally, EVALUATED symmetrically. See [Authorization](05-authorization.md).

channel_mutes         user_id, channel_id, muted_until NULL  PK (user_id, channel_id)
                      -- NULL muted_until means muted indefinitely.
                      -- Read by the push audience function ([Message flows](03-message-flows.md)); applies to every
                      -- scope, not just dm.
```

### Infrastructure
```
media_objects         id, owner_type, owner_id, bucket, object_key, mime, bytes, status,
                      variants jsonb, created_at
notifications         id, recipient_id, actor_id, club_id NULL, type, body, target,
                      outbox_event_id, read_at, created_at
                      UNIQUE (outbox_event_id, recipient_id)       ← at-least-once safety
                      -- club_id nullable for dm-scoped notifications; every audience
                      -- query must tolerate it. See [Channel log](02-channel-log.md).
outbox                id, partition_key, event_type, payload, published_at, attempts, last_error
                      -- published_at means "handed to Kafka", NOT "effect performed".
                      -- Effect completion is the consumer group offset. See [Effects engine](04-effects-engine.md).
```

Notes:

- Vote counts live on `poll_options` as a column, updated in the vote transaction. In an
  app-server world the RLS-driven reason for this is gone, but it stays for O(1) reads and
  because `Old.md` invariant 6 makes counts and identity independently visible.
- `meet_information` remains five columns on `races` ([Races and Meets](../PRD/09-races-and-meets.md): "edited together as one
  form").
- Every unique partial index above encodes an invariant from [Domain model](../PRD/01-domain-model.md) **at the data layer**,
  per that section's instruction that these are enforced by data, not by UI.
