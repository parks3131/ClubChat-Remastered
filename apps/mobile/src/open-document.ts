/**
 * Opening a document that was sent in a conversation.
 *
 * **A document opens inside ClubChat, full screen, the way a photo does.** The founder's
 * reference is GroupMe, which is `QLPreviewController`: the filename and a close button across the
 * top, a page count, a search field and a share button - iOS's own document viewer, which renders
 * all seven accepted types without this app knowing anything about any of them. That viewer is
 * `modules/quick-look`, a local native module, because nothing in the JavaScript half of an Expo
 * app can present one.
 *
 * The route:
 *
 *   1. **Resolve through the authorized hop.** `/media/:id/url` re-decides access on every call,
 *      so a member who has lost it stops being able to open the file without anything having to
 *      invalidate a link the bubble was holding.
 *   2. **Stage the bytes on disk**, under the document's own filename. iOS reads the type off the
 *      extension alone, so the name is what makes a `.pdf` open as a PDF - and it is also the name
 *      the viewer puts in its title bar, which is why the cache copy is not named after the media
 *      id.
 *   3. **Preview it**, and fall back to the share sheet when there is no previewer.
 *
 * > **The fallback is not decoration.** `previewDocument` answers `false` on a binary built before
 * > the module existed, which includes every build already installed on a phone, and on any type
 * > iOS has no previewer for. The share sheet reaches the same viewer in one more tap and carries
 * > Save to Files, Print and the rest besides, so an app that has not been rebuilt yet keeps
 * > working rather than growing a control that does nothing.
 *
 * The staged copy is kept, so opening the same document twice is one download. It lives in the
 * cache directory, which the OS is free to reclaim - a second open after that re-downloads rather
 * than failing.
 *
 * > **Web takes a different route, and it is not a lesser one.** There is no previewer, no share
 * > sheet and no writable filesystem in a browser, and a new tab opened after an `await` is
 * > exactly what a popup blocker exists to stop - the resolve is a round trip, so by the time
 * > there is a URL to open, the tap that asked for it is no longer the reason the tab is opening.
 * > A download does not have that problem, so on the web the file downloads, which is what "open
 * > this" means there anyway.
 */

import { Platform } from 'react-native';
import { Directory, File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { previewDocument } from '../modules/quick-look/index.ts';
import { resolveMedia } from './api.ts';
import { cacheFileName } from './document-name.ts';

/**
 * Open a document from a message.
 *
 * Returns what to tell the person afterwards, empty for the ordinary case where the platform has
 * already shown them something. Same contract as the photo viewer's actions, so a caller can put
 * the result straight onto its notice.
 *
 * Throws on a failed resolve or a failed download, which the caller reports - losing access to a
 * conversation is a legitimate reason for this to fail and it must never be silent.
 */
export async function openDocument(mediaId: string, name: string | null): Promise<string> {
  // The original, never a derived variant: a document has none, and asking for one would fall
  // back to the original anyway. Saying so is clearer than relying on that fallback.
  const resolved = await resolveMedia(mediaId, 'original');
  const filename = cacheFileName(name, resolved.mime);

  if (Platform.OS === 'web') {
    const response = await fetch(resolved.url);
    if (!response.ok) throw new Error(`document fetch failed: ${response.status}`);
    const objectUrl = URL.createObjectURL(await response.blob());
    const link = document.createElement('a');
    link.href = objectUrl;
    // Same-origin `blob:`, so the browser honours the name. A cross-origin href would ignore it,
    // which is the other reason the bytes come through the app rather than through the tab.
    link.download = filename;
    // In the document rather than detached: Firefox ignores `click()` on an element that is not.
    document.body.appendChild(link);
    link.click();
    link.remove();
    // Not revoked immediately. The browser reads the blob after the click returns, and pulling the
    // URL out from under it cancels the download in some of them.
    setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
    return '';
  }

  // One directory per media id, so two documents that share a filename do not share a file.
  const folder = new Directory(Paths.cache, 'documents', mediaId);
  folder.create({ intermediates: true, idempotent: true });
  const target = new File(folder, filename);
  if (!target.exists) await File.downloadFileAsync(resolved.url, target);

  // Full screen, inside the app. Resolves when the person closes it.
  if (await previewDocument(target.uri)) return '';

  if (!(await Sharing.isAvailableAsync())) {
    return 'This device cannot open documents.';
  }
  await Sharing.shareAsync(target.uri, {
    mimeType: resolved.mime,
    dialogTitle: name ?? 'Document',
  });
  return '';
}
