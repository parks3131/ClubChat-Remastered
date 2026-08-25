/**
 * Every page this Worker renders, and every sentence it says.
 *
 * The copy is in one file on purpose. The apex served nothing at all before this Worker, and a page
 * that appears on an empty apex is exactly where a testimonial, a price and a launch date turn up
 * without anybody having agreed to them. Keeping every word here means the whole of what the
 * product claims about itself is one file to read, and `landing.test.ts` holds a list of words that
 * must not appear in it.
 *
 * **Nothing below states anything that is not true of the software today.** No pricing, no user
 * numbers, no dates, no screenshots, no roadmap.
 */

import { escapeHtml, page } from './html.ts';
import type { InvitePreview } from './invite.ts';
import { installUrl, type Env } from './env.ts';

/** One sentence about the product, used on the landing page and under the invite. */
const WHAT_IT_IS =
  'ClubChat is a private app for running a club: chat, a calendar, announcements and a member ' +
  'list, in one place.';

/**
 * The button that hands a visitor the app, or null while there is nowhere to hand them to.
 *
 * **One label for both destinations.** `IOS_INSTALL_URL` may hold an App Store listing or a public
 * TestFlight link, and "ClubChat on the App Store" would be a false label for the second. "Get
 * ClubChat for iPhone" is true of either, which is what keeps the switch a configuration change
 * rather than a copy change.
 *
 * `escapeHtml` on a URL this Worker holds in its own var, which is belt and braces rather than
 * theatre: a var is editable in the Cloudflare dashboard by anybody with access to the account, and
 * a page that escapes four of its five interpolations is the page this project would rather not
 * ship. `installUrl` has already refused anything that is not an `https:` URL.
 */
function installButton(env: Env, secondary: boolean): string | null {
  const url = installUrl(env);
  if (url === null) return null;
  const className = secondary ? 'button button-secondary' : 'button';
  return `<a class="${className}" href="${escapeHtml(url)}">Get ClubChat for iPhone</a>`;
}

/** The deep link an installed app answers. The token is charset-checked before it gets here. */
function openInAppButton(token: string): string {
  return `<a class="button" href="clubchat://join/${escapeHtml(token)}">Open in ClubChat</a>`;
}

/**
 * A row of buttons, or nothing at all.
 *
 * The `nothing at all` case is the reason this is a function. `.actions` is a flex row with a gap
 * and a top and bottom margin, so emitting it empty leaves a visible hole that reads as a button
 * which failed to render - on a page whose whole job is to be trusted by somebody who has never
 * heard of this product. A page with no button must look like a page that has no button.
 */
function actions(...buttons: readonly (string | null)[]): string {
  const present = buttons.filter((button): button is string => button !== null);
  return present.length === 0 ? '' : `<div class="actions">${present.join('')}</div>`;
}

/**
 * What the pages say instead of a download button, and the only place they say it.
 *
 * ClubChat has never been released - App Store Connect app id 6804458376 has no listing behind it
 * and distribution is TestFlight internal only - so there is no honest download button to render.
 * The honest answer costs no infrastructure and is true today: say that it is a private beta and
 * that the way in is the person who invited you.
 *
 * **It disappears on its own.** The notice is rendered only while `installUrl(env)` is null, so the
 * same var that turns the button on turns this off. Nothing here has to be edited when the app
 * ships, which is the property that stops a "private beta" line outliving the private beta.
 *
 * `nextStep` is the one sentence that differs by page: the landing page is read by somebody who may
 * have no invite at all, and a join page is read by somebody holding one.
 */
function betaNotice(env: Env, nextStep: string): string {
  if (installUrl(env) !== null) return '';
  return (
    '<div class="notice">ClubChat is in private beta. It is not on the App Store, and the only ' +
    `way to get it is an invite from somebody already using it. ${nextStep}</div>`
  );
}

/** "1 member" and "12 members", or nothing at all when the api did not say. */
function memberLine(memberCount: number | null): string {
  if (memberCount === null) return '';
  const noun = memberCount === 1 ? 'member' : 'members';
  return `<p class="meta">${memberCount} ${noun}</p>`;
}

export function landingPage(env: Env): string {
  const main = [
    '<h1>ClubChat</h1>',
    `<p class="lede">${WHAT_IT_IS}</p>`,
    '<p>Clubs are invite only. There is no public directory, and no way to browse or join a club ',
    'without a link from somebody who is already in it.</p>',
    '<p>If somebody sent you an invite link, open it on the phone you want to use ClubChat on.</p>',
    actions(installButton(env, false)),
    betaNotice(env, 'If somebody has invited you to their club, ask them to add you to the beta.'),
    '<p class="meta">Read the <a href="/privacy">privacy policy</a> and the ',
    '<a href="/terms">terms of service</a>.</p>',
  ].join('');

  return page({
    title: 'ClubChat',
    description: WHAT_IT_IS,
    main,
  });
}

