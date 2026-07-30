/**
 * Attaching a photo or a document to a message.
 *
 * The server half of this has been complete and tested since Phase 3 - upload intent, presigned
 * PUT, size and type re-verification at complete, thumbnail derivation, the authorized download
 * hop. What was missing was any way to reach it from the app, which is what this file is.
 *
 * The order is fixed by the server's contract and is worth stating, because getting it wrong
 * fails late and confusingly:
 *
 *   1. **Resolve the bytes first.** Everything after this uses the resolved blob's real length.
 *   2. **Intent**, declaring mime and size. Authorized against the channel, checked against the
 *      allowlist and the cap, and answered with a presigned PUT.
 *   3. **PUT** the exact same blob to the exact URL, with the exact headers handed back.
 *   4. **Complete**, which HEADs the object and refuses if what arrived is not what was
 *      declared. Only then does the object become `ready`.
 *   5. **Send** the message carrying the media id.
 *
 * Step 1 comes first for a specific reason: `completeUpload` compares the declared byte count
 * against the object's actual length with **no tolerance**, so declaring anything other than the
 * length of the bytes you are about to send is a guaranteed `mismatch`. A picker's reported
 * `fileSize` is not reliable enough to be that number - it is absent on web entirely - so the
 * blob is resolved up front and its own `size` is what gets declared.
 */

import * as DocumentPicker from 'expo-document-picker';
import * as ImagePicker from 'expo-image-picker';
import { apiFetch, ApiError } from './api.ts';

export type PickedAttachment = {
  uri: string;
  mime: string;
  /** Present for a document; a photo bubble shows neither name nor size. */
  name?: string;
};

export type UploadKind = 'photo' | 'document';

export type UploadedAttachment = {
  mediaId: string;
  kind: UploadKind;
  mime: string;
  bytes: number;
  name?: string;
  /** The local uri, so the optimistic bubble can render before the send is acked. */
  localUri: string;
};

/** Why an attachment did not go through, in words a person can act on. */
export class UploadError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = 'UploadError';
  }
}

/**
 * Map the server's refusal onto something worth showing.
 *
 * The API distinguishes 413 from 415 specifically so a client can say which limit was hit
 * rather than showing one generic failure - so it would be a waste not to.
 */
function refusalMessage(error: unknown): UploadError {
  if (error instanceof ApiError) {
    if (error.status === 413) {
      return new UploadError('too_large', 'That file is too large to send.');
    }
    if (error.status === 415) {
      return new UploadError('mime_not_allowed', 'That kind of file cannot be sent.');
    }
    if (error.status === 409) {
      return new UploadError(
        'mismatch',
        'The upload did not arrive intact. Try sending it again.',
      );
    }
    if (error.status === 404) {
      return new UploadError('forbidden', 'You cannot attach a file to this conversation.');
    }
  }
  return new UploadError('failed', 'The upload failed. Check your connection and try again.');
}

// ---------------------------------------------------------------------------
// Picking
// ---------------------------------------------------------------------------

/** Pick an image from the library. Returns null if the picker was dismissed. */
export async function pickPhoto(): Promise<PickedAttachment | null> {
  const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
  if (!permission.granted) {
    throw new UploadError('no_permission', 'ClubChat needs permission to open your photos.');
  }

  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ['images'],
    // One at a time. Multi-select would need the send outbox to model a batch, and a partially
    // sent batch is a worse failure than sending twice.
    allowsMultipleSelection: false,
    quality: 0.85,
  });
  if (result.canceled) return null;

  const asset = result.assets[0];
  if (!asset) return null;
  return {
    uri: asset.uri,
    // The picker's own mime when it has one. The blob's type is the fallback and the object
    // store's Content-Type is what the server re-verifies, so a wrong guess here fails at
    // complete rather than silently storing something mislabelled.
    mime: asset.mimeType ?? 'image/jpeg',
  };
}

