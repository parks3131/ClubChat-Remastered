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
never chooses which token to show** - it renders whatever the server gave this viewer, so there is
no branch here to get wrong and no way for a member to be shown the admin string.

> **The screen does not explain what the link does either, and that was decided the hard way.**
> *(2026-08-12, in two steps.)* A caption was added saying "anyone who scans this joins the club
> straight away, even if it normally asks people to request" - which required the server to send
> what the viewer's link does, since the screen genuinely cannot tell the tiers apart and deriving
> it from "is this an admin" is only half the rule (the half it misses tells a member of an **open**
> club their link needs approval).
>
> Then it was removed on sight, and the reason is better than the engineering that preceded it:
> **the sentence was accurate and still read as a warning.** "Even if it normally asks people to
> request" names an exception to a rule the reader had not been thinking about, on a surface whose
> entire job is to be held out to another person. It invites somebody to wonder whether they are
> doing something they should not.
>
> **The behaviour is unchanged and is not in doubt** - an admin's link admits outright, a member's
> obeys the policy - it is simply not narrated on this screen. The server field added to support
> the caption was reverted with it rather than left as an unread answer.

## Where it is one screen and used to be two

**Merged 2026-08-12.** Share club listed rows - copy, code, share to - with the code a tap further
in, on the reasoning that a code "wants the whole screen". It does, so it became the screen: the
code is what opens, and the rows are two buttons beneath it. There is no separate QR route.

The thing that made the split look right is the thing that killed it. Somebody sharing a club in
the room is not choosing between three ways to do it; they are holding up a phone. The rows put a
menu in front of the only action that case needs.

## Anatomy

| Part | What it is |
|---|---|
| `crest` | The club's picture, a circle straddling the card's top edge. It is the preview: whose club this is, before a word is read. |
| `card` | The white panel holding the code, the club's name and "Join on ClubChat". |
| `code` | The link as a scannable square, black on white, quiet zone intact. |
| `actions` | Two pills: scan somebody else's code, or copy this one's link. |
| `note` | The one limitation worth stating: a code does nothing on a phone without ClubChat. |
| `toast` | The confirmation that a copy happened. |
| `rotate` | Admin only, below everything. Invalidates every outstanding link, and confirms before it does. |

## Rules that must survive

1. **The preview shows what the recipient sees, not what the sender is sending.** A URL is not a
   preview. The picture and the name are the two facts that make an unsolicited link legible, and
   the third - "Join on ClubChat" - is what tapping it does.

2. **A club with no picture gets its letter, not a coloured rectangle.** The lettered fallback is
   the ordinary case rather than a failure, exactly as [Avatar](02-avatar.md) has it. A flat tint
   with nothing in it reads as a photograph that did not load.

3. **The two pills are equals, and neither is the primary.** Showing a code and sending a link are
   the same act by different means - which one is right depends only on whether the other person is
   in the room. Styling one as secondary would be guessing at that. *(This rule replaced a
   chevron rule on 2026-08-12: when the surface was a list of rows, the chevron distinguished a row
   that goes somewhere from one that acts in place. There are no rows left.)*

3a. **Scanning belongs here even though it is not sharing.** It is the other half of the same
   moment: one person holds up a code and the other points a phone at it, and putting the two on
   separate screens means the pair have to find different places in the app to do one thing.

4. **A copy that fails says so.** The confirmation is not decoration: it is the only evidence the
   member has, because a clipboard cannot be inspected from inside the app. A failed write that
   showed nothing would let somebody walk away believing they hold the link.

5. **Rotation lives with the link, one confirmation away, and never beside the share actions.**
   It is the only destructive control on the surface and it destroys **other people's** outstanding
   invitations, which the confirmation says in those terms.

6. **The code is dark on white with its quiet zone intact, whatever the frame around it is.** The
   accent belongs to the frame. Modules in the brand colour read as ours to a person and as a maybe
   to a camera, and a code cropped to its own edge is one a scanner cannot find at all.

   6a. **Nothing sits in the middle of the code**, because the club's face is already the largest
   thing on the screen directly above it - two copies of one photograph a centimetre apart is
   repetition rather than identification. That is not only tidiness: **a picture over the middle is
   what forces the highest error-correction level**, and that level buys its tolerance by spending
   modules on redundancy. With nothing to survive, the same link is drawn in fewer, larger modules -
   which is the whole game when somebody is reading it off a phone across a table. See
   `src/qr-code.tsx`, where the level follows the logo rather than being fixed.

7. **The code says who it is for.** It carries an app-scheme link, so it opens the club for
   somebody who already has ClubChat and does nothing at all for somebody who does not - no prompt,
   no error, no page. Until an https join page exists, the screen says this in words rather than
   letting a member discover it at a club fair.

8. **The screen states the LIMITATION and not the rules.** "Scanning works for people who already
   have ClubChat" stays, because a code that does nothing on a phone without the app fails silently
   in somebody's hand and `PRD/04` rule 5c requires saying so. What went is the sentence explaining
   whether the link admits or queues: accurate, and it read as a warning about something nobody had
   asked. A limitation is a fact the holder needs; a rule is a thing the product should just do.

9. **The scanner refuses the world quietly.** Almost everything a camera is pointed at is not a
   ClubChat code, so a wifi password or a menu leaves the scanner running and says only that it was
   not ours. It never navigates on a guess.

10. **A scan joins through the same path a tapped link does.** It resolves a token and hands it to
    the join screen, which already answers all five outcomes - joined, requested, banned, revoked,
    signed-out-and-back. Scanning is a new way to *acquire* a link, never a second way to redeem
    one, so a ban and the two link tiers behave identically however the link arrived.

## Obligations this creates elsewhere

- **Nothing inside the code may contain an apostrophe**, including any text a club could name.
  Exporting the image serialises the SVG into a `data:` URL with single quotes as attribute
  delimiters, so one apostrophe anywhere makes the whole export fail silently. The club's name is
  therefore drawn by the screen around the code and never inside it. Recorded in
  `AGENTS.md` failure mode 23, because it is invisible everywhere except the save button.
- **Every screen here reserves clearance for the floating tab bar**, per [Tab bar](01-tab-bar.md).
