# Privacy Policy

**Last updated: 2026-08-25**

> **This document is not legal advice.** It was written in-house by the people who built ClubChat,
> and it is waiting on review by a lawyer. We have published it because it is more useful to you
> accurate and unreviewed than absent, and because everything in it is a description of what the
> software actually does. If a lawyer's review changes anything, the date above changes with it.

ClubChat is a messaging app for university clubs. This policy explains what we collect, why we
have it, who can see it, how long we keep it, and how to get rid of it. It is written in plain
English on purpose. If something here is unclear, email
[support@clubchatapp.com](mailto:support@clubchatapp.com) and we will explain it.

"We" means the people who run ClubChat. "You" means the person using it.

---

## The short version

- **Your messages are not end-to-end encrypted. They can be read by us.** This is the most
  important sentence in this document and it has its own section below.
- We collect what you type into ClubChat and almost nothing else. No advertising, no advertising
  identifiers, no location, no contacts, no selling your data to anyone.
- There is no analytics SDK in the app and nothing that builds a profile of you. We do time a
  sample of requests, so we can find what is slow. Section 2 says exactly what that records and
  who gets it.
- You must be 18 or over to have an account.
- You can delete your account yourself, from inside the app, at any time.
- Everything is stored in the United States.

---

## 1. Your messages are not end-to-end encrypted

**ClubChat does not use end-to-end encryption. Your messages, including your direct messages, are
stored on our servers in a form we can read, and can be read by us.**

That is a deliberate design decision, not an oversight, and it is worth understanding before you
decide what to say in the app.

**Why it is built that way.** ClubChat's server writes into your conversations. It posts "Alice
added Bob to the roster", it puts poll cards and event cards into chat, and it writes the text of
the notification that appears on your lock screen. A moderator has to be able to read a message
you report, or reporting a message would achieve nothing. None of that is possible if the server
cannot read what is in a conversation.

**What it means in practice.** These are the only situations in which a person reads your message
content:

- **To deliver it and to notify people about it.** This is automatic. Software reads the text to
  put it in the conversation, to work out who to notify, and to compose the notification.
- **When somebody reports a message.** Reporting is what opens a message to a human reviewer. See
  section 9 below for exactly who that is and how much of the
  conversation they can see.
- **When the automatic content filter examines it.** This is software, not a person, and it only
  looks at the words in the message body. See section 9 below.
- **When we have to look at the database to fix a fault.** This is rare, it is not routine, and we
  do not go looking through conversations for anything else.

**What it does not mean.** We do not read your conversations for fun, for training, for
advertising, or to build a profile of you. We do not sell message content and we do not share it
with any other company.

If you need a conversation that the people running the service genuinely cannot read, ClubChat is
not the right app for it. Use something that offers end-to-end encryption.

---

## 2. What we collect

### When you create an account

| What | Why |
|---|---|
| Your name | It is what other members see next to your messages and on rosters |
| Your email address | To sign you in and to send a password reset link. It is never shown to other members |
| Your password | Stored as a scrypt hash, never as text. Nobody at ClubChat can read your password |

That is the whole sign-up form. We do not ask for a phone number, a date of birth, a student ID or
a university email address.

### What you can add to your profile, if you want to

A profile photo, a short bio, a city, a school, and a date of birth. **All of these are optional
and you can clear any of them at any time.** Your date of birth is never shown to another member:
the server does not include it in anybody else's copy of your profile.

### What you create while using ClubChat

- **Messages** you send in club chats, race chats, the Eboard space, and direct messages.
- **Photos and files** you post, and the photo you set as a profile or club picture.
- **Reactions, replies, pinned messages, and poll votes.**
- **The things clubs organise**: events, races, weekly meetups, car groups, news posts, rosters and
  who is on them.
- **Read positions**, so the app knows what you have already seen and does not notify you about it
  twice, and **mutes**, so a conversation you have muted stays muted.

### From your device

- **A push notification token**, if you allow notifications. This is an identifier the operating
  system gives us so we can make your phone buzz. We store the token and which platform it came
  from (`ios`, `android` or `web`), and nothing else about your device. If you never allow
  notifications, we never have one.
- **Your IP address and the app or browser version**, recorded against each sign-in session. This
  is standard sign-in security information: it is what lets us tell one session from another.
- **Counters used to slow down abuse.** Sign-in attempts, sign-up attempts and invite-link
  lookups are counted against the IP address they come from. Password reset requests are counted against a one-way hash of the email
  address, never the address itself, so the list of people who have asked for a reset cannot be
  read out of that cache.

