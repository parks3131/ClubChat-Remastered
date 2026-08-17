# 40. A post names people, from its own club, through the picker that already exists

Date: 2026-08-16

## Status

Accepted. Extends [PRD/06](../PRD/06-news-and-highlights.md), reuses
`searchMemberCandidates` rather than adding a second member search, and applies the push
subtraction established by [PRD/12](../PRD/12-notifications.md) and the announcement fix of
2026-08-16 (`7508471`).

## Context

The founder asked for it in one sentence: *"tag people is you can tag people from club and it
should pop the search like how we will add people to a race"*.

That sentence names its own precedent, which is the useful part. Adding people to a race roster is
a solved surface in this product: a picker that **lists the club to be scrolled** and falls back to
a **search box** past a hundred, backed by `searchMemberCandidates`, adding *"a whole selection in
one act"*. A post tagging people wants exactly that interaction, on a different pool.

## Decision

### The pool is this club's members, and the predicate is the post's own

A fourth `CandidateTarget`, alongside club, race and Eboard.

`member-candidates.ts` states the rule this has to obey: **"authorization is the add's own
predicate, reused, not a similar one"**, because a search anybody could run *"would leak a club's
roster by exclusion: ask for every candidate, and whoever is missing is a member"*. The add here
is creating or editing a post, and its predicate is `isClubAdmin`. So the tag search asks
`isClubAdmin`, and a caller who may not post gets `not_found` rather than an empty list.

The pool itself is **members of the post's club**, which is the race row's shape keyed on a club
rather than the existing club row's shape. Those differ and the difference matters: the club
target's pool is *anybody sharing a club with the caller*, which is right for inviting somebody
into a club and wrong here. You cannot name somebody in a club they are not in.

**Never a global user search**, which is that module's standing rule and needs no new argument.

### A tag is a row, and it survives the person leaving

`news_post_people(post_id, user_id)`. Cascades when the user is deleted, and does **not** cascade
when they leave the club.

> **`people`, not `tags`.** A post's hashtags live in `news_post_tags`, and one word covering both
> a person and a `#longrun` would be two meanings on one table name in a schema somebody reads at
> three in the morning.

A post is a publication and a record of something that happened. Somebody who ran that route was
on that run whether or not they are still in the club a year later, and quietly unnaming them
would rewrite the record. The card draws the name it stored; what it stops offering is a tap
through to a member of a club they have left.

### Being named replaces the generic buzz, and still writes both rows

Creating a post already notifies every other club member (`news_post_created`). A tagged member
would therefore get two notifications about one post, seconds apart.

**The answer is already written in this codebase, one surface over.** `7508471`, committed this
morning, fixed exactly this for announcements, and its reasoning transfers without amendment:

> the push audience subtracts anybody mentioned - they get the more specific line instead - [...]
> a member named in one is entitled to both: one says the club was told something, the other says
> they were named in it, and they clear against different things. So the subtraction is on the
> push list only, and the two lists are now computed separately.

So: a new `news_post_tagged` type, **both** inbox rows written for a tagged member, and the
`news_post_created` **push** list computed as club members minus the author minus everybody tagged.
A post that tags the entire club leaves that push list empty, and `dispatchPush` already returns
without sending rather than reading an empty list as "everyone".

### Editing a post notifies the people newly named, and nobody else

PRD/06 rule 6 says editing notifies nobody, and that rule is about the post. Being named is not
about the post; it is about the person, and somebody added to a post an hour after it went up has
not been told anything yet.

So an edit sends `news_post_tagged` to the **difference**, never to the whole tag list. Removing a
tag sends nothing and withdraws nothing already delivered, which is the same shape as un-mentioning
somebody in an edited message.

## Consequences

- **A second reason to open a post from the inbox**, with a different subject line. `PRD/12`'s
  target and subject switches both gain a case, and both already have a `news` target to reuse.
- **The picker is one component across four surfaces.** A fix to the roster picker lands on the
  tag picker, which is the argument for extending `searchMemberCandidates` rather than writing a
  post-shaped search beside it.
- **Blocking has to be answered by the candidate read, not by the card.** Two members who have
  blocked each other should not be offered to each other here; the pool is the place to enforce
  that, because a name that appears in a search and refuses on tap teaches that the rule is
  arbitrary. This is an obligation on the new branch rather than something the existing three
  already do.
- **The tag list is bounded by the club**, so no explicit cap is invented. A post naming forty
  people is strange rather than dangerous, and the push list it produces is the club minus itself.

## Rejected alternatives

| Alternative | Why not |
|---|---|
| **`@name` typed inline in the body, like a chat mention** | The mention list component exists and would have cost less. It makes naming somebody a property of the sentence, so editing the text unnames them, and it gives no answer for a photo recap whose body is one line. The founder asked for a picker, and a picker is also the thing that can show faces. |
| **Reusing the `club` candidate target as-is** | One line of work and the wrong pool: it offers anybody sharing *any* club with the caller, so an admin of two clubs could name somebody who is not in this one. |
| **Tagging any user, searched globally** | The privacy surface `member-candidates.ts` was written to refuse. A stranger is reached through the invite link, which ADR-0010 makes the only front door. |
| **A tag notification instead of the club one for everybody** | Would mean a post that tags three people tells only three people, and PRD/06 rule 6 says creating a post tells the club. The subtraction is on the push, not on the audience. |
| **Deleting tags when somebody leaves the club** | Rewrites a record of something that happened, and does it silently, months later, to a post nobody is looking at. |
| **Notifying every tagged person again on edit** | Re-buzzes people who were already told, every time a typo is fixed. The difference is the only set that has learned something new. |
