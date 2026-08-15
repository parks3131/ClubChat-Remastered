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

import { Platform } from 'react-native';
import * as DocumentPicker from 'expo-document-picker';
import { File, UploadTask } from 'expo-file-system';
import { UploadType } from 'expo-file-system';
import * as ImagePicker from 'expo-image-picker';
import { apiFetch, ApiError } from './api.ts';

export type PickedAttachment = {
  uri: string;
  mime: string;
  /** Present for a document; a photo bubble shows neither name nor size. */
  name?: string;
};

export type UploadKind = 'photo' | 'document' | 'avatar';

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

/**
 * Pick a picture that will be shown in a **square frame**, with a crop step.
 *
 * Used by every avatar - a person, a club, a race, Eboard & Council - and by a news post's photo.
 *
 * **Its own function rather than a flag on `pickPhoto`**, because the two want opposite things and
 * a boolean parameter would eventually be passed the wrong way round. The rule that separates
 * them is not "identity versus content", which is what it looked like at first and would have put
 * news on the wrong side:
 *
 * > **Crop where the frame is fixed. Do not crop where the picture sets its own proportions.**
 *
 * A chat photo is shown at its own aspect ratio, so there is nothing to crop it to and a forced
 * square would throw away most of what somebody chose to send. An avatar and a news photo are
 * both drawn into a frame the picture does not get a say in, so whatever does not fit is
 * discarded either way - the only question is whether the person or a `cover` resize decides
 * which part survives, and the person should.
 *
 * That is also why the news card is `aspectRatio: 1` rather than the 220pt landscape box it was.
 * **The crop frame and the display frame have to be the same frame**, or the card silently
 * crops a second time and the picture that posts is not the one that was chosen.
 *
 * `aspect` is Android-only in `expo-image-picker`; iOS's built-in editor is always square, which
 * is the ratio wanted here, so both platforms land in the same place. A free-form crop would need
 * a third-party cropper and a native rebuild, which is the whole reason the square is the shape
 * everything here is cropped to.
 *
 * One crop serves both avatar shapes: a circle is a square with a rounded mask over it, so the
 * picker's square frame is right whether the result ends up round (a person) or a rounded square
 * (a club, a race, Eboard & Council).
 */
export async function pickSquarePhoto(): Promise<PickedAttachment | null> {
  const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
  if (!permission.granted) {
    throw new UploadError('no_permission', 'ClubChat needs permission to open your photos.');
  }

  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ['images'],
    allowsEditing: true,
    aspect: [1, 1],
    // Multi-select and `allowsEditing` are mutually exclusive: the editor crops one image.
    allowsMultipleSelection: false,
    quality: 0.85,
  });
  if (result.canceled) return null;

  const asset = result.assets[0];
  if (!asset) return null;
  // The cropped copy's uri, not the original's - the editor writes a new file and that is the
  // one whose bytes must be measured and uploaded. `uploadAttachment` resolves the blob from
  // exactly this uri, so the declared length matches what `completeUpload` HEADs.
  return { uri: asset.uri, mime: asset.mimeType ?? 'image/jpeg' };
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
 *
 * > **`blob.size` is correct on every platform, and this file is not where the byte count can
 * > go wrong.** Worth stating, because it looked like the culprit for a while: photos attached
 * > from a phone were refused as `mismatch`, a 3,002,684-byte file reaching storage as 3,002,780.
 * > Both the blob and `expo-file-system` agreed the file was 3,002,684. The extra 96 bytes were
 * > `aws-chunked` framing added by the SIGNING side - see the checksum note in
 * > `server/media/store.ts`. Nothing the uploader could measure differently would have helped.
 */
async function resolveBlob(uri: string): Promise<Blob> {
  const response = await fetch(uri);
  if (!response.ok) throw new UploadError('unreadable', 'That file could not be read.');
  return response.blob();
}