### Speed measurements

**We time some of the work the app and our servers do, so we can find out what is slow.** The
industry name for this is performance tracing, and it is switched on. It is worth setting out in
full, because it is the only thing we measure that is not something you typed.

**How much.** About 10% of requests are timed, picked at random. The rest are not measured at all.
The app on your phone samples at the same rate. The health checks our hosting platform makes every
few seconds are never timed, because they measure nothing about anybody.

**What one timing record contains:**

- **Which route was called, with the ids taken out.** `GET /clubs/:id`, not the id of your club.
- **How long it took**, and how long the database queries and outgoing requests inside it took. A
  query is recorded by its shape, without the values that went into it.
- **Which server handled it, and which build** of the app or the server it was.

**What it does not contain.** No message text, no photos, no files, and nothing out of the body of
what you sent. Not your name and not your email address. The setting that would attach your
details, the request's headers or your IP address to a report is switched off deliberately, in the
app and on all three servers.

**Who gets it.** Sentry, the same company that receives our crash reports. See section 6.

**What it is not.** It is not advertising, it is not an analytics profile of you, and it is not
sold or shared with anybody. Nobody reads these records to see what you did. They are read to find
out why something took two seconds.

### What we do not collect

- **No analytics SDK, and no profile of you.** We do not record which screens you open, which
  buttons you press, or how long you spend in the app. There is no analytics or advertising code
  of any kind in it. The one thing we do measure is speed, and it has its own section above.
- **No advertising, and no advertising identifiers.**
- **No location.** The app never asks for location permission and never collects one. A meetup can
  carry a map link that somebody pasted in, which is a link and not your position.
- **No contacts, no calendar, no microphone.** The app asks for the camera only when you scan a
  club QR code, and for your photo library only when you pick a photo to post or save one.
- **No screen recording and no session replay.** Sentry's Session Replay feature is switched off
  deliberately, because a replay of a private conversation is the most personal thing this product
  could hold.
- **No profiling.** We time whole requests, as described above. We do not sample what the code on
  your phone is doing from moment to moment while you use it.
- **We never sell your data, and we do not share it with anyone for their own purposes.** The only
  companies that touch it are the ones listed in section 6 below, and each of them is doing a job
  for us.

---

## 3. Who can see what

| What | Who can see it |
|---|---|
| Your name and profile photo | People who share a club with you, and anybody you already have a conversation with |
| Your bio, city and school | The same people |
| Your date of birth | **Only you** |
| Your email address | **Only you.** It is never shown to other members |
| A message in a club, race or Eboard chat | The members of that space |
| A direct message | The two people in it |
| A photo or file you post | The people who can see the message it is attached to |
| A reported message | See section 9, on moderation |

Your profile is not public. Somebody who does not share a club with you and has no conversation
with you cannot open it, and does not even get told that the account exists.

A club invite link carries a random token and nothing about you. Anybody who has the link can see
the club's name and how many members it has, so they know what they are joining. It tells them
nothing about who the members are.

---

## 4. Notifications, and what leaves our servers to reach your phone

When somebody sends you a message or mentions you, we send a push notification.

**The notification contains a preview of the message.** For a direct message that is the sender's
name and what they wrote. For a group chat it is the name of the chat, the sender's name, and what
they wrote. That is deliberate, because a notification that says only "new message" is not much use
on a lock screen.

**That preview leaves our servers.** It goes to the Expo push service, and from there to Apple's
push network on an iPhone or Google's on an Android phone, and then to your device. Those companies
handle the delivery. They are not sent the rest of the conversation.

If you would rather that did not happen, turn off notifications for ClubChat in your phone's
settings. Everything else in the app carries on working.

---

## 5. Email we send you

We send exactly one kind of email: **a password reset link, when you ask for one.** It goes out
through Resend, an email delivery company, from `noreply@clubchatapp.com`.

There is no marketing email, no newsletter, no digest, and no "we miss you" mail. We do not need an
unsubscribe link because there is nothing to unsubscribe from.

---

## 6. Where your data is, and who else touches it

ClubChat runs in the United States. **If you are outside the United States, using ClubChat means
your information is stored there.** Our servers are in Ashburn, Virginia. The database is in the
`us-east-1` region.

We do not run our own hardware, so a small number of other companies hold parts of this on our
behalf. Every one of them is based in the United States.

