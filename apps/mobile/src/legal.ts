/**
 * Where the Privacy Policy and the Terms live.
 *
 * > **The app does not carry the legal text any more, and that is the point.** Until 2026-08-25
 * > both documents were React Native screens, which made the phone the only place either one
 * > existed - no web copy for an App Store listing to point at, and no way for anybody who has not
 * > installed the app to read what they are about to agree to. The text is now
 * > `docs/legal/privacy-policy.md` and `docs/legal/terms-of-service.md`, rendered by the apex site
 * > at the two URLs below, and the app links out to them.
 *
 * One constant per document, in one module, for the same reason `support.ts` holds one address:
 * the links appear on the sign-up screen and on the Profile screen, and two copies of a URL is two
 * chances to update one of them.
 *
 * **Opened with `Linking.openURL` from `react-native`**, which is the pattern the app already uses
 * for every external URL - a pasted map link, a news post's location. `expo-web-browser` would
 * give an in-app browser sheet and is not a dependency; adding it is a native module and therefore
 * a CNG rebuild, which is not worth paying for a document somebody opens once.
 */

/** The Privacy Policy, rendered from `docs/legal/privacy-policy.md`. */
export const PRIVACY_URL = 'https://clubchatapp.com/privacy';

/** The Terms of Service, rendered from `docs/legal/terms-of-service.md`. */
export const TERMS_URL = 'https://clubchatapp.com/terms';
