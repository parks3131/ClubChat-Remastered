/**
 * What a picked photo passes through before it is sent: a look at it, and a caption.
 *
 * > **Until 2026-08-15 there was nothing here at all.** Choosing a photo uploaded it and posted it
 * > in the same breath, so there was no moment to see what you had chosen, no way to take it back
 * > without deleting a message, and no way to say anything about it - even though the server has
 * > accepted a caption alongside a `media_id` since Phase 0 and no interface had ever offered one.
 *
 * Three consequences of putting a step here, each a reason rather than a side effect:
 *
 *  - **The upload moves to Send.** It used to fire the moment the picker returned, so backing out
 *    cost a round trip and left an orphan object for the nightly sweep. Nothing leaves the phone
 *    until somebody means it to.
 *  - **The camera comes through here too.** A shot you cannot re-check before it posts is worse
 *    than a library pick you can, so the path that needs the preview most is the one that had it
 *    least.
 *  - **The caption is a real message body**, mentions and all, which is why the `@` list is the
 *    composer's own rather than a second one - see `MentionList`.
 *
 * **This file imports nothing native, and that is a rule rather than an accident.** Cropping was
 * built here first and took the app down twice: a native module is resolved at bundle load, so JS
 * that imports one reaches every phone the instant Metro serves it while the binaries carrying it
 * are minutes or hours behind. See `AGENTS.md` failure modes 8 and 32. The crop now happens on the
 * server, where the media pipeline already decodes every photo - so this screen stays JS.
 *
 * Dark, because it is a photo surface: it mirrors `PhotoViewer`'s chrome rather than inventing a
 * second treatment for a full-screen picture, down to the same `inverseSurface` and the same
 * circular close. The one accent is the send disc, which is the composer's.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Image,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import type { LayoutChangeEvent } from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { KeyboardAvoider } from './keyboard-avoider.tsx';
import { MentionList } from './mention-list.tsx';
import {
  activeMentionQuery,
  applyMention,
  matchMentionables,
  mentionIdsInBody,
  type Mentionable,
  type MentionPick,
} from './mentions.ts';
import {
  CropOverlay,
  isWholeImage,
  toNorm,
  toPoints,
  toSourceRect,
  WHOLE,
  type NormRect,
  type SourceRect,
} from './photo-crop.tsx';
import { color, radius, space, type } from './theme.ts';

export type ComposedPhoto = {
  /** The caption, already trimmed. Empty string when there is none. */
  caption: string;
  /** Who the caption names, filtered to the people it actually still names. */
  mentions: string[];
  /** The region to keep, or null when the picture is being sent whole. */
  crop: SourceRect | null;
};

