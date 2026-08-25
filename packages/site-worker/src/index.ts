/**
 * `clubchatapp.com`: the apex site Worker.
 *
 * ## What it is for
 *
 * Invites are link only, and the link was `clubchat://join/<token>`. A custom scheme is nothing at
 * all to a device that does not have the app: a club QR code taped to a table, scanned by somebody
 * who has never heard of ClubChat, produced a blank camera and no explanation. The apex served
 * nothing, so there was nowhere for that person to land.
 *
 * This Worker is that landing place, and the same https URL does double duty: with the app
 * installed, iOS and Android open it directly through the association files below and this page is
 * never fetched; without it, the page explains what the invite is and where to get the app.
 *
 * ## The routes, in the order they are matched
 *
 * | Path | What it is |
 * |---|---|
 * | `/` | The landing page |
 * | `/styles.css` | The whole stylesheet, so no page carries an inline style |
 * | `/robots.txt` | `Disallow: /join/` |
 * | `/.well-known/apple-app-site-association` | iOS universal links |
 * | `/.well-known/assetlinks.json` | Android app links |
 * | `/__parity` | What this Worker is configured with, for diagnosis |
 * | `/privacy`, `/terms` | The two legal documents, rendered from `docs/legal/*.md` |
 * | `/join/:token` | The invite page |
 * | anything else | A 404 with a page on it |
 *
 * There is no router library and no route table, matching `packages/cdn-worker`: sequential guards
 * on one normalised pathname, in one function, read top to bottom.
 *
 * ## Two properties worth stating before reading the code
 *
 * **`/join/:token` is the only route that makes an outbound request, and every other route answers
 * with the api down.** The association files especially: Apple and Google fetch them on their own
 * schedule, and one that 5xxs during an api outage breaks universal links for far longer than the
 * outage lasts. `test/routing.test.ts` arms a tripwire on `fetch` for every other route rather than
 * inferring this from a status code.
 *
 * **Nothing here can throw into a 500.** There is no Sentry at the edge and no alert on a 5xx rate,
 * exactly as `packages/cdn-worker` records, so an exception becomes a Cloudflare error page nobody
 * is counting. The one thing that can plausibly fail on a well-formed request is the api call, and
 * `readInvitePreview` turns every failure of it into a page.
 */

import {
  AASA_PATH,
  ASSETLINKS_PATH,
  appleAppSiteAssociation,
  assetLinks,
} from './associations.ts';
import { androidFingerprints, apiOrigin, installUrl, type Env } from './env.ts';
import { page } from './html.ts';
import { inviteTokenFromPath, readInvitePreview } from './invite.ts';
import { isLegalPath, LEGAL_DOCUMENTS } from './legal.ts';
import { markdownTitle, renderMarkdown } from './markdown.ts';
import { invalidInvitePage, joinPage, landingPage, notFoundPage, ROBOTS_TXT } from './pages.ts';
import { STYLESHEET } from './styles.ts';

const PARITY_PATH = '/__parity';

/**
 * On every response, refusals included.
 *
 * `default-src 'none'` with no `script-src` beside it is what makes "this site has no JavaScript"
 * an enforced property rather than a description of today's code: scripts fall back to `default-src`
 * and there is nothing to fall back to. `style-src 'self'` is the single exception, and it is why
 * the stylesheet is a route rather than an inline block - `unsafe-inline` would be a blanket
 * permission bought to save one request.
 *
 * `referrer-policy: no-referrer` is not boilerplate here. The invite token is IN THE URL, so every
 * outbound click from a join page would otherwise carry a working invite to a private club in the
 * `Referer` header - to the App Store, and to anything else ever linked from these pages.
 *
 * `strict-transport-security` without `includeSubDomains` and without `preload`, deliberately.
 * `api.` and `ws.` are grey-clouded Fly origins that this Worker does not own, and a zone-wide
 * commitment on their behalf is not this file's to make.
 */
