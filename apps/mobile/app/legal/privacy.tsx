/**
 * Privacy Policy.
 *
 * Reachable **signed out as well as signed in**, which is why it sits outside every auth guard -
 * sign-up links to it from its consent line, and somebody who has not got an account yet is exactly
 * who needs to read it.
 *
 * > **The obligation ADR-0005 adds is stated plainly below, not buried**: without end-to-end
 * > encryption, message content is readable by the service, and the policy has to say so. The text
 * > here is an in-house first draft and explicitly not legal advice; a real review is a release
 * > blocker tracked in PRD/17.
 */

import { Linking, Pressable, StyleSheet, Text } from 'react-native';
import { Body, SectionHeader } from '../../src/ui.tsx';
import { SUPPORT_EMAIL, supportMailto } from '../../src/support.ts';
import { color, type } from '../../src/theme.ts';

export default function PrivacyScreen() {
  return (
    <Body>
      <SectionHeader title="What we collect" />
      <Text style={styles.p}>
        Your email address, your name, and anything you choose to add to your profile: a photo, a
        bio, a city, a school, and a date of birth. Your date of birth is never shown to other
        members. Your email is used for sign-in and is never shown to other members.
      </Text>

      <SectionHeader title="Who can see what" />
      <Text style={styles.p}>
        Your profile is visible to people who share a club with you. Messages are visible to the
        members of the club, race or conversation they were sent in. A direct message is visible to
        the two people in it.
      </Text>

      <SectionHeader title="Message content is readable by the service" />
      <Text style={styles.p}>
        Messages are encrypted in transit and at rest, but they are not end-to-end encrypted. That
        means we are technically able to read message content, and we do so only where the product
        requires it: to deliver messages, to compose notifications, and - for a reported direct
        message - to let a moderator read a narrow window around what was reported. Every such read
        is logged.
      </Text>

      <SectionHeader title="What we do not do" />
      <Text style={styles.p}>
        No analytics, no tracking, and no sharing your data with third parties. Share links carry an
        opaque club token and no personal data.
      </Text>

      <SectionHeader title="Deleting your account" />
      <Text style={styles.p}>
        Deleting your account erases your profile and permanently blocks future sign-in. Messages you
        have already sent stay in their conversations without your name on them, because removing
        them would tear holes in other people's conversations.
      </Text>

      <SectionHeader title="Contact" />
      <Text style={styles.p}>
        To ask about your data, to report something, or to reach a person about anything on this
        screen, email us.
      </Text>
      <Pressable
        onPress={() => void Linking.openURL(supportMailto('ClubChat: privacy')).catch(() => {})}
        accessibilityRole="link"
        accessibilityLabel={`Email support at ${SUPPORT_EMAIL}`}
      >
        <Text style={styles.email}>{SUPPORT_EMAIL}</Text>
      </Pressable>

      <Text style={styles.draft}>
        This is an in-house first draft and is not legal advice.
      </Text>
    </Body>
  );
}

const styles = StyleSheet.create({
  p: { ...type.body, color: color.textPrimary },
  email: { ...type.body, color: color.accent },
  draft: { ...type.bodySmall, color: color.textSecondary, fontStyle: 'italic' },
});
