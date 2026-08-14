# Data model

Postgres throughout. Grouped by concern; [Domain model](../PRD/01-domain-model.md) is the authority on semantics.

### Identity

`users`, `sessions`, `accounts` and `verifications` are **owned by better-auth** and their
required columns are not ours to choose. What is ours is the naming and the profile columns
layered on top.

```
users                 id, full_name, email, email_verified, image, created_at, updated_at,
                      bio, city, dob, school,
                      anonymized_at, signin_blocked_at, is_platform_moderator
                      -- id DEFAULT gen_random_uuid(). Load-bearing: better-auth's Drizzle
                      -- adapter emits `default` for id and relies on the database, and its
                      -- own generateId setting does not fill it in. Same for the three
                      -- tables below. See AGENTS.md 5.3 entry 2.
                      -- full_name is the column; `name` is the property, because better-auth
                      -- resolves its fields by Drizzle property name.
                      -- email_verified and updated_at are better-auth requirements.
                      -- `image` is better-auth's avatar field and is unused in Phase 0.
                      -- Phase 3 adds avatar_media_id when media exists; until then there is
                      -- deliberately no media reference here to dangle.
                      -- signin_blocked_at, not blocked_at: since member-to-member blocking
                      -- now exists, an unqualified "blocked" is ambiguous between "cannot
                      -- sign in" and "blocked by another member". Two very different things.
                      -- is_platform_moderator gates the DM report queue only. See [Authorization](05-authorization.md).
sessions              id, user_id, token UNIQUE, expires_at, ip_address, user_agent,
                      created_at, updated_at
                      -- better-auth's shape. An earlier draft of this file specified
                      -- (device_id, refresh_token_hash); the auth library owns session
                      -- storage, so that never existed. device_id lives on `devices`.
accounts              id, user_id, account_id, provider_id, password, created_at, updated_at,
                      access_token, refresh_token, access_token_expires_at,
                      refresh_token_expires_at, scope, id_token
                      -- better-auth. Only password is used: email/password is the only method.
verifications         id, identifier, value, expires_at, created_at, updated_at
devices               id, user_id, push_token, platform, last_seen_at, invalidated_at
                      -- Phase 1, with push. Not yet built.
```

**The system actor** is a seeded `users` row with the fixed id
`00000000-0000-4000-8000-000000000001`, `signin_blocked_at` set at creation so nothing can ever
authenticate as it. System messages are authored by it and never by `NULL`. See
[Message flows](03-message-flows.md).

### Clubs and membership
```
clubs                 id, name, sport, description, avatar_media_id, join_policy,
                      invite_token, member_invite_token, invite_token_rotated_at,
                      created_at
                      UNIQUE (invite_token), UNIQUE (member_invite_token)
                      -- `sport` is required, free text, validated by nothing and read
                      -- by nothing - a leftover of the founding case that now asks a
                      -- chess club what sport it plays. ADR-0029 removed the reason to
                      -- replace it with a club type and did not remove it; see PRD/17.
                      -- TWO links, and which one is redeemed is the whole decision
                      -- (ADR-0025): the admin token bypasses the join policy, the
                      -- member token obeys it. Independently minted, never derived
                      -- from each other - a derived pair would make rotating either
                      -- one a lie - and rotation replaces both together.
                      -- invite_token, not invite_code. Nobody types it: it exists only
                      -- inside a share link (PRD/04 rule 5, changed 2026-07-28).
                      -- Therefore it is 32 bytes of CSPRNG, base64url, matched exactly
                      -- and case-sensitively. Do NOT use a short human-friendly code:
                      -- that shape only existed to be typed, and it is the shape that
                      -- is feasible to enumerate.
club_memberships      club_id, user_id, role ∈ {owner,admin,member}, joined_at
                      PK (club_id, user_id)
                      UNIQUE (club_id) WHERE role='owner'      ← invariant 1, at the data layer
club_join_requests    id, club_id, user_id, status, decided_by, decided_at
                      UNIQUE (club_id, user_id) WHERE status='pending'   ← idempotent decisions
club_bans             club_id, user_id, banned_by, created_at
                      PK (club_id, user_id)                    ← banning twice is a no-op
                      FK banned_by → users ON DELETE SET NULL  ← NOT cascade. See below
```

