/**
 * iOS's own document previewer, for a file already staged on disk.
 *
 * A local native module rather than a package: it is a thin wrapper over `QLPreviewController`,
 * which is the full-screen viewer every iOS app uses to show a document inside itself, and the
 * whole of it is one Swift file next to this one.
 *
 * > **`requireOptionalNativeModule`, never `requireNativeModule`, and that is load-bearing.** A
 * > native module only exists in a binary that was built after it was written, so the required
 * > form would throw at import time on every build that predates this one - including the one on
 * > the founder's phone right now - and an import-time throw takes the whole bundle down rather
 * > than one action. See `SPEC/TECH/14`, which records two outages of exactly that shape. Absent
 * > here means `null`, and the caller falls back to the share sheet.
 *
 * Web resolves to `null` through the same call, because there is no native module in a browser.
 */

import { requireOptionalNativeModule } from 'expo';

type QuickLookNativeModule = {
  /** Whether iOS has a previewer for this file. Cheap, and answered from the extension. */
  canPreview(url: string): boolean;
  /** Present the preview, resolving when the person closes it. */
  previewAsync(url: string): Promise<void>;
};

const native = requireOptionalNativeModule<QuickLookNativeModule>('ClubChatQuickLook');

/**
 * Show a staged file full screen, and resolve once it is closed.
 *
 * Returns `false` when there is nothing to show it with - an older binary, a browser, or a type
 * iOS has no previewer for - so the caller can fall back rather than having to ask first.
 */
export async function previewDocument(fileUri: string): Promise<boolean> {
  if (native === null || !native.canPreview(fileUri)) return false;
  await native.previewAsync(fileUri);
  return true;
}
