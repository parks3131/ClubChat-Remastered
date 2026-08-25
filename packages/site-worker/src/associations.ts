/**
 * The two files that decide whether `https://clubchatapp.com/join/<token>` opens the app.
 *
 * They are not read by a person and they fail silently: get either one wrong and the link simply
 * opens in a browser, with nothing logged anywhere and nobody told why. So both are built here from
 * the same vars `/__parity` prints, and both are asserted in `associations.test.ts` against the
 * exact document rather than against "it parses".
 *
 * **Neither file is what makes the link work on its own.** The other half is in the app, and it is
 * owned by a different change: `apps/mobile/app.json` needs `ios.associatedDomains` of
 * `["applinks:clubchatapp.com"]` and an Android `intentFilters` entry for the same host with
 * `autoVerify`. Until both halves exist, the https link lands on this Worker's page and the visitor
 * taps through - which is the degraded behaviour this Worker was built to provide anyway.
 */

import { androidFingerprints, type Env } from './env.ts';

/**
 * The path Apple fetches. Exact, and with no `.json` extension.
 *
 * The extension is the classic way to serve a correct document at a path nothing reads: a static
 * host that insists on one produces `apple-app-site-association.json`, which Apple never asks for.
 * Serving it from a Worker means the path is a string in a router rather than a filename, which is
 * one of the smaller reasons a Worker beats a bucket here.
 */
export const AASA_PATH = '/.well-known/apple-app-site-association';

/** The path Android fetches. This one does carry `.json`, and that is Google's spelling. */
export const ASSETLINKS_PATH = '/.well-known/assetlinks.json';

/**
 * The universal-links document.
 *
 * ## Only `/join/*`
 *
 * A component list is an allowlist: a path not matched by any component stays in the browser. That
 * is exactly what is wanted here, because `/privacy` and `/terms` must open in a browser - they are
 * linked from inside the app, and an app that opened its own legal pages by launching itself would
 * be a loop. Claiming `/` or `*` would do that.
 *
 * ## Only the modern shape
 *
 * `appIDs` and `components`, and deliberately NOT the pre-iOS-13 `appID` and `paths` pair that
 * Apple's migration guidance says to keep alongside them. That guidance is about supporting iOS 12,
 * and this app's minimum deployment target is iOS 16.4 (`apps/mobile/ios/Podfile`). Carrying both
 * would mean two lists that have to agree, forever, for a version of iOS the app cannot install on.
 *
 * `apps: []` is kept, though it is absent from Apple's current examples. It costs one line, older
 * parsers and several third-party AASA validators still expect it, and an empty array cannot mean
 * anything other than "no app-clip-era app list".
 */
export function appleAppSiteAssociation(env: Env): unknown {
  return {
    applinks: {
      apps: [],
      details: [
        {
          appIDs: [env.IOS_APP_ID],
          components: [
            {
              '/': '/join/*',
              comment: 'Invite links. Every other path on this domain stays in the browser.',
            },
          ],
        },
      ],
    },
  };
}

/**
 * The Digital Asset Links document.
 *
 * **An empty array when no fingerprint is configured, rather than a placeholder or a 404.** All
 * three are wrong in different ways, and the empty array is the least wrong:
 *
 *  - A placeholder fingerprint publishes a claim that fails verification while the file looks
 *    correct, which is the failure that takes longest to find.
 *  - A 404 is indistinguishable from the file never having been deployed.
 *  - An empty statement list is a valid document that says, precisely and truthfully, that no app
 *    is currently associated with this domain.
 *
 * `GET /__parity` reports the count, so "why do Android app links not verify" is one request.
 */
export function assetLinks(env: Env): unknown {
  const fingerprints = androidFingerprints(env);
  if (fingerprints.length === 0) return [];
  return [
    {
      relation: ['delegate_permission/common.handle_all_urls'],
      target: {
        namespace: 'android_app',
        package_name: env.ANDROID_PACKAGE_NAME,
        sha256_cert_fingerprints: [...fingerprints],
      },
    },
  ];
}