**`club_bans` is a separate row from `club_memberships`, not a flag on it.** The two facts are
different and a banned person is usually not a member at all: membership says "in this club now",
a ban says "may not be". Folding them together would also bar a member who left of their own
accord, which is a blameless act.

**`banned_by` is `SET NULL` and never `CASCADE`.** The attribution is the safeguard
([ADR-0021](../decisions/0021-club-bans-are-harder-to-impose-than-to-lift.md)), so a ban has to
outlive the account that imposed it - a cascade here would quietly unban somebody every time an
admin closed their account, which is the one way this table could fail silently and the reason
`constraint-proof.sql` deletes the banning admin and asserts the row survives with a null author.

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
                      client_msg_id NOT NULL, reply_to_seq,
                      linked_poll_id, linked_event_id, linked_meeting_id, created_at
                      UNIQUE (channel_id, seq)
                      UNIQUE (channel_id, sender_id, client_msg_id)
                      -- both columns NOT NULL is load-bearing: Postgres treats NULLs as
                      -- distinct in a unique index, so a nullable sender_id or
                      -- client_msg_id silently defeats this constraint. System messages
                      -- use the reserved system-actor UUID, never NULL. See [Message flows](03-message-flows.md).
                      FK (channel_id, reply_to_seq) → messages (channel_id, seq) ON DELETE CASCADE
                      CHECK (reply_to_seq IS NULL OR reply_to_seq < seq)
                      -- A reply stores ONE integer and nothing else about what it answers.
                      -- The FK is composite and self-referencing on purpose: channel_id
                      -- appears on both sides, so "the quoted message is in this channel"
                      -- is enforced by the reference rather than re-checked by every read.
                      -- The CHECK rules out quoting the future and, with it, a message
                      -- quoting itself - which the FK alone would accept, because a
                      -- self-referencing key is satisfied by the row being inserted.
                      -- The quote's CONTENTS are joined on read, never stored: see
                      -- [Message flows](03-message-flows.md).
                      INDEX (channel_id, seq DESC)
                      INDEX (channel_id, seq) WHERE pinned           ← Highlights, unbounded
                      INDEX (channel_id, seq) WHERE type='announcement'
                      INDEX (channel_id, seq) WHERE media_id IS NOT NULL   ← Gallery
                      INDEX (channel_id, reply_to_seq) WHERE reply_to_seq IS NOT NULL
                      -- for the cascade: without it, deleting a channel scans this table
                      -- once per message it holds
emoji_catalog         emoji, name, group, ordinal
                      PK (emoji)
                      -- Static reference data, seeded from a pinned emojibase-data release
                      -- and NOT authored here. It exists so a foreign key can be the
                      -- validator: "the emoji is a real emoji" is an invariant, and an
                      -- invariant belongs in a constraint rather than a handler. It also
                      -- defines the canonical encoding, which is what stops ❤️ and ❤
                      -- becoming two pills with a count of one each.
                      -- `ordinal` is the dataset's own order, used to break ties in the
                      -- pill row so equal counts do not shuffle. See ADR-0028.
message_reactions     message_id, user_id, emoji, created_at
                      PK (message_id, user_id, emoji)
                      FK emoji -> emoji_catalog(emoji)
                      INDEX (message_id)
                      -- The PK is the behaviour: several DIFFERENT emoji from one member,
                      -- never the same one twice. "Reactions toggle on and off" is then a
                      -- keyed delete-or-insert rather than a read-then-write, so two fast
                      -- taps cannot leave a double row.
                      -- The FK replaced a CHECK listing six emoji on 2026-08-13. The CHECK
                      -- made the fixed set a fact about the data rather than a rule a
                      -- handler remembers, and the FK keeps that property while letting the
                      -- set be 1,914 rows instead of six - which a CHECK could express only
                      -- illegibly. The column renders directly into every client, so it has
                      -- never been allowed to hold arbitrary text and still is not.
                      -- NO maintained count column, unlike poll_options.vote_count: that
                      -- one exists because vote counts are public while voter identity is
                      -- gated. Reactions are public both ways, so a count is derivable.
                      -- Built in Phase 3.5. Specified here from Phase 0 and unbuilt until
                      -- then, which is also why nothing cleared them on soft delete.
