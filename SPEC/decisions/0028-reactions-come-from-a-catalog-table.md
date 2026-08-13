# ADR-0028: Reactions come from a catalog table, not a fixed set

| | |
|---|---|
| Status | Accepted |
| Date | 2026-08-13 |
| Deciders | parks3131 |
| Supersedes | none |

## Context

[Chat](../PRD/05-chat.md) has carried an open question since 2026-07-30: reactions should offer the
whole emoji list from a popup, "like WhatsApp", rather than the six that shipped. It was recorded
rather than half-built, with five costs written down. Three of them are about the same thing:

| The recorded cost | |
|---|---|
| The set stops being closeable | The `CHECK` listing the six is the only thing stopping arbitrary text reaching a column that renders directly into every client |
| Validating "is this an emoji" is genuinely hard | Grapheme clusters, ZWJ sequences, modifiers, regional indicator pairs, variation selectors. Length in code points is not a bound |
| Normalisation becomes a correctness issue | Two byte-different encodings of one emoji must be one reaction, and the primary key compares bytes |

The other two - the pill row stops being bounded, and the picker is a real component - are
interface problems and are answered in [Chat](../PRD/05-chat.md) rather than here.

[ADR-0017](0017-reactions-travel-on-the-message-envelope.md) already anticipated this change and
said what it costs: *"nothing here changes shape: the emoji is already a string end to end, and
only the fixed render order becomes a different rule."* That holds. This ADR is not about the
transport.

## Decision

**The set of reactable emoji is a table in the database, and `message_reactions.emoji` and
`news_reactions.emoji` are foreign keys into it.**

- `emoji_catalog(emoji PRIMARY KEY, name, group, ordinal)`, seeded by migration from
  [`emojibase-data`](https://github.com/milesj/emojibase), pinned by version.
- Both `CHECK` constraints are dropped and replaced by those foreign keys.
- The same dataset is bundled into the client for the picker and its search. **One source, two
  consumers, generated - never two hand-maintained lists.**
- Skin tone variants are excluded for now: 330 of the 1,914 emoji support them and including them
  would make the catalog 3,564 rows, add a tone control and a per-device preference, and make
  "is 👏 the same reaction as 👏🏽" a question the pill row has to answer. The table can gain them
  later without a contract change.

**Why a table rather than validation code:** this repo's rule is that an invariant belongs in a
constraint rather than a handler, because a handler races and a constraint does not. "The emoji is
a real emoji" is an invariant. A 1,914-item `CHECK` would express it and be unreadable; a foreign
key expresses it exactly and is what a relational database is for.

## Consequences

| | |
|---|---|
| Positive | **Three of the five recorded costs disappear rather than being managed.** The set is closeable again, because the catalog closes it. Validation stops being a hard Unicode problem and becomes a lookup - there is no need to decide whether a string "is an emoji", only whether it is *one of ours*. Normalisation stops being a correctness issue, because the catalog defines the canonical form and anything else is refused by the foreign key rather than silently creating a second pill with a count of one. The picker and the server also cannot disagree about what exists, since both read the same generated data. |
| Negative | A new table of static reference data that we do not author, seeded by a migration, which has to be re-seeded when the dataset is upgraded. The client bundle grows by roughly 558KB for the English dataset. And an emoji the catalog knows but the reader's OS font does not still renders as tofu - the catalog bounds what can be *sent*, not what can be *seen*. |
| Follow-up needed | The pill row's ordering and overflow, which are interface rules and live in [Chat](../PRD/05-chat.md). A cap on distinct emoji per message, for the envelope reason ADR-0017 records. |

## Alternatives considered

| Alternative | Why not |
|---|---|
| Validate in the handler with a Unicode property test | The hard version of the problem, permanently. Every ZWJ sequence, modifier and variation selector is a case to get right, and getting it wrong either refuses somebody's emoji or admits arbitrary text with one emoji in front of it. It also leaves the database with no invariant at all, which is the arrangement this repo has an explicit rule against. |
| Keep a `CHECK` and list all 1,914 | Expresses the same invariant illegibly, and every dataset upgrade rewrites a constraint rather than inserting rows. Migrations would carry a two-thousand-item array. |
| Bundle the dataset in the client only, and trust the client | The server would accept anything. A client is not a place to enforce a constraint - the API is reachable without it. |
| Put the catalog in the database only, and have the client fetch it | The picker would need the network to open, in an app whose offline mode is a shipped feature, and search would round-trip per keystroke. The data is identical for every user; there is nothing per-user to fetch. |
| Widen the fixed set to twenty or thirty emoji | Cheaper, and answers a different request. The ask is the whole list from a popup; a longer constant is the rejected alternative in `PRD/05` wearing a bigger hat. |
| No catalog - drop the constraint and store any string | The column renders directly into every client. That is a content injection surface with no bound, and reactions do not pass the hate-speech filter that message bodies do. |

## Note

The reason this needs an ADR is that the obvious reading of "add a full emoji picker" is a client
change, and the decision that matters is a database one. A reader who finds `emoji_catalog` and
wonders why a Unicode table is in Postgres should find this rather than assume it is storage for
its own sake: it is there so the foreign key can be the validator, and so normalisation stops being
somebody's job.