| Company | What they hold or do |
|---|---|
| **Fly.io** | Runs the ClubChat servers |
| **Neon** | The Postgres database: accounts, profiles, messages, everything the app stores as data |
| **Cloudflare** | R2 object storage holds every photo and file. One Cloudflare Worker serves them to the app, and another serves clubchatapp.com itself: this page, the Terms, and the page a club invite link opens |
| **Upstash** | Redis. Short-lived working data: who is connected, abuse counters. Never a permanent record of anything |
| **Resend** | Sends the password reset email |
| **Sentry** | Receives crash and error reports from the servers and from the app |
| **Expo** | Delivers push notifications, which is how the preview in section 4 reaches Apple or Google. Also serves the app's JavaScript updates. Both are described below |
| **Apple and Google** | Deliver the push notification to the phone itself, over their own networks |

Each of these is doing a specific job for us. None of them is given your data for their own
purposes, and none of them pays us for it.

**About crash reports.** When the app or a server hits an error, we send a report to Sentry so we
can find out what broke. The report contains the error, where in the code it happened, and which
build it was. It is configured not to attach anything you typed. We can tell you which account hit
an error, because that is often the only way to work out what went wrong, but the message you were
writing is not in the report. The timing records described in section 2 go to the same company.

**About app updates.** We can update the JavaScript part of ClubChat without putting a new version
in the App Store, which is how a fix reaches you in hours instead of after an app review. **So each
time you open the app, it asks Expo's update service whether there is a newer bundle for the build
you are running.** That request says which platform you are on, which version of the app's runtime
your build has, and which release channel it takes updates from. Because it comes from your device,
Expo's servers see your IP address, the same as any server your phone connects to. It carries no
account, no name, no email address, and nothing from inside the app. If there is a newer bundle it
downloads in the background, and the app starts using it the next time you open it. The app never
waits on that check to start, so nothing about this slows the app down or stops it working offline.

---

## 7. How long we keep things

| What | How long |
|---|---|
| Your account and profile | Until you delete your account |
| Messages | Until somebody deletes them, or the conversation is deleted |
| Photos and files | While the thing they are attached to still exists |
| The text of a deleted message | **Removed from the database immediately.** A deleted message leaves a marker saying a message was here, with no text in it |
| A photo attached to a deleted message | Kept. The conversation and its gallery are still there |
| Photos and files whose message is gone entirely | Deleted from storage automatically |
| An upload you started and never finished | Deleted after 24 hours |
| Notifications you have read | 90 days |
| Notifications you never opened | 180 days |
| Our internal record of things that happened, used to deliver messages and effects | 7 days after it is processed |
| Sign-in sessions | Until they expire, until you sign out, or until a password reset ends them |
| A record that a moderator opened a reported direct message | Kept. See section 9, on moderation |
| Reports, and what a moderator did about them | Kept, so we can show a report was dealt with |

**One honest gap.** When a whole club or a news post is deleted, the photos that were in it stop
being reachable through the app straight away, but the stored copies are not automatically deleted
from our file storage. Only photos attached to individual messages are cleaned up automatically
today. If you want a specific file removed, email
[support@clubchatapp.com](mailto:support@clubchatapp.com) and we will delete it.

---

## 8. Deleting your account

You can delete your account yourself, from Profile in the app. There is a confirmation step, and it
cannot be undone.

**What deletion does, exactly:**

- **Your profile is emptied.** Your photo, bio, city, school and date of birth are erased. Your name
  is replaced with "Deleted member".
- **Your email address is released**, so you can sign up again later with the same address if you
  want to. It is replaced on the old account with a dead address that goes nowhere.
- **Sign-in is blocked permanently.** Your password is deleted, every session is ended, and every
  device registered for notifications is removed. Any live connection the account still has open is
  cut.
- **You are removed from every club, Eboard, race roster and car group.**
- **Your messages stay where they are, with your name off them.** They show as sent by a deleted
  member. We do not remove them, because a message vanishing out of the middle of a conversation
  tears a hole in it for everybody else who was there. Photos and files you posted stay with those
  messages for the same reason.

**One precondition:** if you own a club, you have to hand it over to somebody else or delete the
club first. ClubChat refuses the deletion until you have, and tells you which clubs are in the way.
A club with no owner has no way to recover, so we will not create one.

If you would rather have your content removed as well as your account, email
[support@clubchatapp.com](mailto:support@clubchatapp.com) and we will talk about what is possible.
Some of it, such as a message in the middle of somebody else's conversation, we will not remove.