message_mentions      message_id, user_id
message_reports       message_id, reporter_id, created_at, dismissed_at, dismissed_by
                      PK (message_id, reporter_id)                   ← reporting twice is a no-op
                      INDEX (created_at DESC) WHERE dismissed_at IS NULL
                      -- The PK *is* the rule, rather than a separate UNIQUE: both
                      -- columns are NOT NULL so there is no NULL for Postgres to
                      -- treat as distinct and let a second report through.
                      -- One table, TWO readers, selected by the reported message's
                      -- channel scope: club/race/eboard reports go to that space's
                      -- admins, dm reports go to platform moderators. Nothing about
                      -- the row differs. See [Authorization](05-authorization.md).
                      -- Arrived in Phase 3.5, with the scope that needed the second
                      -- reader; it was specified here from Phase 0 and unbuilt until then.
read_cursors          user_id, channel_id, last_read_seq, updated_at  PK (user_id, channel_id)
```

### Races
```
races                 id, club_id, name, race_date, created_at,
                      meet_description, meet_location_url, meet_hotel_url,
                      meet_photos_url, meet_results_url
                      -- NO channel_id. The channel references the race, never the
                      -- reverse: `channels (scope='race', scope_id=<race>)`, which
                      -- UNIQUE (scope, scope_id) already makes unambiguous. Storing
                      -- the relationship in both directions gives it two sources of
                      -- truth and nothing to keep them honest. See ADR-0014.
                      -- avatar_media_id arrives in Phase 3 with media_objects.
                      -- race_date is a DATE, not a timestamp: a race has a day, not a
                      -- time. A date-only value parsed as an ISO string is UTC
                      -- midnight and renders a day early in negative-offset zones.
                      -- It is NULLABLE since 2026-08-12, and the null MEANS something:
                      -- this space is not on the calendar. readCalendar unions in only
                      -- the races that carry a date, which is the only thing enforcing
                      -- that. The same row serves a dated race and an ordinary group.
                      -- Ordering for the club's list is created_at DESC, never
                      -- race_date - a dateless group has nothing to sort on.
                      -- The five meet* columns live here rather than in their own
                      -- table because they are edited together as ONE form; a
                      -- separate table would invite partial saves of something the
                      -- product treats as atomic.
race_memberships      race_id, user_id, joined_at    PK (race_id, user_id)   ← sole access truth
race_join_requests    id, race_id, user_id, status, decided_by, decided_at
race_pins             race_id, user_id               PK (race_id, user_id)   ← personal
car_groups            id, race_id, number, incharge_user_id, created_at
                      UNIQUE (race_id, number)      -- auto-numbering, one per race
                      UNIQUE (id, race_id)          -- redundant, but see below
                      -- That second one must be a UNIQUE CONSTRAINT, not a unique
                      -- index. drizzle-kit emits every foreign key BEFORE every
                      -- CREATE INDEX, so a composite FK pointing at an index
                      -- references something that does not exist yet and the
                      -- migration fails. A table constraint is emitted inline with
                      -- CREATE TABLE. Found by applying the migration, not by
                      -- reading it.
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
eboard_channels       id, club_id UNIQUE, name, description
                      -- NO channel_id, per ADR-0014. avatar_media_id in Phase 3.
eboard_memberships    eboard_id, user_id             PK (eboard_id, user_id)
eboard_join_requests  id, eboard_id, user_id, status, decided_by, decided_at
meetings              id, eboard_id, creator_id, title, description, starts_at, link,
                      created_at
                      -- creator_id IS the authorization subject here, not audit
                      -- metadata: only the creator edits or deletes a meeting. Two
                      -- explicit founder follow-ups landed on that after meetings
                      -- first shipped as any-member editable.
