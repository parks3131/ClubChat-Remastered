# News and Highlights

**Purpose.** A durable, scrollable record of club news - results, recaps, photo drops - that
is not competing with chat's message flow. **A pinned chat message is a reference; a news
post is a publication.** The two surfaces coexist deliberately.

| | News feed | Chat Highlights |
|---|---|---|
| Content | Standalone posts authored for the feed | Messages already sent in chat |
| Author | Any club admin | Whoever sent the message |
| Reached from | The club hub (it is the **first row**) | The chat header |
| Tapping a row | Opens the post | Nothing - view-only |
| Scope | Club only | Club, race, and Eboard each have their own |

## What a post carries

Every part except the club and the author is optional, and a post is valid as soon as any one of
the first three is present.

| Part | Notes |
|---|---|
| Title | One line, the headline. Searchable. |
| Body | The text. Hashtags typed in it become the post's tags. |
| Photos | Up to **six**, ordered, all drawn in one shape the author chooses: `1:1`, `4:5` or `16:9`. |
| Location | A name, and optionally a link the name opens. Nothing resolves it to a map. |
| People | Club members named in the post, chosen from a picker. |
| Tags | Extracted from the body's hashtags. Searchable, and the route into a filtered feed. |

## Behaviour rules

1. A post must have **a title, body text, or at least one photo**; an entirely empty post cannot
   be created.
2. The feed is reverse-chronological, newest first, with no pinning or ordering controls.
3. **Any club admin can create, edit, or delete any post**, not only its author.
4. Every club member can read the feed and react. Reactions use the same catalog as chat **and now
   the same behaviour**: a pill for each emoji somebody has used, a picker behind `+`, and a hold
   that opens the sheet saying who. The fixed row of six is gone.
5. A member can add and remove their own reaction, one of each emoji per post.
6. **Creating a post notifies every other club member. Editing or deleting does not** - with one
   exception, in rule 12.
7. Editing reuses the create form, pre-filled. Photos, location, people and tags all survive an
   edit that does not touch them.
8. **Deleting a post is permanent, with no tombstone** - unlike a chat message, there is no
   surrounding conversation that a gap would make unreadable.
9. Every post shows its creator's name, avatar, and post time.

### Photos

10. A post holds **at most six photos**, and the limit is enforced by the composer, the route and
    a constraint. They are ordered, and the author can reorder them before posting.
11. **The author picks one shape for the whole post** and every photo is cropped into it, so the
    card does not change height as the carousel is swiped. The crop happens on the app's own frame
    and is applied by the server. See
    [ADR-0038](../decisions/0038-a-news-post-carries-an-ordered-gallery.md).
12. **A news photo does not enter the chat Gallery.** It is uploaded against the club's main
    channel so that channel's access rules govern it, but it was never posted in a conversation
    and [PRD/13](13-media-and-galleries.md) rule 4 says a gallery holds only what was.

### People

13. **A post may name club members**, chosen from the same picker that adds people to a race
    roster. Only members of that club can be named, and only somebody who may post can name them.
14. **Being named replaces the generic notification rather than adding to it.** A tagged member is
    pushed "you were named" instead of "the club posted", and receives **both** inbox rows, which
    clear against different things. Editing a post notifies the people **newly** named and nobody
    else - the one exception to rule 6. See
    [ADR-0040](../decisions/0040-a-post-names-people-from-its-own-club.md).
15. A tag survives its person leaving the club. The post is a record of something that happened.

### Location and search

16. A post may carry a **location name** and an optional **link** that the name opens. Neither is
    resolved, geocoded or drawn on a map. See
    [ADR-0039](../decisions/0039-a-post-says-where-with-a-name-and-a-link.md).
17. **The feed has a search box**, over titles and tags. It searches within one club's feed, never
    across clubs.
18. **Tapping a tag chip searches for that tag**, which is the same read the box performs.

## Acceptance criteria

- [ ] Title-only, text-only, photo-only, and every combination create successfully.
- [ ] A post with no title, no body and no photo is refused, by the route and by a constraint.
- [ ] An admin who did not author a post can still edit and delete it.
- [ ] Editing without touching the photos keeps all of them, in order.
- [ ] A seventh photo is refused by the composer, the route, and the database independently.
- [ ] Every photo in a post is drawn in the same box, and swiping does not change the card height.
- [ ] A news photo never appears in the club chat's Gallery.
- [ ] Creating notifies every other club member; deleting notifies nobody.
- [ ] A tagged member gets one buzz, not two, and two inbox rows.
- [ ] Editing a post to add a person notifies that person and nobody else.
- [ ] The tag picker offers only members of that club, and refuses a caller who may not post.
- [ ] A member sees no create/edit/delete controls and is redirected off those routes.
- [ ] Deleting asks for confirmation on web as well as native.
- [ ] Searching by a hashtag returns the posts carrying it, and by a title word returns that post.
- [ ] Reacting, opening the picker, and holding a pill to see who all behave as they do in chat.