---

## 9. Moderation, reporting and blocking

### Blocking

You can block anybody you share a club with, or anybody you already have a conversation with.
Blocking is instant, it needs nobody's approval, and it is not reviewed by anyone. A blocked person cannot message you, and the two of you disappear from each
other's search results. They are not told that you blocked them.

### Reporting

You can report a message, and you can report a person. Where the report goes depends on what was
reported:

| What was reported | Who reads it |
|---|---|
| A message in a club, race or Eboard chat | The admins of that space |
| A message in a **direct message** | ClubChat platform moderators |
| A **person** | ClubChat platform moderators |

Platform moderators are a very small number of people, named in the service's configuration. Being
a platform moderator does not make somebody an admin of your club, and it gives them no access to
anything except the reports queue.

**When a moderator opens a reported direct message, this is exactly what they see and what is
recorded:**

- They see the reported message and **up to five messages either side of it**, so they can tell an
  argument from abuse. They do not get the whole conversation, and they cannot browse it.
- **The read is recorded**: which moderator, which message, and which window of the conversation
  they were shown. That record is kept.

A moderator who finds something genuinely abusive can remove the reported message and suspend the
account that sent it. A suspended account cannot sign in and is told that it has been suspended,
with the support address to write to. A suspension can be lifted.

### The automatic filter

Every message is checked against a short list of slurs before it is posted. This is software. No
person sees your message because of it.

- A small number of terms are **refused**. The message is not posted and nothing is stored.
- A slightly larger number of ambiguous terms are **allowed through and reported automatically**, so
  that a human decides rather than a word list. The message posts normally.
- Everything else, which is almost everything, passes without anything happening. Ordinary swearing
  is not filtered.

The filter reads the words of the message and nothing else. It does not look at names, photos or
documents.

---

## 10. Security

- **In transit:** everything between the app and our servers goes over HTTPS or a secure WebSocket.
- **At rest:** our database and file storage providers encrypt what they hold.
- **Passwords** are stored as scrypt hashes. We cannot read them, and neither can anybody who
  obtains the database.
- **Your session token** is kept in your phone's secure storage, not in ordinary app storage.
- **Photos and files** are private by default. Getting one out of storage needs a short-lived signed
  link that is issued only after we have checked you are allowed to see the message it belongs to.
- **A password reset link** expires after an hour, works once, and signs out every other device.

No system is perfectly secure, and we are not going to claim otherwise. If you find a security
problem in ClubChat, please email [support@clubchatapp.com](mailto:support@clubchatapp.com) and we
will take it seriously.

---

## 11. What is stored on your phone

The app keeps a copy of your recent conversations on your device so it works without a signal and
opens quickly. That copy lives in the app's own private storage, where no other app can read it.

The app also keeps the most recent JavaScript update it has downloaded, so it can start from it
next time. See section 6 for what asking for that update discloses.

Signing out removes your session token from the device and stops notifications for that account.
Deleting the app removes the local copy of your conversations along with it.

---

## 12. Age

**You must be 18 or over to use ClubChat.** You confirm this when you create an account.

ClubChat is not designed for children and we do not knowingly keep accounts for anyone under 18. We
do not verify ages, because collecting every member's birthday to check something almost nobody
misstates is the wrong trade for a club app. If you believe somebody under 18 has an account, email
[support@clubchatapp.com](mailto:support@clubchatapp.com) and we will remove it.

---

## 13. Your choices

- **Change or clear your profile** at any time, from Profile in the app. It is yours and nobody
  else can edit it, including your club's owner.
- **Turn off notifications** in your phone's settings, or mute an individual conversation in the
  app.
- **Block another member**, instantly, without asking anyone.
- **Delete your account**, from Profile, whenever you like.
- **Ask us for a copy of your data**, or ask us to correct something, by emailing
  [support@clubchatapp.com](mailto:support@clubchatapp.com). We will answer.

Depending on where you live you may have further rights over your data, such as asking us for a
copy of it, asking us to correct it, or asking us to delete it. Write to the address above and we
will do our best to help.

---

## 14. Changes to this policy

If we change this policy, we will change the date at the top of the page. The current version is
always the one published at [clubchatapp.com/privacy](https://clubchatapp.com/privacy).

---

## 15. Contact

Email **[support@clubchatapp.com](mailto:support@clubchatapp.com)** about anything in this
document, about your data, or about something somebody has done in the app. We aim to answer a
report about objectionable content within 24 hours.