```

### Content
```
polls                 id, club_id, scope, scope_id, creator_id, question, allow_multiple,
                      is_private, closed_at, closes_at, closing_soon_notified_at,
                      created_at
                      UNIQUE (id, allow_multiple)   ← target of poll_votes' composite FK
                      CHECK (scope IN ('club','race','eboard'))
                      -- There is deliberately NO is_closed column. Closed-ness is
                      -- evaluated at READ time as
                      --   closed_at IS NOT NULL OR closes_at < now()
                      -- because a passed deadline must read as closed EVERYWHERE
                      -- without anyone having closed it. A stored boolean would need
                      -- a job to flip it, and there is deliberately no job that
                      -- closes polls - the only scheduled job is the closing-soon
                      -- reminder. PRD/01 previously listed is_closed as a field;
                      -- corrected there too.
poll_options          id, poll_id, label, position, vote_count    ← counts public (invariant 6)
poll_votes            poll_id, option_id, user_id, allow_multiple, created_at
                      PK (option_id, user_id)                     ← identity gated
                      UNIQUE (poll_id, user_id) WHERE NOT allow_multiple
                      FOREIGN KEY (poll_id, allow_multiple)
                          REFERENCES polls (id, allow_multiple)
                      -- allow_multiple is denormalised from the poll for the same
                      -- reason race_id is denormalised onto car_group_members, and
                      -- with the same composite FK keeping it honest. It makes the
                      -- partial unique index above meaningful, so "tapping a
                      -- different option MOVES the vote rather than adding a second"
                      -- is enforced by the database rather than trusted from the
                      -- handler. Without the FK a vote could claim a setting its poll
                      -- does not have and escape the index.
                      -- polls therefore also carries UNIQUE (id, allow_multiple) as
                      -- the referenced target.
calendar_events       id, club_id, type, title, starts_at, ends_at, location, description,
                      created_by, created_at
                      CHECK (type IN ('race','practice','team_bonding','volunteer','other'))
                      -- created_by is audit only. Any club admin may edit or delete
                      -- ANY event, so it is deliberately not the authorization
                      -- subject - unlike meetings.creator_id, which is.
meetups               id, club_id, meetup_date, meetup_time, location, description,
                      created_by, created_at
                      INDEX (club_id, meetup_date, meetup_time)
                      -- Was routine_workouts, whose CHECK listed ten sports. The CHECK
                      -- is DELETED, not replaced: a meetup has no type, category or
                      -- kind of any sort (ADR-0029), and the free-text description is
                      -- the only place what the club is doing is ever recorded. A
                      -- reader who assumes the missing column is an oversight should
                      -- read that ADR before adding one back.
                      -- location and meetup_time are NOT NULL. The surface exists to
                      -- answer where and when; "TBC" is a valid place and a blank is
                      -- not.
                      -- meetup_date is a DATE and meetup_time is a TIME, deliberately
                      -- NOT one timestamptz. A club's week is local wall-clock and no
                      -- club carries a timezone, so there is nothing to convert from -
                      -- and an instant would put Tuesday's meetup on Monday for a
                      -- member reading from another country. The week grid groups by
                      -- meetup_date and that grouping must not depend on the reader.
                      -- NO unique key on (club_id, meetup_date): a day holds as many
                      -- meetups as the club needs, ordered by time.
                      -- created_by is audit only: any admin edits any meetup.
news_posts            id, club_id, author_id, body, media_id, created_at, updated_at
                      CHECK (body IS NOT NULL OR media_id IS NOT NULL)
                      -- The check carries "a post must have body text, a photo, or
                      -- both" so an empty post cannot exist even if a handler forgets.
                      -- media_id has no FK yet: media_objects arrives in Phase 3. The
                      -- column exists now so the check can express the invariant
                      -- today rather than being retrofitted over historical rows.
                      -- author_id is audit only: any club admin edits any post.
news_reactions        post_id, user_id, emoji
                      FK emoji -> emoji_catalog(emoji)
                      -- The same catalog chat uses, which is what keeps PRD/06 rule 4
                      -- ("reactions use the same emoji set as chat") true rather than
                      -- turning it into an exception somebody has to explain.
