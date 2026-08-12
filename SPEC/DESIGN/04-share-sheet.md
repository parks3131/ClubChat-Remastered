# Surface: share sheet

## Purpose

Handing a club to somebody. One screen holding every way the join link can travel - copied, sent
through another app, or held up as a code - plus a preview of what the recipient will see.

Without it the link is a raw string behind a button, which tells the person receiving it nothing
about whose club they are being asked to join, and gives the person sending it no way to invite
somebody standing in front of them.

## Where it appears

The club, reached from its profile. Nowhere else, and the two absences are deliberate:

- **A race has no share sheet.** A race is never joined by link - access is by request or by an
  admin adding somebody ([PRD/09](../PRD/09-races-and-meets.md)).
- **The Eboard space has none either.** Its membership tracks the admin list and is not invitable.

Every member of the club sees it ([ADR-0024](../decisions/0024-every-member-holds-the-clubs-invite-link.md)),
and each tier is handed its own link: an admin's joins instantly, a member's obeys the club's join
policy ([ADR-0025](../decisions/0025-a-members-invite-link-obeys-the-join-policy.md)). **The screen
cannot tell them apart and must not try** - it renders whatever the server gave this viewer, so
there is no branch here to get wrong and no way for a member to be shown the admin string.

## Anatomy

| Part | What it is |
|---|---|
| `preview` | The club as the recipient will meet it: its picture, its name, and what tapping the link does. |
| `rows` | The ways out: copy, code, and the system share sheet. |
| `toast` | The confirmation that a copy happened. |
| `rotate` | Admin only. Invalidates every outstanding link, and confirms before it does. |
| `code` | The second screen: the link as a scannable square, with the club's picture in it. |

## Rules that must survive

1. **The preview shows what the recipient sees, not what the sender is sending.** A URL is not a
   preview. The picture and the name are the two facts that make an unsolicited link legible, and
   the third - "Join on ClubChat" - is what tapping it does.

2. **A club with no picture gets its letter, not a coloured rectangle.** The lettered fallback is
   the ordinary case rather than a failure, exactly as [Avatar](02-avatar.md) has it. A flat tint
   with nothing in it reads as a photograph that did not load.

3. **The chevron means a destination.** Copy Link acts and stays put, so it carries none. Every
   other row goes somewhere and carries one. A chevron on an action promises a screen that never
   arrives - which is why `Row` grew an explicit override rather than the screen forking it.

4. **A copy that fails says so.** The confirmation is not decoration: it is the only evidence the
   member has, because a clipboard cannot be inspected from inside the app. A failed write that
   showed nothing would let somebody walk away believing they hold the link.

5. **Rotation lives with the link, one confirmation away, and never beside the share actions.**
   It is the only destructive control on the surface and it destroys **other people's** outstanding
   invitations, which the confirmation says in those terms.

6. **The code is dark on white with its quiet zone intact, whatever the tile around it is.** The
   accent belongs to the frame. Modules in the brand colour read as ours to a person and as a maybe
   to a camera, and a code cropped to its own edge is one a scanner cannot find at all. See
   `src/qr-code.tsx`, which holds the reasoning and the error-correction level the club's picture
   costs.

7. **The code says who it is for.** It carries an app-scheme link, so it opens the club for
   somebody who already has ClubChat and does nothing at all for somebody who does not - no prompt,
   no error, no page. Until an https join page exists, the screen says this in words rather than
   letting a member discover it at a club fair.

## Obligations this creates elsewhere

- **Nothing inside the code may contain an apostrophe**, including any text a club could name.
  Exporting the image serialises the SVG into a `data:` URL with single quotes as attribute
  delimiters, so one apostrophe anywhere makes the whole export fail silently. The club's name is
  therefore drawn by the screen around the code and never inside it. Recorded in
  `AGENTS.md` failure mode 23, because it is invisible everywhere except the save button.
- **Every screen here reserves clearance for the floating tab bar**, per [Tab bar](01-tab-bar.md).
