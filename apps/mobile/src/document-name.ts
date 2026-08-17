/**
 * What a document is called: on the bubble, and on disk.
 *
 * **A module of its own, with no `react-native` import, so it can be tested** - the same reason
 * `photo-size.ts` exists beside `media-bubble.tsx`. Vitest cannot parse React Native's own
 * sources, so anything reachable from a `react-native` import is untestable, and both callers here
 * are: the bubble draws components, and `open-document.ts` needs `Platform`.
 *
 * The naming is worth testing on its own account rather than only for convenience. A filename
 * arrives on the message envelope from whatever device sent it, and one of these two functions
 * turns it into a path.
 */

import { formatBytes } from '@clubchat/shared';

/**
 * The extension to fall back to when a filename arrives without one.
 *
 * Only the seven types `DOCUMENT_MIME_ALLOWLIST` accepts can ever reach here, so this covers the
 * whole set. An unknown type gets no extension rather than a wrong one: iOS refuses to guess and
 * says so, which is a better outcome than opening a spreadsheet as plain text.
 */
const EXTENSION_FOR_MIME: Readonly<Record<string, string>> = {
  'application/pdf': '.pdf',
  'application/msword': '.doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
  'application/vnd.ms-excel': '.xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
  'text/plain': '.txt',
  'text/csv': '.csv',
};

/** An extension: a dot, then a short run of letters and digits, at the very end. */
const EXTENSION = /\.([A-Za-z0-9]{1,8})$/;

/** Path separators and the characters a filesystem will not take, and nothing else. */
const UNSAFE_IN_A_FILENAME = /[/\\:*?"<>|]/g;

/**
 * The type of a document, for the line under its name.
 *
 * **The extension, not the mime**, and that is the honest source rather than the convenient one:
 * the envelope carries a filename and a byte count and no content type at all, so the mime is not
 * available to the bubble in the first place. The extension is also the part the sender saw.
 */
export function documentType(name: string | null): string | null {
  const match = EXTENSION.exec((name ?? '').trim());
  return match === null ? null : match[1]!.toUpperCase();
}

/** `PDF · 1.2 MB`, or whichever half of it exists, or nothing at all. */
export function documentDetail(name: string | null, size: number | null): string | null {
  const parts = [documentType(name), size === null ? null : formatBytes(size)].filter(
    (part): part is string => part !== null,
  );
  return parts.length === 0 ? null : parts.join(' · ');
}

/**
 * A filename that is safe to write into the cache directory.
 *
 * The name is untrusted input that is about to become a path. Separators and the characters no
 * filesystem accepts are replaced rather than removed, so two documents whose names differ only in
 * those characters do not silently become one file. **Everything else is left exactly as it was**
 * - spaces, hyphens, accents and all - because the whole point of using the real name is that the
 * share sheet shows the person the document they tapped.
 */
export function cacheFileName(name: string | null, mime: string): string {
  const cleaned = (name ?? '').replace(UNSAFE_IN_A_FILENAME, '_').trim();
  // A name made only of dots is `.` or `..`, which name directories rather than files and would
  // write outside the folder the caller just created for it.
  const safe = cleaned.length > 0 && !/^\.+$/.test(cleaned) ? cleaned : 'document';
  // An extension it already has is the one to keep: it is what the sender saw, and the mime is
  // only a second opinion about the same file.
  if (EXTENSION.test(safe)) return safe;
  return `${safe}${EXTENSION_FOR_MIME[mime] ?? ''}`;
}