export function PhotoCompose({
  uri,
  channelName,
  mentionable,
  onCancel,
  onSend,
}: {
  uri: string;
  /** "Send to Binghamton Running Club". The conversation, never the app. */
  channelName: string;
  mentionable: readonly Mentionable[];
  onCancel: () => void;
  onSend: (photo: ComposedPhoto) => void;
}) {
  const insets = useSafeAreaInsets();

  const [source, setSource] = useState<{ width: number; height: number } | null>(null);
  const [box, setBox] = useState<{ width: number; height: number } | null>(null);
  const [caption, setCaption] = useState('');
  const [caret, setCaret] = useState(0);
  const [picks, setPicks] = useState<MentionPick[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [cropping, setCropping] = useState(false);
  /*
   * The crop as FRACTIONS of the picture, never as points on screen.
   *
   * Points meant the rectangle silently meant something different after every layout change - and
   * the layout changes on the very tap that confirms the crop, because the crop footer is a
   * different height from the caption bar. See `NormRect`.
   */
  const [norm, setNorm] = useState<NormRect>(WHOLE);

  /*
   * The source's own pixel dimensions, so the picture can be drawn at its own proportions rather
   * than letterboxed inside a fixed box. Read from the file rather than trusted from the picker,
   * which does not always report them.
   */
  useEffect(() => {
    let live = true;
    Image.getSize(
      uri,
      (width, height) => {
        if (live) setSource({ width, height });
      },
      () => {
        if (live) setError('That picture could not be opened.');
      },
    );
    return () => {
      live = false;
    };
  }, [uri]);

  /*
   * Where the picture is drawn, computed rather than left to `resizeMode: contain`.
   *
   * `contain` letterboxes inside its container, so the drawn image and the container would be
   * different rectangles. Fitting it here means the container IS the picture - which costs
   * nothing now and is what a crop frame will need later, since a frame in container points is
   * then a frame on the image with no letterbox offset to subtract.
   */
  const display = useMemo(() => {
    if (source === null || box === null) return null;
    const scale = Math.min(box.width / source.width, box.height / source.height);
    return { width: source.width * scale, height: source.height * scale };
  }, [source, box]);

  const mentionQuery = activeMentionQuery(caption, caret);
  const matches = useMemo(
    () => (mentionQuery === null ? [] : matchMentionables(mentionable, mentionQuery.query)),
    [mentionable, mentionQuery?.query],
  );

  const inputRef = useRef<TextInput | null>(null);

  const pickMention = (member: Mentionable) => {
    if (mentionQuery === null) return;
    const next = applyMention(caption, mentionQuery.start, caret, member);
    setCaption(next.text);
    setCaret(next.caret);
    setPicks((held) =>
      held.some((pick) => pick.userId === member.userId)
        ? held
        : [...held, { userId: member.userId, name: member.name }],
    );
  };

  /*
   * The frame in points, DERIVED from the fractions rather than stored.
   *
   * There is deliberately no effect watching the layout and resetting anything: a fraction means
   * the same thing at every size, so a reflow moves the frame with the picture for free. The
   * whole class of "the crop was reset by a relayout" cannot occur.
   */
  const frame = display === null ? null : toPoints(norm, display);

  /** Whether the frame still covers everything, in which case no crop is sent at all. */
  const untouched = isWholeImage(norm);

  const send = () => {
    const body = caption.trim();
    onSend({
      caption: body,
      mentions: mentionIdsInBody(picks, body),
      /*
       * Null unless the frame was actually moved. An "identity" crop would still cost a decode,
       * a re-encode and a write on the server, and would replace the member's own file with a
       * recompressed copy of itself for no gain.
       */
      crop: untouched || source === null ? null : toSourceRect(norm, source),
    });
  };

  return (
    <View style={styles.root}>
      {/*
        The header. Close on the left, the destination in the middle, and deliberately nothing on
        the right: the reference this was built from puts "add another photo" there, and this app
        sends one at a time on purpose - a partially sent batch is a worse failure than sending
        twice, which is why the picker asks for one.
      */}
      <View style={[styles.header, { paddingTop: insets.top + space.sm }]}>
        <Pressable
          style={styles.circle}
          // Backs out of the crop first, then out of the sheet - so the close never skips a mode
          // and discards a photo somebody was still adjusting.
          onPress={cropping ? () => setCropping(false) : onCancel}
          accessibilityRole="button"
          accessibilityLabel={cropping ? 'Stop cropping' : 'Discard this photo'}
        >
          <MaterialIcons name="close" size={22} color={color.onInverseSurface} />
        </Pressable>
        <Text style={styles.title} numberOfLines={1}>
          {cropping ? 'Crop' : `Send to ${channelName}`}
        </Text>
        {/* Balances the close so the title is centred on the screen, not on what is left over. */}
        <View style={styles.circleGhost} />
      </View>

      <View
        style={styles.stage}
        onLayout={(event: LayoutChangeEvent) => {
          const { width, height } = event.nativeEvent.layout;
          setBox((held) =>
            held !== null && held.width === width && held.height === height
              ? held
              : { width, height },
          );
        }}
      >
        {display === null ? (
          <ActivityIndicator color={color.accent} />
        ) : (
          <View style={{ width: display.width, height: display.height }}>
            <Image
              source={{ uri }}
              style={[StyleSheet.absoluteFill, !cropping && styles.photo]}
              accessibilityIgnoresInvertColors
            />
            {/*
              The frame sits over the picture rather than replacing it, and the corner radius
              comes off while cropping: a rounded preview would hide the very corners the frame
              is being dragged to.
            */}
            {cropping && frame !== null && (
              <CropOverlay
                display={display}
                rect={frame}
                // Straight back to fractions, so nothing anywhere holds a rectangle in points.
                onChange={(next) => setNorm(toNorm(next, display))}
              />
            )}
          </View>
        )}
      </View>

      {error !== null && <Text style={styles.error}>{error}</Text>}

      {cropping ? (
        /*
          The crop's own footer, replacing the caption bar rather than sitting under it. Cropping
          is a mode, and a mode that leaves the exit from the mode it interrupts on screen is how
          somebody sends a photo while still adjusting it.

          Done does not cut anything - it closes the mode. The rectangle travels with the send and
          the server cuts, which is why there is no spinner here and nothing that can fail.
        */
        <View style={[styles.cropBar, { paddingBottom: insets.bottom + space.md }]}>
          <Pressable
            onPress={() => setNorm(WHOLE)}
            disabled={untouched}
            accessibilityRole="button"
            accessibilityLabel="Reset the crop frame to the whole picture"
          >
            <Text style={[styles.cropReset, untouched && styles.cropResetOff]}>Reset</Text>
          </Pressable>
          <Pressable
            style={styles.cropDone}
            onPress={() => setCropping(false)}
            accessibilityRole="button"
            accessibilityLabel="Finish cropping"
          >
            <Text style={styles.cropDoneLabel}>Done</Text>
          </Pressable>
        </View>
      ) : (
      <KeyboardAvoider offset={insets.bottom}>
        {/*
          One tool, and it is the one that was asked for. It sits above the caption rather than
          beside it: cropping and captioning are two different decisions about the same photo, and
          a row that mixed them would make the send button ambiguous.
        */}
        <Pressable
          style={styles.tool}
          onPress={() => setCropping(true)}
          disabled={display === null}
          accessibilityRole="button"
          accessibilityLabel="Crop this photo"
        >
          <View style={styles.toolIcon}>
            <MaterialIcons name="crop" size={20} color={color.onInverseSurface} />
          </View>
          <Text style={styles.toolLabel}>{untouched ? 'Crop' : 'Cropped'}</Text>
        </Pressable>

        <MentionList matches={matches} onPick={pickMention} onDark />

        <View style={[styles.captionBar, { paddingBottom: insets.bottom + space.sm }]}>
          <TextInput
            ref={inputRef}
            style={styles.caption}
            placeholder="Add a caption..."
            placeholderTextColor="rgba(255,255,255,0.5)"
            value={caption}
            onChangeText={setCaption}
            // The caret drives the `@` list, exactly as it does in the composer.
            onSelectionChange={(event) => setCaret(event.nativeEvent.selection.start)}
            multiline
            accessibilityLabel="Add a caption"
          />
          {/*
            The composer's own send disc, and the same accent. A photo being sent and a message
            being sent are the same act, so they must not be two different buttons.
          */}
          <Pressable
            style={styles.send}
            onPress={send}
            accessibilityRole="button"
            accessibilityLabel="Send this photo"
          >
            <MaterialIcons name="send" size={18} color={color.onAccent} />
          </Pressable>
        </View>
      </KeyboardAvoider>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  /*
   * Absolute rather than a `Modal`, matching `PhotoViewer` - and not by preference. iOS presents
   * one modal per view controller and refuses the second in silence, so a modal opened from a
   * screen that may already be showing one is a control that does nothing on a device and works
   * on web. `AGENTS.md` failure mode 29. Above the viewer's 200 so the two can never fight.
   */
  root: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: color.inverseSurface,
    zIndex: 220,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: space.md,
    paddingBottom: space.sm,
    gap: space.sm,
  },
  circle: {
    width: 36,
    height: 36,
    borderRadius: radius.pill,
    backgroundColor: 'rgba(255,255,255,0.15)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  circleGhost: { width: 36, height: 36 },
  title: { ...type.bodySmallStrong, color: color.onInverseSurface, flex: 1, textAlign: 'center' },

  /* The picture's room: everything the header and the caption bar do not claim. */
  stage: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: space.md },
  photo: { borderRadius: radius.lg },

  error: {
    ...type.bodySmall,
    color: color.onInverseSurface,
    textAlign: 'center',
    paddingHorizontal: space.md,
    paddingBottom: space.sm,
  },

  captionBar: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: space.sm,
    paddingHorizontal: space.md,
    paddingTop: space.sm,
  },
  caption: {
    ...type.body,
    color: color.onInverseSurface,
    flex: 1,
    maxHeight: 120,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    borderRadius: radius.xl,
    backgroundColor: 'rgba(255,255,255,0.12)',
  },
  send: {
    width: 40,
    height: 40,
    borderRadius: radius.pill,
    backgroundColor: color.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },

  /* The crop tool: a row rather than a big tile, so it does not compete with the picture. */
  tool: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'center',
    gap: space.sm,
    paddingVertical: space.sm,
    paddingHorizontal: space.md,
  },
  toolIcon: {
    width: 34,
    height: 34,
    borderRadius: radius.pill,
    backgroundColor: 'rgba(255,255,255,0.15)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  toolLabel: { ...type.bodySmallStrong, color: color.onInverseSurface },

  cropBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: space.md,
    paddingTop: space.md,
  },
  cropReset: { ...type.body, color: color.onInverseSurface },
  cropResetOff: { opacity: 0.4 },
  cropDone: {
    minWidth: 96,
    paddingVertical: space.sm + 2,
    paddingHorizontal: space.lg,
    borderRadius: radius.pill,
    backgroundColor: color.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cropDoneLabel: { ...type.bodySmallStrong, color: color.onAccent },
});