/** Take a photo with the camera. Returns null if dismissed. */
export async function takePhoto(): Promise<PickedAttachment | null> {
  const permission = await ImagePicker.requestCameraPermissionsAsync();
  if (!permission.granted) {
    throw new UploadError('no_permission', 'ClubChat needs permission to use your camera.');
  }

  const result = await ImagePicker.launchCameraAsync({ quality: 0.85 });
  if (result.canceled) return null;

  const asset = result.assets[0];
  if (!asset) return null;
  return { uri: asset.uri, mime: asset.mimeType ?? 'image/jpeg' };
}

/** Pick any document. Returns null if dismissed. */
export async function pickDocument(): Promise<PickedAttachment | null> {
  const result = await DocumentPicker.getDocumentAsync({
    // Copied into the cache so the uri stays readable after the picker closes.
    copyToCacheDirectory: true,
  });
  if (result.canceled) return null;

  const asset = result.assets[0];
  if (!asset) return null;
  return {
    uri: asset.uri,
    mime: asset.mimeType ?? 'application/octet-stream',
    name: asset.name,
  };
}

// ---------------------------------------------------------------------------
// Uploading
// ---------------------------------------------------------------------------

/**
 * Resolve a picked file's bytes.
 *
 * One path for both platforms, via `fetch`: on web a picker hands back a `blob:` URI, and in
 * React Native a `file:` URI, and `fetch` reads both. Deliberately not branching on platform to
 * use a native file API - an unverified second path is worse than one path with a known
 * verification boundary, and this one is exercised on web.
 */
async function resolveBlob(uri: string): Promise<Blob> {
  const response = await fetch(uri);
  if (!response.ok) throw new UploadError('unreadable', 'That file could not be read.');
  return response.blob();
}

/**
 * Upload a picked file and return the media id to attach to a message.
 *
 * Does **not** send the message. The caller sends it, so a failed send can be retried from the
 * outbox without re-uploading bytes that are already durable and already verified.
 */
export async function uploadAttachment(
  channelId: string,
  picked: PickedAttachment,
  kind: UploadKind,
): Promise<UploadedAttachment> {
  const blob = await resolveBlob(picked.uri);
  // The blob's own length, never the picker's reported size. `completeUpload` compares the
  // declared count against the object's real length with no tolerance.
  const bytes = blob.size;
  if (bytes === 0) throw new UploadError('empty', 'That file is empty.');

  const mime = picked.mime || blob.type || 'application/octet-stream';

  let intent: {
    mediaId: string;
    uploadUrl: string;
    headers: Record<string, string>;
  };
  try {
    intent = await apiFetch('/media/upload-intent', {
      method: 'POST',
      body: {
        kind,
        mime,
        bytes,
        channelId,
        ...(kind === 'document' && picked.name ? { documentName: picked.name } : {}),
      },
    });
  } catch (error) {
    throw refusalMessage(error);
  }

  // Straight to object storage, not through the API. The whole point of a presigned PUT is that
  // the bytes never traverse the application server.
  const put = await fetch(intent.uploadUrl, {
    method: 'PUT',
    // The headers the presign was computed over. Changing or adding to them invalidates the
    // signature, so they are passed through exactly as handed back.
    headers: intent.headers,
    body: blob,
  });
  if (!put.ok) {
    throw new UploadError('put_failed', 'The upload was rejected by storage. Try again.');
  }

  try {
    // The step that makes the object real. Until this succeeds the row is `pending` and a send
    // referencing it is refused with `media_not_ready` - which is recoverable, so the client's
    // correct response to that code is to finish the upload rather than give up.
    await apiFetch(`/media/${intent.mediaId}/complete`, { method: 'POST', body: {} });
  } catch (error) {
    throw refusalMessage(error);
  }

  return {
    mediaId: intent.mediaId,
    kind,
    mime,
    bytes,
    ...(picked.name ? { name: picked.name } : {}),
    localUri: picked.uri,
  };
}
