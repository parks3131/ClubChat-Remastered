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
 * > **The mailbox has to actually receive mail before this ships.** A published contact that
 * > bounces is worse than none: a member trying to report something serious gets silence, and it
 * > is the specific thing a reviewer checks by hand. `clubchatapp.com` was registered on
 * > 2026-08-07 and its sending domain is still unverified (ADR-0020), so this address is a
 * > placeholder until somebody confirms a mailbox behind it.
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