```

### Direct messages and member safety
```
dm_conversations      id, user_a, user_b, created_at
                      -- NO read_only_at and NO blocked_at. Whether a thread can be
                      -- written to is EVALUATED from club_memberships and member_blocks,
                      -- never stored: nothing owns the moment a pair stops sharing a
                      -- club, four write paths would each have to recompute it, and the
                      -- join path would have to CLEAR it. See ADR-0016.
                      -- NO channel_id, per ADR-0014: the channel references the
                      -- conversation as (scope='dm', scope_id=<conversation>).
                      CHECK (user_a < user_b)      -- canonical order, enforced by the DB
                      UNIQUE (user_a, user_b)      -- exactly one thread per pair, ever
                      -- the CHECK forces the handler to sort the pair before insert, so
                      -- (alice,bob) and (bob,alice) cannot both exist. Without it the
                      -- UNIQUE is useless and two threads race into being.

member_blocks         blocker_id, blocked_id, created_at   PK (blocker_id, blocked_id)
                      CHECK (blocker_id <> blocked_id)
                      INDEX (blocked_id)            -- "who has blocked me" is as hot
                                                    -- as "who have I blocked", and the
                                                    -- PK only serves the second
                      -- member_blocks, not blocks: users.signin_blocked_at records the
                      -- unrelated fact that an account cannot sign in, and an
                      -- unqualified "blocked" is ambiguous between the two. Same
                      -- reasoning this file already applies to signin_blocked_at.
                      -- Stored one-directionally, EVALUATED symmetrically. See [Authorization](05-authorization.md).
                      -- A mutual block is TWO rows and must stay representable, which
                      -- is why there is no unique constraint on the unordered pair.

channel_mutes         user_id, channel_id, muted_until NULL  PK (user_id, channel_id)
                      -- NULL muted_until means muted indefinitely.
                      -- Read by the push audience function ([Message flows](03-message-flows.md)); applies to every
                      -- scope, not just dm. Written for the first time in Phase 3.5;
                      -- the table has existed since Phase 1 so mute had somewhere to
                      -- live once the audience function did.

channel_pins          user_id, channel_id, created_at   PK (user_id, channel_id)
                      -- A CONVERSATION pin, personal like race_pins: it changes one member's
                      -- own list ordering and nobody else can observe it. Emphatically not
                      -- messages.pinned, which is an act of authority in a shared room. The
                      -- row's existence IS the pin, so both directions are idempotent.
                      -- Scope-agnostic: a club chat and a DM pin through the same row.

channel_clears        user_id, channel_id, cleared_before_seq, created_at
                      PK (user_id, channel_id)
                      CHECK (cleared_before_seq >= 0)
                      -- What "Delete chat" writes. NOT a deletion: the log is untouched and
                      -- the other participant keeps every message. One person's floor into a
                      -- shared log moves up, which is the only per-user "delete" expressible
                      -- against one row per message (invariant 7, ADR-0003).
                      -- EVERY read that returns messages must filter seq > this: history,
                      -- the jump window, sync, the gallery, both Highlights queries and the
                      -- conversation row's last-message join. It is loaded into the access
                      -- context and asked through clearedFloor() so there is one definition -
                      -- a floor honoured by five reads of six is a leak, not a feature.
                      -- Clearing also advances read_cursors in the same transaction, or the
                      -- conversation would show nothing while claiming unread messages.

moderation_reads      id, moderator_id, message_id, channel_id, from_seq, to_seq, created_at
                      CHECK (from_seq <= to_seq)
                      INDEX (moderator_id, created_at DESC)
                      -- The audit log [Authorization](05-authorization.md) requires: a platform moderator may
                      -- read the reported message and its immediate context, and that
                      -- read is logged. Records the window actually SERVED, not the one
                      -- requested, so a widened window shows up here rather than being
                      -- invisible. Append-only, and deliberately not covered by any
                      -- retention job: in a product that will include minors, the record
                      -- of who looked at what is the last thing to prune.
                      -- moderator_id is ON DELETE RESTRICT for the same reason.

