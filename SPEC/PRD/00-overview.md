# Overview

### The problem

A sports club (the founding case is a university running club) coordinates itself entirely
through GroupMe plus ad-hoc tools:

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
3. **Deliberately simple where the founder said simple.** Routines carry a title and a
   description, not a structured exercise builder. Races carry a name and a date, not a full
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
- Make weekly training plans first-class, dated, and per-sport rather than a screenshot.
- Work as a **template**: a swim club, a running club, and a climbing club should all fit
  with no customisation work.

### Non-goals (deliberate, do not build)

| Not building | Why |
|---|---|
| Activity/training tracking | Strava exists. ClubChat plans workouts, it does not record them |
| Workout completion tracking | Explicit scoping call - routines are a plan, not a checklist |
| Structured exercise builders (sets/reps/splits) | Explicit "keep it very simple" call |
| RSVP or attendance, anywhere | No attendance concept exists in the product |
| Cross-club discovery or a social graph | Clubs are found by name or invite link, nothing more |
| An "invite-only" club tier | Covered by the `request` policy plus a private share link |
| Threaded replies, message editing, message search | Out of scope by decision |
| Comments on news posts | Discussion belongs in chat |
| Recurring events | Weekly training is Routines' job |

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
