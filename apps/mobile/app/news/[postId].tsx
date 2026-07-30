/**
 * One news post - the permalink a notification opens.
 *
 * Exists separately from the feed because "news.created" notifies every other club member, and a
 * notification has to be able to land somewhere specific. A row in a feed is not a destination.
 */

import { StyleSheet, Text, View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { reactionEmoji, type ReactionEmoji } from '@clubchat/shared';
import { contentApi } from '../../src/api.ts';
import { color, space, type } from '../../src/theme.ts';
import { Action, Avatar, Body, Card, DataScreen } from '../../src/ui.tsx';
import { useLoad } from '../../src/use-load.ts';

export default function NewsPostScreen() {
  const { postId } = useLocalSearchParams<{ postId: string }>();
  const load = useLoad(() => contentApi.newsPost(postId), [postId]);

  const react = (emoji: ReactionEmoji) => {
    void contentApi.toggleNewsReaction(postId, emoji).then(load.reload, load.reload);
  };

  return (
    <DataScreen load={load}>
      {(data) => {
        const post = data.post;
        return (
          <Body>
            <Card>
              <View style={styles.author}>
                <Avatar name={post.authorName} />
                <View style={styles.authorText}>
                  <Text style={styles.name}>{post.authorName}</Text>
                  <Text style={styles.meta}>
                    {post.createdAt.slice(0, 16).replace('T', ' ')}
                    {post.updatedAt !== post.createdAt ? '  ·  edited' : ''}
                  </Text>
                </View>
              </View>
              {post.body !== null && <Text style={styles.body}>{post.body}</Text>}
            </Card>

            {/* Every club member can react - not only admins. The same six as chat. */}
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
          </Body>
        );
      }}
    </DataScreen>
  );
}

const styles = StyleSheet.create({
  author: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  authorText: { flex: 1, gap: space.xs },
  name: { ...type.headline, color: color.textPrimary },
  body: { ...type.body, color: color.textPrimary },
  meta: { ...type.bodySmall, color: color.textSecondary },
  reactions: { flexDirection: 'row', gap: space.xs, flexWrap: 'wrap' },
});