moderation_actions    id, moderator_id, action, subject_user_id NULL, message_id NULL, created_at
                      CHECK (action IN ('suspend','reinstate','remove_message'))
                      CHECK (subject_user_id IS NOT NULL OR message_id IS NOT NULL)
                      INDEX (created_at DESC), INDEX (subject_user_id, created_at DESC)
                      -- What a moderator DID, as opposed to what they looked at. Apple's
                      -- guideline 1.2 requires acting on a report within 24 hours by removing
                      -- the content and ejecting the user, and "we did" is a claim that needs
                      -- a row behind it. See ADR-0023.
                      -- NO free-text reason column, deliberately, for ADR-0021's argument
                      -- about club bans: a note about somebody who can never read or answer
                      -- it is a place to write something damaging, and a required one degrades
                      -- to one word. message_id carries the report that prompted the action
                      -- instead, which is stronger evidence than prose.
                      -- Both user references are RESTRICT: an account is anonymised and never
                      -- hard-deleted here, so nothing should be able to orphan an audit row.
                      -- message_id is SET NULL instead, because deleting a club really does
                      -- cascade its messages away and the record must outlive the conversation.
                      -- Note this differs from moderation_reads above, whose message_id
                      -- cascades - which quietly contradicts its own "never pruned" note. Left
                      -- alone rather than changed in passing; recorded so the difference is a
                      -- decision rather than an accident.
```

### Infrastructure
```
media_objects         id, owner_type, owner_id, bucket, object_key, mime, bytes, status,
                      variants jsonb, derive_error NULL, created_at
                      -- derive_error: why thumbnailing gave up, for bytes that will never
                      -- decode. A permanent fact, so the effect records it and completes
                      -- rather than retrying five times and parking. See TECH/07.
notifications         id, recipient_id, actor_id NULL, club_id NULL, type, params jsonb,
                      outbox_event_id, read_at, created_at
                      UNIQUE (outbox_event_id, recipient_id)       ← at-least-once safety
                      -- outbox_event_id is NOT a raw outbox id. One event can produce
                      -- more than one KIND of notification (an announcement that also
                      -- mentions somebody), so the key is eventId * 4 + slot, which
                      -- bands each event into its own block. The previous scheme -
                      -- raw id for one kind and id*2+1 for another - overlapped: a
                      -- mention on event 3 and an announcement on event 7 both key as
                      -- 7, and the second is silently dropped as already delivered.
                      -- The push_deliveries ledger uses the same keys, so a collision
                      -- swallowed a real push too. Found in Phase 3.5 while adding a
                      -- third kind. Synthetic keys stay NEGATIVE and unbanded, since
                      -- real outbox ids are a positive bigserial.
                      -- NO body and NO target column, deliberately. Both the display
                      -- text and the navigation target are derived at READ time from
                      -- (type, params). A stored route string left approvals
                      -- permanently unresolved for eight migrations in v1 (pitfall 8),
                      -- and a stored English body is unlocalizable and can only be
                      -- corrected by rewriting history (debt 11). See ADR-0013.
                      -- params is validated against a per-type Zod schema at write
                      -- time, so a malformed param cannot reach someone's inbox.
                      -- actor_id nullable: some notifications have no human actor.
                      -- club_id nullable for dm-scoped notifications; every audience
                      -- query must tolerate it. See [Channel log](02-channel-log.md).
outbox                id, partition_key, event_type, payload, processed_at, attempts, last_error
                      -- Phase 0 ships this column as processed_at, and there it genuinely
                      -- does mean "effect performed": the worker drains this table directly
                      -- with FOR UPDATE SKIP LOCKED and there is no Kafka yet.
                      -- Phase 1.5 renames it to published_at, at which point it means
                      -- "handed to Kafka" and effect completion becomes the consumer group
                      -- offset. Using the Kafka-era name for a non-Kafka meaning is exactly
                      -- the drift ADR-0006 warns about. See [Effects engine](04-effects-engine.md).
```

Notes:

- Vote counts live on `poll_options` as a column, updated in the vote transaction. In an
  app-server world the RLS-driven reason for this is gone, but it stays for O(1) reads and
  because domain invariant 6 makes counts and identity independently visible.
- `meet_information` remains five columns on `races` ([Races and Meets](../PRD/09-races-and-meets.md): "edited together as one
  form").
- Every unique partial index above encodes an invariant from [Domain model](../PRD/01-domain-model.md) **at the data layer**,
  per that section's instruction that these are enforced by data, not by UI.
