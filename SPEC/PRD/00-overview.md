# Overview

### The problem

A club coordinates itself entirely through GroupMe plus ad-hoc tools. The founding case is a
university running club, and the table below is its version of the problem - but every row of it
restates itself for a theatre, a volunteering group or a history society, with different nouns:

| What they need | What they do today | Why it breaks |
|---|---|---|
| A weekly workout plan | Written in Excel, screenshotted, pasted into chat, manually pinned | Not searchable, not dated, buried by chat volume |
| Race logistics (carpools, meeting times, results) | A brand new GroupMe group per race | Group sprawl, no roster continuity, dies after the race |
| Announcements | A normal message someone remembers to pin | Indistinguishable from chatter |
| A private admin/captain space | A second GroupMe group | Manually maintained, drifts out of sync with who is actually an admin |
| Club calendar | Messages | Nothing is a date |

None of it is structured. It only works because members manually replicate structure the
chat app does not provide.

### The product bet

**Give clubs the structure they are already faking by hand.** Every artifact they improvise
- the pinned workout screenshot, the per-race group chat, the admin side-group, the "who's
driving" thread - becomes a first-class object with its own membership, permissions, and
history.

### Product principles

1. **A Race is a Club nested one level down.** Same shape: membership, roster, chat, its own
   sub-features. Not a special-purpose "event" screen. The admin-only Eboard space is the
   same shape again.
2. **Structure, not features.** Every addition must replace something members currently do
   by hand, not add a new thing to maintain.
3. **Deliberately simple where the founder said simple.** A meetup carries a title and
   a description, not a structured exercise builder. Races carry a name and a date, not a full
   event schema.
4. **Chat is the centre of gravity.** Chat is where a club actually lives. Every other
   feature is reachable from chat, and things created elsewhere post themselves back into
   chat.
5. **Access is earned per space, not inherited.** Being a club admin grants authority over a
   race, but not automatic membership of its chat.

### Goals

- Replace the group-chat app as the club's primary coordination surface.
- Make a race's logistics survive as durable, revisitable structure instead of a disposable
  group chat.
- Make a club's recurring week first-class and dated rather than a screenshot, **in whatever
  words that club uses for it** - workouts, rehearsals, shifts, readings.
- Work as a **template for any club**, not only any sport. A swim club, a chess club, a theatre
  and a history society should all fit **with nothing to configure**, because no surface names a
  sport or asks what kind of club this is.
  *(Widened from "a swim club, a running club, and a climbing club" on 2026-08-14. The old wording
  was true and too small: it held only while every club was a sports club. What made the wider
  version affordable was deleting the last sport-specific field rather than making it
  configurable - [ADR-0029](../decisions/0029-a-meetup-answers-where-when-and-what.md).)*

### Non-goals (deliberate, do not build)

| Not building | Why |
|---|---|
| Activity/training tracking | Strava exists. ClubChat plans what a club will do, it does not record what anybody did |
| Completion tracking of any kind | Explicit scoping call - Weekly Meetups is a plan, not a checklist |
| Structured exercise builders (sets/reps/splits) | Explicit "keep it very simple" call |
| RSVP or attendance, anywhere | No attendance concept exists in the product |
| Cross-club discovery or a social graph | Clubs are found by name or invite link, nothing more |
| An "invite-only" club tier | Covered by the `request` policy plus a private share link |
| Threaded replies, message editing, message search | Out of scope by decision |
| Comments on news posts | Discussion belongs in chat |
| Recurring events | **Weakened 2026-08-14, and now an open question rather than a non-goal.** The stated reason was that weekly training is Routines' job, which held while every club trained. A chess club's Tuesday club night genuinely is an event, happens 52 times, and wants the notification that [Weekly Meetups](08-weekly-meetups.md) withholds by default. Nothing is built yet; the reason for not building it no longer stands on its own. See that spec's open questions |

> **Reversed 2026-07-28: direct messages.** DMs were a non-goal in v1, on the reasoning that
> every conversation is scoped to a club, a race, or an Eboard. They are now **in scope for the
> remaster** as a fourth channel scope, restricted to members who share a club. **Group chat
> remains the main feature; DMs are additive and must never become the centre of gravity.** See
> [Direct messages](14-direct-messages.md). The reversal carries an obligation: it moves member blocking
> and a report destination from "important, not blocking" into the same release as the feature.

### Platforms

iOS, Android, and web from one codebase. Phone-first, portrait only. Web is primarily a
development and testing surface but is fully functional. **Any behaviour must work
identically on all three**; confirmation dialogs, file pickers, camera capture, clipboard,
and sharing each behave differently per platform and each has caused a shipped bug.