/**
 * The join page for a token the api recognised.
 *
 * `clubName` is the untrusted string. It reaches the `<h1>` escaped here, and the `<title>` and the
 * three `<meta>` tags escaped by `page()`, which is handed it raw exactly once. `escaping.test.ts`
 * asserts all five separately.
 */
function livePage(env: Env, token: string, clubName: string, memberCount: number | null): string {
  const install = installButton(env, true);
  const main = [
    '<p class="meta">You have been invited to join</p>',
    `<h1 class="club-name">${escapeHtml(clubName)}</h1>`,
    memberLine(memberCount),
    actions(openInAppButton(token), install),
    betaNotice(env, 'Ask whoever sent you this link to add you to the beta.'),
    `<p>${WHAT_IT_IS}</p>`,
    '<p class="meta">If ClubChat is already on this phone, opening this link takes you straight ',
    'into the club.',
    // Only said when it is possible. "Install it first" is an instruction that cannot be followed
    // while there is nothing to install, and this page is read by somebody standing next to a QR
    // code who has no other source of truth about what to do.
    install === null ? '' : ' If it is not, install it first and open the link again.',
    '</p>',
  ].join('');

  return page({
    title: `Join ${clubName} on ClubChat`,
    description: `${clubName} invited you to ClubChat. Open this link on your phone to join.`,
    main,
    noindex: true,
  });
}

/**
 * The join page for a token the api refused.
 *
 * **No deep link on this page.** Offering one would hand the visitor to an app that is about to
 * show them the same refusal, which is worse than saying it here once. The download stays, because
 * somebody who is about to be sent a working link is better off with the app already installed -
 * and while there is no download, the private-beta notice says the same thing in words.
 *
 * It does not distinguish expired from revoked from never-existed, because the api deliberately
 * does not either: `POST /invites/:token/redeem` answers one 404 for all three.
 */
function invalidPage(env: Env): string {
  const main = [
    '<h1>This invite link is not valid any more</h1>',
    '<div class="notice notice-error">We checked, and this link does not open any club.</div>',
    '<p>Invite links stop working when a club changes its link, and a link that was copied ',
    'incompletely looks the same from here.</p>',
    '<p>Ask whoever shared it with you for a new one.</p>',
    actions(installButton(env, true)),
    betaNotice(env, 'Ask them to add you to the beta at the same time.'),
  ].join('');

  return page({
    title: 'This invite link is not valid any more',
    description: 'This ClubChat invite link does not open any club.',
    main,
    noindex: true,
  });
}

/**
 * The join page when the api could not be reached.
 *
 * The one thing it must not do is guess. It does not name a club, because it does not know one, and
 * it does not say the invite is dead, because it has no evidence of that: the likeliest truth is
 * that the link is fine and something between this Worker and the api is not. Both ways into the
 * app stay, because both of them work without this page knowing anything.
 */
function degradedPage(env: Env, token: string): string {
  const main = [
    '<h1>Open this invite in ClubChat</h1>',
    '<div class="notice">We could not reach ClubChat just now, so this page cannot tell you ',
    'which club the invite is for. The link itself is probably fine.</div>',
    actions(openInAppButton(token), installButton(env, true)),
    betaNotice(env, 'Ask whoever sent you this link to add you to the beta.'),
    `<p>${WHAT_IT_IS}</p>`,
  ].join('');

  return page({
    title: 'Open this invite in ClubChat',
    description: 'Open this ClubChat invite on your phone to join the club.',
    main,
    noindex: true,
  });
}

/** The join page, and the status it is served with. */
export function joinPage(
  env: Env,
  token: string,
  preview: InvitePreview,
): { html: string; status: 200 | 404 } {
  switch (preview.state) {
    case 'live':
      return { html: livePage(env, token, preview.clubName, preview.memberCount), status: 200 };
    case 'invalid':
      return { html: invalidPage(env), status: 404 };
    default:
      // 200, not 503. The page is a complete and useful answer - it carries both ways into the app
      // and says plainly what it does not know - and a status that says "this page failed" would be
      // a false statement about a page that did not.
      return { html: degradedPage(env, token), status: 200 };
  }
}

/** The page for a token that never reached the api, because it is not shaped like one. */
export function invalidInvitePage(env: Env): string {
  return invalidPage(env);
}

export function notFoundPage(): string {
  const main = [
    '<h1>Page not found</h1>',
    '<p>There is nothing at this address. ',
    '<a href="/">Go to the ClubChat home page</a>.</p>',
  ].join('');

  return page({
    title: 'Page not found',
    description: 'There is nothing at this address on clubchatapp.com.',
    main,
  });
}

/**
 * `robots.txt`.
 *
 * The one rule that matters is `Disallow: /join/`. An invite URL IS the invite - the token in the
 * path is the whole credential - so a crawler that indexed one would publish a working invite link
 * to a private club. The `X-Robots-Tag` header and the `noindex` meta on those pages say the same
 * thing twice more, because a crawler that ignores one of the three is not hypothetical.
 */
export const ROBOTS_TXT = ['User-agent: *', 'Disallow: /join/', 'Allow: /', ''].join('\n');
