# Feature: `<name>`

Copy to `SPEC/PRD/<NN>-<kebab-name>.md`. Keep it to behaviour: **no file paths, no schema, no
component names** - those belong in `SPEC/TECH/`. Link across instead of duplicating.

<!-- Delete every instruction comment before committing. -->

## Purpose

<!-- What a member can do that they could not before, and what improvised workaround it
replaces. If it replaces nothing anyone currently does by hand, question whether it belongs -
see PRD/00-overview.md, product principle 2. -->

`<purpose>`

## Behaviour rules

<!-- Numbered, so they can be cited from tests, ADRs and other specs. One rule per line. State
the rule, not the implementation. Bold the ones that have already been got wrong once. -->

1. `<rule>`

## Permissions

<!-- A row per action, a column per actor. Every feature has one, even if the answer is
"everyone". If two features that look alike have different rules, say so explicitly here -
AGENTS.md section 2.1 warns that permission models are not derivable by analogy. -->

| Action | Owner | Admin | Member | Non-member |
|---|---|---|---|---|
| `<action>` | | | | |

## Scope interaction

<!-- If this touches chat, state what it does in EACH of club, race, Eboard and DM. The channel
abstraction requires a feature to work in all scopes or be an explicit parameter. A feature that
works in only one scope needs a stated reason. -->

| Scope | Behaviour |
|---|---|
| Club | |
| Race | |
| Eboard | |
| Direct message | |

## Notifications

<!-- Who is told, and who is deliberately NOT told. Creation notifications exclude the actor.
Audience always respects access. If the answer is "nobody", say so - silence is a decision. -->

`<audience, or "nothing is notified, because ...">`

## Edge cases

| State | Behaviour |
|---|---|
| Empty / nothing yet | |
| Loading | |
| Load failed | |
| Actor lacks permission | |
| Reached by deep link with no history | |
| The underlying object was deleted while open | |

## Out of scope

<!-- What this deliberately does NOT do, so it is not added later by drift. -->

- `<non-goal>`

## Acceptance criteria

<!-- Checkable by someone who did not build it, on iOS, Android and web. Prefer "verified by
attempting the forbidden write directly" over "the button is hidden". -->

- [ ] `<criterion>`

## Open questions

- `<question>`
