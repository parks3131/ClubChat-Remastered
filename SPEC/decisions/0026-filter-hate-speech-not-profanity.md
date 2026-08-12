# 26. Filter hate speech, not profanity, and send the ambiguous cases to a human

Date: 2026-08-12

## Status

Accepted.

## Context

App Store guideline 1.2 requires four things of any app carrying user-generated content:

- a method for filtering objectionable material from being posted to the app
- a mechanism to report offensive content and timely responses to concerns
- the ability to block abusive users from the service
- published contact information so users can easily reach you

Three shipped earlier: reporting and blocking in Phase 3.5, and acting on a report plus a
published support address on 2026-08-11 ([ADR-0023](0023-a-moderator-may-remove-a-reported-message-and-suspend-an-account.md)).
The rejection boilerplate Apple sends adds a EULA stating no tolerance for objectionable content
and a commitment to act within 24 hours, both of which the Terms screen already carried.

**Filtering was the one with no implementation**, and it was deliberately left unbuilt because it
is the only one of the four that changes what happens when somebody presses send. Google Play's
UGC policy asks for the same shape and is stricter about direct messages.

Two facts about this product bound the decision. The founding case is a **university running
club**, so the chat is loud, profane and affectionate, and members will work around a filter that
refuses them. And the product has **private one-to-one conversations** in it, which is the surface
where real harm happens and where no admin is party to the conversation.

## Decision

**Filter for hate speech and refuse it at send. Do not filter profanity. Send the genuinely
ambiguous terms to the moderation queue instead of judging them.**

Three parts.

**1. The target is guideline 1.1.1's definition, not swearing.** Apple defines objectionable as
*"defamatory, discriminatory, or mean-spirited content, including references or commentary about
religion, race, sexual orientation, gender, national/ethnic origin, or other targeted groups"*.
That is slurs and targeted harassment. The refuse list contains no ordinary swearing at all, and
`fucking brutal` about a hill workout is asserted to send in both the unit and integration tests.

**2. Two tiers.** A term is refused only if no message in a sports club chat could legitimately
contain it. Everything ambiguous - `nigga`, used in-group; `chink`, as in a chink in the armour;
`retard`, as college shorthand; the `kys` family, which is hyperbole between friends and a genuine
push toward self-harm in identical words - **posts normally and files an automatic report**. A
human decides, using the queue, the removal power and the suspension power that already exist.

**3. The flag tier files an ordinary report as the seeded system actor.** No new table, no new
reader, no new screen. The per-space Reports tab, the DM queue, dismissal, message removal and
account suspension all work on it unchanged.

Alongside it, and required by the same reasoning: **the minimum age is 18**, declared at sign-up
and in the Terms.

## Consequences

### Positive

- The filter is invisible to normal use. Nothing a running club ordinarily says is refused.
- It costs nothing per message and performs no I/O, so it sits inside `sendMessage` without
  touching the channel-log invariant that the sequence-allocating transaction performs no I/O.
- The review answer is specific: here is the filter, here is Apple's own definition of
  objectionable, here is why it is scoped to that rather than to swearing.
- The 18+ minimum keeps the product out of the children's-privacy regimes that a DM surface would
  otherwise pull it into, and it settles the age rating declared to both stores.

### Negative

- **A term list catches slurs and nothing else.** Bullying, exclusion, grooming, coordinated
  harassment and a threat phrased politely all pass it, and each is a likelier harm in a real club
  than a slur is. Those remain the job of reporting, blocking and the queue. This must never be
  cited as covering them.
- **The flag tier files false positives on purpose.** "A chink in the armour" reaches a moderator
  who dismisses it in one tap. That cost is accepted so that nobody is refused mid-sentence for an
  English idiom, and it is asserted as a test so it reads as a decision rather than a bug.
- **Letter-repetition evasion is not caught.** `niiiigger` passes. Catching it needs repeated
  letters squeezed to one in the text and in the term, which collapses `Nigeria` and the country
  `Niger` onto the slur. Refusing a member for naming where they are from is a worse failure than
  the evasion, so the trade was refused.
- **It reads message bodies only.** Not images, not documents, not display names.
- Declaring an age rather than collecting a date of birth is a claim, not a check. Collecting
  birthdates would gather more personal data about every member to verify something almost none of
  them would misstate, which is the wrong trade for a club app.

## Alternatives rejected

**A profanity list.** The obvious reading of "filtering objectionable material", and wrong twice
over: it refuses ordinary college chat constantly while catching almost nothing guideline 1.1.1
describes. It would also train members to evade the filter, which makes every later signal worse.

**A public word list, used whole.** The best-known is LDNOOBW (CC-BY-4.0, maintained by
Shutterstock). Its own README says it exists to decide *"what wouldn't we want to suggest that
people look at"* - it filters autocomplete, not human speech - and blends profanity, sexual terms
and slurs into one undifferentiated pile. Useful as a seed to curate from, not as a filter.

**A language model scoring every message.** Rejected on architecture before cost. The
`last_seq` row lock is held until commit, so a network call in the send path serializes an entire
channel behind an API round trip ([Channel log](../TECH/02-channel-log.md)). Scoring
asynchronously in the worker would avoid that and remains open as a future upgrade to the *flag*
tier specifically, where a better signal would reduce queue noise rather than change what is
refused.

**Flagging everything and refusing nothing.** Zero user friction and a reviewer can reasonably
answer that nothing is actually prevented from being posted, which is what the guideline asks for.

**Doing nothing, and arguing reactive moderation is proportionate.** Defensible for small,
real-name, invite-scoped clubs, and it was the founder's starting instinct. Rejected because
filtering is an explicit required bullet and the likeliest thing a reviewer asks about.

**Refusing the `kys` family outright.** It is the term most likely to precede real harm and the
most likely to be a joke. Refusing it would be the false-positive failure this ADR exists to
avoid, aimed at the most common phrase on the list; flagging it puts a person in front of exactly
the case where a person is needed.
