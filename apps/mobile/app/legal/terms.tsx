/**
 * Terms.
 *
 * Reachable signed out as well as signed in, for the same reason as the Privacy Policy: sign-up
 * links to both from its consent line.
 *
 * > **Two of Apple's four guideline 1.2 requirements are discharged on this screen**, which is why
 * > the wording below is not merely descriptive. A UGC app's terms must "make it clear that there
 * > is no tolerance for objectionable content or abusive users", and the app must carry "published
 * > contact information so users can easily reach you". The Behaviour and Contact sections are
 * > those two, and neither should be softened without knowing what it is holding up.
 */

import { Linking, Pressable, StyleSheet, Text } from 'react-native';
import { Body, SectionHeader } from '../../src/ui.tsx';
import { SUPPORT_EMAIL, supportMailto } from '../../src/support.ts';
import { color, type } from '../../src/theme.ts';

export default function TermsScreen() {
  return (
    <Body>
      <SectionHeader title="Using ClubChat" />
      <Text style={styles.p}>
        ClubChat is for running clubs and their members to organise chat, races, calendars and
        training. You are responsible for what you post.
      </Text>

      <SectionHeader title="Behaviour" />
      <Text style={styles.p}>
        There is no tolerance for objectionable content or abusive users. Do not harass, threaten
        or impersonate anybody, do not post sexual, violent or hateful content, and do not post
        content you have no right to post.
      </Text>
      <Text style={styles.p}>
        Anybody can report a message, and anybody can block another member instantly and without
        asking. Club admins moderate their own clubs and can delete a message or remove and ban a
        member. Reports in a direct message go to a platform moderator instead, because a
        conversation between two people has no admin.
      </Text>
      <Text style={styles.p}>
        We review reports and act on them. Breaking these rules can mean the message being removed
        and your account being suspended, which signs you out everywhere and stops you signing in
        again.
      </Text>

      <SectionHeader title="Your club, your content" />
      <Text style={styles.p}>
        You keep ownership of what you post. Deleting a club removes its chat history, races,
        meetings and polls for every member of it.
      </Text>

      <SectionHeader title="Ending it" />
      <Text style={styles.p}>
        You can delete your account at any time from your profile. If you own a club you will be
        asked to hand it over or delete it first, because a club without an Owner cannot be
        recovered.
      </Text>

      <SectionHeader title="Contact" />
      <Text style={styles.p}>
        To report something, ask about your data, or reach a person about anything on this screen,
        email us. We aim to answer a report about objectionable content within 24 hours.
      </Text>
      {/*
        Tappable, and the address is also shown as text. A `mailto:` that fails to open on a
        device with no mail client would otherwise leave a "contact us" that contacts nobody,
        which is the failure this section exists to close.
      */}
      <Pressable
        onPress={() => void Linking.openURL(supportMailto('ClubChat: report')).catch(() => {})}
        accessibilityRole="link"
        accessibilityLabel={`Email support at ${SUPPORT_EMAIL}`}
      >
        <Text style={styles.email}>{SUPPORT_EMAIL}</Text>
      </Pressable>

      <Text style={styles.draft}>This is an in-house first draft and is not legal advice.</Text>
    </Body>
  );
}

const styles = StyleSheet.create({
  p: { ...type.body, color: color.textPrimary },
  email: { ...type.body, color: color.accent },
  draft: { ...type.bodySmall, color: color.textSecondary, fontStyle: 'italic' },
});
