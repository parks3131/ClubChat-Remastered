/**
 * How somebody reaches a human.
 *
 * > **Apple's App Review guideline 1.2 requires published contact information** for any app
 * > carrying user-generated content, alongside a report mechanism, the ability to block abusive
 * > users, and acting on reports within 24 hours. ClubChat had the middle two and neither of the
 * > outer ones. This is the last of them.
 *
 * One constant, in one module, because the address appears on three surfaces - the Terms, the
 * Privacy Policy and the Profile screen - and three copies of a contact address is three chances
 * to update two of them.
 *
 * > **The mailbox receives, as of 2026-08-25, and until that day it did not.** A published
 * > contact that bounces is worse than none: a member reporting something serious gets silence,
 * > and it is the specific thing a reviewer checks by hand. This address returned
 * > `550 Address does not exist` for its entire life up to that date, on a domain whose MX records
 * > pointed at Namecheap's forwarding service - which cannot work here, because Namecheap only
 * > forwards for domains using its own nameservers and this one uses Cloudflare's. The records
 * > were present and inert, which is why nothing looked wrong.
 * >
 * > It is now a Cloudflare Email Routing rule to the founder's inbox, proved by an SMTP `RCPT TO`
 * > returning `250` rather than by sending a test message and watching for a bounce. **That
 * > distinction is the lesson**: the first check of this address read a message in the Sent folder
 * > as proof of delivery, and the bounce arrived afterwards.
 */
export const SUPPORT_EMAIL = 'support@clubchatapp.com';

/**
 * A `mailto:` for the support address, with the subject prefilled.
 *
 * The subject is a courtesy rather than a routing mechanism - nothing parses it - but it means a
 * member reporting something urgent does not have to invent a way to say so.
 */
export function supportMailto(subject = 'ClubChat support'): string {
  return `mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent(subject)}`;
}
