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

**Behaviour rules**

1. A post must have **body text, a photo, or both**; an entirely empty post cannot be created.
2. The feed is reverse-chronological, newest first, with no pinning or ordering controls.
3. **Any club admin can create, edit, or delete any post**, not only its author.
4. Every club member can read the feed and react. Reactions use the same emoji set as chat.
5. A member can add and remove their own reaction, one of each emoji per post.
6. **Creating a post notifies every other club member. Editing or deleting does not notify.**
7. Editing reuses the create form, pre-filled: leaving the photo untouched keeps it, choosing
   a new one replaces it, clearing it removes it.
8. **Deleting a post is permanent, with no tombstone** - unlike a chat message, there is no
   surrounding conversation that a gap would make unreadable.
9. Every post shows its creator's name, avatar, and post time.

**Acceptance criteria**

- [ ] Text-only, photo-only, and both all create successfully; neither is rejected.
- [ ] An admin who did not author a post can still edit and delete it.
- [ ] Editing without touching the photo keeps it; replacing swaps it; clearing removes it.
- [ ] Creating notifies every other club member; editing and deleting notify nobody.
- [ ] A member sees no create/edit/delete controls and is redirected off those routes.
- [ ] Deleting asks for confirmation on web as well as native.