const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
  'strict-transport-security': 'max-age=31536000',
  'content-security-policy':
    "default-src 'none'; style-src 'self'; base-uri 'none'; form-action 'none'; " +
    "frame-ancestors 'none'",
};

/** An hour on the two files a platform fetches, so a correction propagates within the day. */
const ASSOCIATION_CACHE = 'public, max-age=3600';
/** Five minutes on a page, which is short enough that a legal correction is not stuck anywhere. */
const PAGE_CACHE = 'public, max-age=300';
/** A day on the stylesheet, which changes only when this Worker is redeployed. */
const ASSET_CACHE = 'public, max-age=86400';

type Send = {
  readonly status: number;
  readonly body: string;
  readonly contentType: string;
  readonly cacheControl: string;
  readonly extra?: Readonly<Record<string, string>>;
};

/**
 * One response builder, so no route can forget a header.
 *
 * The HEAD case is built explicitly rather than left to the runtime to strip, matching
 * `packages/cdn-worker`, and carries `Content-Length` by hand because there is no body for it to be
 * inferred from - which is the whole reason a client sends a HEAD.
 */
function send(request: Request, options: Send): Response {
  const headers = new Headers({
    ...SECURITY_HEADERS,
    'content-type': options.contentType,
    'cache-control': options.cacheControl,
    ...options.extra,
  });

  if (request.method === 'HEAD') {
    headers.set('content-length', String(new TextEncoder().encode(options.body).length));
    return new Response(null, { status: options.status, headers });
  }
  return new Response(options.body, { status: options.status, headers });
}

/** An HTML page. */
function html(request: Request, body: string, status = 200, cacheControl = PAGE_CACHE): Response {
  return send(request, {
    status,
    body,
    contentType: 'text/html; charset=utf-8',
    cacheControl,
  });
}

/** A JSON document, serialised here rather than through `Response.json`, so HEAD works too. */
function json(request: Request, value: unknown, cacheControl: string): Response {
  return send(request, {
    status: 200,
    body: JSON.stringify(value),
    contentType: 'application/json; charset=utf-8',
    cacheControl,
  });
}

/** One of the two legal documents, rendered. */
function legalPage(request: Request, pathname: '/privacy' | '/terms'): Response {
  const document = LEGAL_DOCUMENTS[pathname];
  const title = markdownTitle(document.markdown) ?? document.fallbackTitle;
  return html(
    request,
    page({
      title,
      // The description is built here rather than scraped out of the document, because the first
      // paragraph of a privacy policy is not a summary of it and would read as a claim about its
      // contents in a search result.
      description: `The ClubChat ${title.toLowerCase()}.`,
      main: renderMarkdown(document.markdown),
    }),
  );
}

/**
 * `GET /__parity`, the same convention the CDN Worker follows, pointed at this Worker's failures.
 *
 * Every misconfiguration this Worker can have is silent and presents somewhere else: a wrong
 * `API_ORIGIN` looks like the api being down, a wrong `IOS_APP_ID` looks like an entitlement
 * problem, an unset fingerprint looks like an Android bug, and an unbundled legal document looks
 * like a routing bug. This prints what the Worker is actually holding, in one request.
 *
 * `installUrl` is the one that answers a question about the *pages* rather than about a file: null
 * means every page is in its private-beta state and offers no download. It is printed after the
 * `installUrl()` check rather than raw, so a value that is set but is not an https URL reports as
 * null here exactly as it renders - a diagnostic that echoed the raw var would send somebody
 * looking at the pages for a button the pages are right not to render.
 *
 * The fingerprints are COUNTED rather than printed. They are public - they are in the file next
 * door - but a diagnostic that prints a 95-character value per line is a diagnostic nobody reads,
 * and the question being asked here is only ever "is it set".
 *
 * `no-store`, because this is the route you reach while something is wrong and a cached answer
 * would report the state before the fix.
 */
