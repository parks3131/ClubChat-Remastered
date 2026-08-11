/**
 * News & Highlights: the club's front page.
 *
 * **A pinned chat message is a reference; a news post is a publication.** The two surfaces coexist
 * deliberately, which is why this screen has no pinning and no ordering controls - it is
 * reverse-chronological, and that is the whole ordering model (`PRD/06` rule 2).
 *
 * Any club admin creates, edits or deletes **any** post, not only their own. Every member reads and
 * reacts. Creating notifies everybody; editing and deleting notify nobody.
 */

import { useState } from 'react';
import { Image, StyleSheet, Text, View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { useDeclareClub } from '../../../../../src/current-space.tsx';
import { reactionEmoji, type ReactionEmoji } from '@clubchat/shared';
import { clubApi, contentApi } from '../../../../../src/api.ts';
import type { NewsPost } from '../../../../../src/api-types.ts';
import { RemoteImage } from '../../../../../src/media-bubble.tsx';
import { pickSquarePhoto, uploadAttachment, UploadError } from '../../../../../src/upload.ts';
import { color, radius, space, type } from '../../../../../src/theme.ts';
import {
  Action,
  Avatar,
  Body,
  Card,
  DataScreen,
  EmptyState,
  Field,
  SectionHeader,
} from '../../../../../src/ui.tsx';
import { useLoad } from '../../../../../src/use-load.ts';

export default function ClubNewsScreen() {
  const { clubId } = useLocalSearchParams<{ clubId: string }>();
  // Inside this club for as long as this screen is mounted, which is what the Clubs tab reads.
  useDeclareClub(clubId);
  const [composing, setComposing] = useState(false);

  const feed = useLoad(() => contentApi.news(clubId), [clubId]);
  const club = useLoad(() => clubApi.detail(clubId), [clubId]);
  const isAdmin = club.data?.club.viewer.isAdmin === true;

  if (composing) {
    return (
      <ComposePost
        clubId={clubId}
        channelId={club.data?.club.channelId ?? null}
        onCancel={() => setComposing(false)}
        onPosted={() => {
          setComposing(false);
          feed.reload();
        }}
      />
    );
  }

  return (
    <View style={styles.flex}>
      <DataScreen
        load={feed}
        isEmpty={(data) => data.posts.length === 0}
        empty={
          <EmptyState
            title="No news yet"
            body={isAdmin ? 'Post a result, a recap or a photo drop.' : undefined}
          />
        }
      >
        {(data) => (
          <Body>
            {data.posts.map((post) => (
              <PostCard key={post.id} post={post} isAdmin={isAdmin} onChanged={feed.reload} />
            ))}
            {data.hasMore && <Text style={styles.meta}>Older posts load as you scroll.</Text>}
          </Body>
        )}
      </DataScreen>

      {isAdmin && (
        <View style={styles.footer}>
          <Action label="New post" onPress={() => setComposing(true)} />
        </View>
      )}
    </View>
  );
}

function PostCard({
  post,
  isAdmin,
  onChanged,
}: {
  post: NewsPost;
  isAdmin: boolean;
  onChanged: () => void;
}) {
  const [confirming, setConfirming] = useState(false);

  const react = (emoji: ReactionEmoji) => {
    void contentApi.toggleNewsReaction(post.id, emoji).then(onChanged, onChanged);
  };

  return (
    <Card>
      <View style={styles.author}>
        <Avatar name={post.authorName} image={post.authorImage} />
        <View style={styles.authorText}>
          {/* Every post shows its creator's name and post time. */}
          <Text style={styles.name}>{post.authorName}</Text>
          <Text style={styles.meta}>
            {post.createdAt.slice(0, 16).replace('T', ' ')}
            {post.updatedAt !== post.createdAt ? '  ·  edited' : ''}
          </Text>
        </View>
      </View>

      {post.body !== null && <Text style={styles.body}>{post.body}</Text>}
      {post.mediaId !== null && (
        <RemoteImage
          mediaId={post.mediaId}
          style={styles.photo}
          resizeMode="cover"
          accessibilityLabel={`Photo posted by ${post.authorName}`}
        />
      )}

      {/* The same six as chat. A check constraint on the column enforces it too. */}
      <View style={styles.reactions}>
        {reactionEmoji.map((emoji) => {
          const held = post.reactions.find((entry) => entry.emoji === emoji);
          return (
            <Action
              key={emoji}
              label={`${emoji}${held ? ` ${held.count}` : ''}`}
              variant={held?.mine ? 'primary' : 'secondary'}
              onPress={() => react(emoji)}
              accessibilityLabel={`React with ${emoji}${held?.mine ? ', remove yours' : ''}`}
            />
          );
        })}
      </View>

      {isAdmin &&
        (confirming ? (
          <>
            {/* Names the post and states what is lost: deletion is permanent, with no tombstone. */}
            <Text style={styles.meta}>
              Delete this post permanently? Unlike a chat message it leaves nothing behind.
            </Text>
            <View style={styles.actions}>
              <Action
                label="Keep"
                variant="secondary"
                style={styles.actionButton}
                onPress={() => setConfirming(false)}
              />
              <Action
                label="Delete"
                variant="danger"
                style={styles.actionButton}
                onPress={() => {
                  void contentApi.deleteNews(post.id).then(onChanged, onChanged);
                }}
              />
            </View>
          </>
        ) : (
          <Action label="Delete post" variant="quiet" onPress={() => setConfirming(true)} />
        ))}
    </Card>
  );
}

function ComposePost({
  clubId,
  channelId,
  onCancel,
  onPosted,
}: {
  clubId: string;
  /**
   * The club's MAIN channel, which governs the photo's access.
   *
   * > **A news photo is uploaded against the club's main channel, and that is not a workaround.**
   * > An upload intent for a photo requires a channel because the channel's access rules are what
   * > govern the object, and a news post has none of its own. The main channel is the right governor:
   * > news is readable by every club member and so is the main channel, so the audience is identical.
   * > Inventing a news-shaped branch in the media pipeline would add a second answer to a question
   * > that already has a correct one.
   */
  channelId: string | null;
  onCancel: () => void;
  onPosted: () => void;
}) {
  const [body, setBody] = useState('');
  const [photo, setPhoto] = useState<{ mediaId: string; localUri: string } | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);

  // A post must have body text, a photo, or both. Enforced here so the button is honest, and by a
  // check constraint on the column so it is true regardless.
  const valid = body.trim().length > 0 || photo !== null;

  const attach = async () => {
    if (channelId === null) {
      setFailed('This club has no chat channel to attach a photo through.');
      return;
    }
    setFailed(null);
    const picked = await pickSquarePhoto();
    if (picked === null) return;

    setUploading(true);
    try {
      const uploaded = await uploadAttachment(channelId, picked, 'photo');
      setPhoto({ mediaId: uploaded.mediaId, localUri: picked.uri });
    } catch (caught) {
      setFailed(
        caught instanceof UploadError ? caught.message : 'That photo could not be uploaded.',
      );
    } finally {
      setUploading(false);
    }
  };

  const submit = async () => {
    setBusy(true);
    setFailed(null);
    try {
      await contentApi.createNews(clubId, {
        body: body.trim().length > 0 ? body.trim() : null,
        mediaId: photo?.mediaId ?? null,
      });
      onPosted();
    } catch {
      setFailed('Could not post. A post needs some text or a photo.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Body>
      <SectionHeader title="New post" />
      <Field label="What happened" value={body} onChangeText={setBody} multiline />

      {photo !== null ? (
        <>
          {/* The local uri, so the picked photo appears without waiting on a round trip. */}
          <Image source={{ uri: photo.localUri }} style={styles.photo} resizeMode="cover" />
          <Action label="Remove photo" variant="secondary" onPress={() => setPhoto(null)} />
        </>
      ) : (
        <Action
          label={uploading ? 'Uploading...' : 'Add a photo'}
          variant="secondary"
          disabled={uploading}
          onPress={() => void attach()}
        />
      )}

      <Text style={styles.meta}>
        A post needs text, a photo, or both. Posting tells every other member of the club.
      </Text>
      {failed !== null && <Text style={styles.error}>{failed}</Text>}
      <View style={styles.actions}>
        <Action label="Cancel" variant="secondary" style={styles.actionButton} onPress={onCancel} />
        <Action
          label={busy ? 'Posting' : 'Post'}
          style={styles.actionButton}
          disabled={busy || uploading || !valid}
          onPress={() => void submit()}
        />
      </View>
    </Body>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: color.appBackground },
  footer: {
    padding: space.md,
    backgroundColor: color.chrome,
    borderTopWidth: 1,
    borderTopColor: color.divider,
  },
  author: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  authorText: { flex: 1, gap: space.xs },
  name: { ...type.headline, color: color.textPrimary },
  body: { ...type.body, color: color.textPrimary },
  meta: { ...type.bodySmall, color: color.textSecondary },
  error: { ...type.bodySmall, color: color.error },
  reactions: { flexDirection: 'row', gap: space.xs, flexWrap: 'wrap' },
  photo: { width: '100%', aspectRatio: 1, borderRadius: radius.sm, backgroundColor: color.fallback },
  actions: { flexDirection: 'row', gap: space.sm },
  actionButton: { flex: 1 },
});