/**
 * PUT the bytes to storage. **The one place this file branches on platform, and it has to.**
 *
 * > **React Native's Blob does not transmit a file faithfully.** Sending one as a `fetch` body
 * > inserted 96 bytes into every attachment from a phone: a 3,002,684-byte PNG arrived as
 * > 3,002,780, with binary junk ahead of the PNG signature and the image itself intact behind it.
 * > `completeUpload` HEADs the object and compares its length against what was declared with no
 * > tolerance, so all of them were refused - "the upload did not arrive intact", which for once
 * > was exactly true.
 * >
 * > The corruption is in the blob layer, not in the measurement: the blob and the filesystem both
 * > reported 3,002,684, which is what the file really is. So native does not use a blob at all.
 * > `UploadTask` streams the file from disk "as-is in the request body", which is the only way to
 * > be sure the bytes on disk are the bytes in the object.
 *
 * Web keeps the `fetch` path: a browser Blob is already the bytes, and it is the path the whole
 * upload flow was originally verified against.
 */
async function putBytes(
  url: string,
  headers: Record<string, string>,
  uri: string,
  blob: Blob,
): Promise<void> {
  if (Platform.OS === 'web') {
    const put = await fetch(url, { method: 'PUT', headers, body: blob });
    if (!put.ok) {
      throw new UploadError('put_failed', 'The upload was rejected by storage. Try again.');
    }
    return;
  }

  const task = new UploadTask(new File(uri), url, {
    httpMethod: 'PUT',
    uploadType: UploadType.BINARY_CONTENT,
    headers,
  });
  const result = await task.uploadAsync();
  if (result.status < 200 || result.status >= 300) {
    throw new UploadError('put_failed', 'The upload was rejected by storage. Try again.');
  }
}

/**
 * Upload a picked file and return the media id to attach to a message.
 *
 * Does **not** send the message. The caller sends it, so a failed send can be retried from the
 * outbox without re-uploading bytes that are already durable and already verified.
 */
/**
 * Upload a new profile picture and return its media id.
 *
 * Identity media rather than channel content: it goes to the public bucket and the only gate is
 * being signed in, because you may always replace your own face and the object carries nothing
 * private. That is why this takes no channel - the server's `avatar` kind has no channel to check.
 */
export async function uploadAvatar(picked: PickedAttachment): Promise<string> {
  const uploaded = await uploadAttachment(null, picked, 'avatar');
  return uploaded.mediaId;
}

/**
 * A region of the picture to keep, in the source image's own pixels.
 *
 * > **The phone chooses this rectangle and never cuts the bytes**, which is the whole reason
 * > cropping needs no native image module here. The server already decodes every uploaded photo
 * > to prove it is one, so extracting from that decode costs it nothing - and this app has twice
 * > been taken down by a native import that reached Metro before it reached the binaries.
 */
export type CropRegion = {
  originX: number;
  originY: number;
  width: number;
  height: number;
};

export async function uploadAttachment(
  /** Null for an avatar, which belongs to a person rather than to a conversation. */
  channelId: string | null,
  picked: PickedAttachment,
  kind: UploadKind,
  /** Absent for a document, an avatar, and any photo sent as it was chosen. */
  crop?: CropRegion | undefined,
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
        // Omitted entirely for an avatar: the server's schema takes an optional uuid, and a
        // literal null fails it where an absent key passes.
        ...(channelId === null ? {} : { channelId }),
        ...(kind === 'document' && picked.name ? { documentName: picked.name } : {}),
      },
    });
  } catch (error) {
    throw refusalMessage(error);
  }

  // Straight to object storage, not through the API. The whole point of a presigned PUT is that
  // the bytes never traverse the application server.
  //
  // The headers the presign was computed over are passed through exactly as handed back, on both
  // paths: changing or adding to them invalidates the signature.
  await putBytes(intent.uploadUrl, intent.headers, picked.uri, blob);

  try {
    // The step that makes the object real. Until this succeeds the row is `pending` and a send
    // referencing it is refused with `media_not_ready` - which is recoverable, so the client's
    // correct response to that code is to finish the upload rather than give up.
    //
    // The crop rides on THIS call rather than on the intent, because the intent is issued before
    // any bytes exist and the rectangle describes the bytes. Completion is also the one moment
    // the server has the object in hand and decoded, so cutting here costs no extra read.
    await apiFetch(`/media/${intent.mediaId}/complete`, {
      method: 'POST',
      body: crop ? { crop } : {},
    });
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