function parityResponse(request: Request, env: Env): Response {
  return send(request, {
    status: 200,
    body: JSON.stringify({
      apiOrigin: apiOrigin(env),
      iosAppId: env.IOS_APP_ID,
      installUrl: installUrl(env),
      androidPackageName: env.ANDROID_PACKAGE_NAME,
      androidFingerprints: androidFingerprints(env).length,
      legal: {
        privacy: LEGAL_DOCUMENTS['/privacy'].markdown.length,
        terms: LEGAL_DOCUMENTS['/terms'].markdown.length,
      },
      // Optional-chained on a binding the type says is always present, because this is the route
      // you reach WHILE something is misconfigured, and a diagnostic that throws when a binding is
      // missing answers the one question it exists to answer with a blank page.
      version: env.CF_VERSION_METADATA?.id ?? 'unknown',
    }),
    contentType: 'application/json; charset=utf-8',
    cacheControl: 'no-store',
  });
}

/**
 * One trailing slash removed, so `/privacy/` and `/privacy` are the same page.
 *
 * A redirect would be the other option and is worse here for one specific reason: the join page.
 * `/join/<token>/` is a shape `apps/mobile/src/invite-link.ts` already accepts from a QR scan, and
 * answering it with a 301 would put the invite token through a `Location` header and a second
 * request for no gain. Serving the same page from both spellings costs nothing.
 */
function normalisePath(pathname: string): string {
  return pathname.length > 1 && pathname.endsWith('/') ? pathname.slice(0, -1) : pathname;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // Before the router, because it is true of every path, and because a 405 is the one refusal
    // that owes the caller a detail: RFC 9110 requires `Allow` on it.
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response(null, {
        status: 405,
        headers: { ...SECURITY_HEADERS, allow: 'GET, HEAD', 'cache-control': 'no-store' },
      });
    }

    const pathname = normalisePath(new URL(request.url).pathname);

    if (pathname === '/') return html(request, landingPage(env));

    if (pathname === '/styles.css') {
      return send(request, {
        status: 200,
        body: STYLESHEET,
        contentType: 'text/css; charset=utf-8',
        cacheControl: ASSET_CACHE,
      });
    }

    if (pathname === '/robots.txt') {
      return send(request, {
        status: 200,
        body: ROBOTS_TXT,
        contentType: 'text/plain; charset=utf-8',
        cacheControl: ASSET_CACHE,
      });
    }

    if (pathname === AASA_PATH) {
      return json(request, appleAppSiteAssociation(env), ASSOCIATION_CACHE);
    }
    if (pathname === ASSETLINKS_PATH) {
      return json(request, assetLinks(env), ASSOCIATION_CACHE);
    }

    if (pathname === PARITY_PATH) return parityResponse(request, env);

    if (isLegalPath(pathname)) return legalPage(request, pathname);

    if (pathname.startsWith('/join/')) {
      const token = inviteTokenFromPath(pathname);
      // A path under `/join/` that is not a token is answered as a dead invite rather than as a
      // generic 404, and without the api being asked. From the visitor's side those are the same
      // event: the link they were handed does not work. From this Worker's side it is the guarantee
      // that the only caller-controlled part of the api URL it builds is a checked token.
      if (token === null) {
        return html(request, invalidInvitePage(env), 404, 'no-store');
      }

      const preview = await readInvitePreview(env, token);
      const { html: body, status } = joinPage(env, token, preview);
      return send(request, {
        status,
        body,
        contentType: 'text/html; charset=utf-8',
        // Never cached: the page names a club and reflects whether the token is live right now.
        cacheControl: 'no-store',
        // Said in the header as well as in the document, because a crawler that honours one and not
        // the other is not hypothetical, and the URL itself is the credential.
        extra: { 'x-robots-tag': 'noindex, nofollow' },
      });
    }

    return html(request, notFoundPage(), 404, 'no-store');
  },
} satisfies ExportedHandler<Env>;
