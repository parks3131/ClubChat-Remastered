# Surface: `<name>`

Copy to `SPEC/DESIGN/<NN>-<kebab-name>.md`, using the next free number.

<!--
Delete every instruction comment before committing.

ONE RULE ABOVE ALL OTHERS: record the RELATIONSHIP, not the VALUE.

  Wrong:  "the bar is inset 24pt"
  Right:  "the bar is inset FURTHER THAN the content gutter, so it reads as a separate
           object rather than another block of the page"

The first is dead the moment somebody says "a bit more", and it duplicates `theme.ts`, which
the repo rule says wins anyway. The second survives 24 becoming 28 and is the thing you would
otherwise have to re-derive from scratch. Name the token; explain the relationship it has to
hold; leave the number in the code.
-->

## Purpose

<!-- One or two sentences. What this surface is for, and what it would cost to not have it. -->

`<purpose>`

## Where it appears

<!-- Which screens and scopes. If it is deliberately absent somewhere, say so here and say why -
an absence is a decision, and one nobody wrote down reads as an oversight. -->

`<where>`

## Anatomy

<!-- The named parts, so the spec and the code share a vocabulary. A part nobody has named gets
described three different ways in three different conversations. No measurements. -->

| Part | What it is |
|---|---|
| `<part>` | |

## Rules that must survive

<!-- Numbered, so they can be cited from a commit, a code comment, another spec or a review -
exactly as PRD numbers its behaviour rules. These are the load-bearing ones: the things that,
if quietly changed, break the design rather than adjust it. Bold any rule that has already been
got wrong once. -->

1. `<rule>`

## States

<!-- Every state this surface can be in, including the ones that are easy to forget. PRD/16 rule 1
requires loading, loaded and a retryable error on anything that reads; rule 2 requires a designed
empty state that tells the truth. Pressed and disabled are the two most often missed. -->

| State | Treatment |
|---|---|
| Default | |
| Active / selected | |
| Pressed | |
| Disabled | |
| Empty | |
| Loading | |
| Error | |

## Obligations it creates elsewhere

<!-- THE SECTION MOST LIKELY TO PREVENT A REAL BUG, and the one most likely to be left blank.

A visual choice can create a hard contract for code that has nothing to do with this surface. A
floating bar obliges every scrolling screen in the app to reserve clearance; a translucent
surface obliges whatever is behind it to actually be there.

Anything listed here MUST ALSO BE WRITTEN INTO THE RELEVANT `TECH/` DOC OR AN ADR. A per-surface
design file is exactly where somebody building an unrelated screen will never look. This section
is a pointer to the obligation, never its only home.

"None" is a legitimate answer. Leaving it blank is not. -->

| Obligation | Who owes it | Recorded in |
|---|---|---|
| `<obligation>` | | |

## Accessibility

<!-- PRD/16 names accessibility as the product's clearest gap, so this section is not optional.

At minimum: what carries meaning BESIDES colour, what a screen reader announces for anything
without text in it, and whether any touch target is smaller than it looks. -->

`<accessibility>`

## Platform differences

<!-- AGENTS 2.3.6: cross-platform means verified on each platform separately, not inferred from
one. Safe-area insets, blur, haptics, shadows, press feedback and font rendering all differ. -->

| | Behaviour |
|---|---|
| iOS | |
| Android | |
| Web | |

## Rejected alternatives

<!-- The ADR habit at surface scale, and the reason this file is worth keeping. Record what was
tried and what it did, not just what was chosen - an approach that looks obviously right from the
outside has usually already been tried here. Keep the story short; the long version goes in
HISTORY.md. -->

| Alternative | What actually happened |
|---|---|
| `<option>` | |

## Verified on

<!-- Design bugs are found by looking, on hardware. A simulator is not a phone: the clipped icons
of 2026-08-09 arrived as a screenshot from the founder's device with the simulator a foot away.
Date each row, and say plainly where it has NOT been checked. -->

| Platform | When | By what |
|---|---|---|
| iOS, physical device | | |
| Android | **never** | |
| Web | | |
