# Cross-cutting UX rules

These are product requirements, not polish. Several were shipped bugs first.

### Loading, errors, empties

1. **Every data-loading screen has three states**: loading, loaded, and a **standard inline
   load-error with a retry**. No screen may fail to a blank page.
2. **Every list has a designed empty state**, and it tells the truth ("No events yet", "No
   upcoming races yet", "No events across your clubs yet"), never a bare blank.
3. **A user who lands somewhere they lack permission is redirected**, never shown a broken
   screen.
4. **Realtime is an enhancement, not a requirement.** Every screen also loads its data
   directly, so a dropped connection degrades to stale-until-refresh rather than broken.

### Destructive actions

5. **Every destructive action is confirmation-gated on every platform**, and the confirmation
   **names the thing** being destroyed and states what is lost.
6. *(current-stack detail, but the lesson generalises)* The native alert API is a **total
   no-op on web**, so a delete button reported success, logged nothing, and did nothing.
   **Verify destructive actions actually changed the data, on every platform.**

### Privacy

7. Profiles are visible only to people who share a club with the viewer.
8. Personal data collected is deliberately minimal: email, name, and optional bio, city, date
   of birth, school.
9. **No analytics, tracking, or third-party data sharing.**
10. **No personal data in a shareable link.** The join link carries only an opaque club invite
    token.

### Performance expectations

| Concern | Expectation |
|---|---|
| Chat history | Never load an entire conversation. ~40 most recent, page backward |
| Notifications | Paginated, ~20 per page |
| Photos/documents | Never inlined in the payload; referenced and fetched separately |
| News feed, races list, rosters | Small enough to load whole (currently unpaginated) |
| Unread counts | **Computed, never stored** - a stored count drifts, a computed one cannot |
| Merged cross-club calendar | One read per feature per club; **the least scalable read in the product** |
| Deadline reminders | Fire within a minute of their window |

**Rule: no screen may block on an unbounded read.**

### Offline

The current build is **online-only**: no cache, no queued sends, no optimistic send. Sending
offline fails **visibly**. This is a known limitation, not a decision - a club coordinating at
a race venue with poor signal is exactly the failure case. See
[Roadmap and open questions](17-roadmap-and-open-questions.md).

### Accessibility

**No accessibility work has been done. This is the product's clearest gap.** Zero
accessibility labels exist; every icon-only control (attach button, pin and announce toggles,
per-message overflow, race pin control, jump-to-latest) is effectively invisible to a screen
reader. Contrast, dynamic type, touch-target sizes, and reduced motion are all unverified.
**The remaster should not repeat this** - see
[Roadmap and open questions](17-roadmap-and-open-questions.md).

### Verification standard

- **Pixel perfection is the standard.** Misaligned rows, inconsistent spacing, a header that
  jumps, a colour off-token, a control a few pixels from where it belongs - all defects worth
  fixing when seen.
- **Reproduce a bug end-to-end before fixing it**, through the running app, on the relevant
  platform, with realistic data. A fix never preceded by a reproduction is a guess, and this
  project's history contains several confident guesses that were wrong.
- **A failing or flaky test and a type error get fixed when seen**, whether or not the current
  change caused them.
