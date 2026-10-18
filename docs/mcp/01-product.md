# 1. What Clubby does

## Who is involved

A **member** asks a question. **Claude**, in the member's own Claude app, understands it and decides
which ClubChat tool to call. **ClubChat** answers with what that member is allowed to see. Clubby is
the name for that whole experience; in stage one there is no separate Clubby program.

## Setting it up, as a member

1. On claude.ai in a browser: Settings, then Connectors, then add a custom connector with the
   address `https://api.clubchatapp.com/mcp`. (Menu names to be confirmed during build step 3.
   Anthropic's older help article says a connector cannot be added from the phone itself.)
2. Claude opens a ClubChat page. The member signs in with their ClubChat email and password, reads
   what Clubby can and cannot do, and presses **Allow**.
3. ClubChat now appears in the Claude phone app too. Ask away.

Any Claude plan can add a custom connector. The founder is on Pro. Free accounts are limited to one
custom connector.

## The 13 things it answers

| # | The member says | Clubby answers with |
|---|---|---|
| 1 | "What clubs am I in?" | Their clubs and their role in each |
| 2 | "What chats does Running Club have?" | Their chats, with unread counts |
| 3 | "What did I miss?" | Unread counts, then the new messages, summarised |
| 4 | "Read me the last few messages in Running Club" | Recent messages from one chat, club or direct |
| 5 | "Did Sam message me?" | Their direct-message conversations |
| 6 | "What's on my calendar this week?" | Events, meetups, meetings and races, upcoming or past |
| 7 | "When and where is the next practice?" | One calendar item in full |
| 8 | "Anything for me?" | Their notifications |
| 9 | "What's pinned in Running Club?" | Pinned messages, or announcements |
| 10 | "What's the latest club news?" | The club's news posts |
| 11 | "Any open polls?" | The club's polls and how the votes stand |
| 12 | "Who's driving Saturday?" | A race: when, where, the car groups and their drivers |
| 13 | "Who's in the club?" | The member list |

Finding "running club Binghamton" from what the member said is Claude's job: it lists the member's
clubs and picks the match, and asks if two match. ClubChat does not build name search.

## What it never does in stage one

- **Change anything.** No sending, replying, voting, reacting, joining, approving, deleting.
- **Mark anything as read.** Unread counts stay where they were, so the member still gets every
  notification they would have got.
- **See more than the app shows.** It acts as the member, with exactly their permissions.
- **Read anybody else's direct messages.** Only conversations the member is part of.

## Typing, dictation and hands-free voice

There are three ways to ask in the Claude app, and the difference matters only in a car:

- **Typing** works.
- **The dictation mic** in the message box works, because speech becomes text before Claude sees it.
- **Hands-free voice mode**, the live spoken conversation where Claude talks back, is the one that
  makes Clubby usable without looking at the phone. Anthropic's documentation does not say whether
  it calls custom connectors. Build step 3 tests it on the phone. A "no" does not stop the project;
  it means Clubby needs a glance at the screen until Anthropic supports it.

## What comes later, and is not part of this plan

- **Stage two, doing things**: send a message (always read back for a "yes" first), reply, send a
  direct message, vote, mute, create an event, meetup or poll, post news. It needs its own plan,
  mainly because chat text reaching the model can try to steer it (see
  [`04-security-and-privacy.md`](04-security-and-privacy.md)).
- **Clubby inside ClubChat**: a mic button in the app, once there is budget for the AI calls. It
  reuses the same tools.
- **"Hey Siri, ask ClubChat"**: needs native iPhone code and a new app build.
