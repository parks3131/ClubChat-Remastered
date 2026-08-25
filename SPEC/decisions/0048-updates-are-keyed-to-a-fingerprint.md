# ADR-0048: Over-the-air updates are keyed to a fingerprint

| | |
|---|---|
| Status | Accepted |
| Date | 2026-08-25 |
| Deciders | parks3131 |
| Supersedes | none |

## Context

ClubChat is live and a production iOS build is in TestFlight. Every fix to the app, down to a
one-word copy change, is currently a full store release: an EAS build, a submission, and Apple
review.

Two documents already describe the way out as though it were wired.
[Deployment](../TECH/21-deployment.md) lists "JavaScript bundles | EAS Update | Phones" in its
inventory and "Client JavaScript | `eas update` | Hours to a day, as phones relaunch" in its table
of how a change reaches a person. [Build phases](../TECH/16-build-phases.md) lists "over-the-air
updates so a fix does not need a store release" under release readiness, not started. It was the
second document that was right: `expo-updates` was not a dependency, `app.json` carried no
`updates` block and no `runtimeVersion`, and `eas.json` carried no channels. There was nothing to
publish to and nothing that could have consumed it.

**The decision that matters is not whether to turn it on. It is what tells a phone that a bundle is
safe to run.**

That is the runtime version. `expo-updates` compares the runtime version of a published update
against the runtime version compiled into the binary asking for it, and refuses anything that does
not match. Get it right and an incompatible bundle is never installed. Get it wrong and a bundle
that imports a native module the binary does not contain is downloaded and launched - and a native
import resolves at bundle load, so it is a launch-time crash that no JavaScript can catch and that
the person holding the phone cannot escape except by deleting the app. [Deployment](../TECH/21-deployment.md)
rule 3 names this exact failure and records that it took the app down twice in one hour; `AGENTS.md`
failure modes 8 and 32 are the same event. Those were development crashes on one device. Over the
air, the same mistake reaches everybody who relaunches.

Three further facts shape the answer.

- **This project is Expo CNG.** `apps/mobile/ios` is generated and gitignored, and native
  configuration is expressed through `app.json`. So "did the native runtime change" is a question
  about `app.json`, the config plugins and the dependency tree, not a question about a checked-in
  Xcode project somebody might have edited.
- **`appVersionSource` is `remote`.** `eas.json` already delegates the version number to EAS, and
  the production profile auto-increments it. The `version` in `app.json` is therefore not a value
  anybody maintains by hand, which matters below.
- **There are two distribution profiles with different environments.** `preview` and `production`
  in `eas.json` already carry different `EXPO_PUBLIC_SENTRY_ENVIRONMENT` values and are built for
  different audiences.

## Decision

**Runtime versions come from `@expo/fingerprint`, and each build profile takes updates from a
channel of its own name.**

Five things are decided together.

1. **`runtimeVersion` is `{ "policy": "fingerprint" }`.** The runtime version is a hash of
   everything in the project that affects the native runtime: the dependency tree, the config
   plugins, `app.json`, and any local native module. Change any of them and the hash changes, so
   the update published from that tree can only ever be offered to a binary built from the same
   tree.
2. **`updates.url` is `https://u.expo.dev/216d5aa2-572c-4d1f-a6e9-5408c82a9b82`**, the EAS Update
   endpoint for the project id already in `extra.eas.projectId`.
3. **`preview` publishes to the `preview` channel and `production` to the `production` channel.**
   The `development` profile is given no channel at all: it builds a dev client, which loads its
   JavaScript from Metro, so a channel there would be a claim that it takes updates when it does
   not.
4. **`checkAutomatically` is `ON_LOAD` and `fallbackToCacheTimeout` is `0`.** The app checks for an
   update at launch and downloads it in the background. It does not wait for it, and it does not
   reload itself when the download finishes: the update is applied at the **next** launch.
5. **There is no update UI.** No banner, no "restart to update" prompt, no `reloadAsync` call
   anywhere in the app.

## Rejected alternatives

### `appVersion`, the policy that reads the app's version string

Rejected, and it is the one worth explaining because it is the obvious choice.

Under `appVersion` the runtime version is `app.json`'s `version` field, so compatibility is decided
by a human remembering to bump a number in the same change that added a native module. Expo's own
documentation states the failure directly: *"If you forget to bump the app version when modifying
the native runtime, mismatches occur."* That is a procedure, and this project already has the same
procedure written down as [Deployment](../TECH/21-deployment.md) rule 3, and already has a history
of it being missed twice in one hour by people who knew the rule.

It is worse here than in a typical project, for a specific reason: **`appVersionSource` is
`remote`**. The version this policy would read is not maintained in the file it is read from - EAS
owns it, and the production profile increments it on every build. Keying compatibility to a number
that a build server changes on its own schedule couples two things that have nothing to do with
each other, in a way that fails silently in both directions. An auto-incremented version splits the
runtime version away from installed builds that are still perfectly compatible, stranding them from
updates they could have taken; a version that does not move across a native change lets an
incompatible bundle through.

### `nativeVersion`, version plus build number

Rejected for the same reason as `appVersion`, doubled. It still depends on a number changing when
the native runtime changes, and it additionally changes on every build whether or not anything
native moved - so almost every build starts life unable to take any update already published.

### One channel for both build profiles

Rejected. The two profiles carry different environment blocks: a `preview` build points at
`preview` in Sentry, a `production` build at `production`. One channel means a bundle published for
testing installs itself on TestFlight and store builds, which is the entire audience, with no step
in between. Separate channels are what make "try it on the preview build first" possible at all,
and the cost is one word per profile.

### Fetch in the foreground: hold the splash, or prompt and reload

Rejected on two grounds.

The first is the app's own startup. `FontGate` already holds the first frame until three typefaces
have loaded, which [Design system](../TECH/13-design-system.md) rule 4 requires so that no screen
flashes system fonts. Putting a network request in front of that gate means a cold start on a bad
connection is two waits deep with nothing on screen, and `fonts.tsx` already records why that is
unacceptable: *"a blank screen during a slow font fetch is indistinguishable from the app being
broken"*. `fallbackToCacheTimeout: 0` is what keeps the update off the launch path entirely.

The second is that reloading is a worse experience than waiting. An app that swaps its own
JavaScript out from under somebody mid-session loses whatever they were doing, and a prompt asking
them to restart asks them to care about a distinction they have no reason to know exists. A fix
that lands on the next launch instead of this one is not worth either.

## Consequences

- **No build currently in TestFlight can receive an over-the-air update, and this change does not
  give it one.** `expo-updates` is a native module: the code that checks for and applies updates
  has to be *in* the binary. The first build made after this change is the earliest one that can
  ever take an update. This is inherent to how over-the-air updates work rather than a defect, but
  it means the payoff starts one store release from now, not today.
- **Every change that moves the fingerprint forces a new build before updates can reach it.** Adding
  a dependency with native code, editing the `plugins` array, changing a permission, or moving the
  Expo SDK all produce a new runtime version, and the update published from that tree will be
  offered to no installed build. This is the protection working, and it is the trade the policy
  makes: more builds, in exchange for the incompatible-bundle failure being impossible rather than
  merely against the rules. [Deployment](../TECH/21-deployment.md) rule 3 stops being a procedure
  people follow and becomes a property of the system.
- **The runtime version is not a value anybody can read out of the repository.** `npx expo config
  --type introspect` resolves it to the literal string `file:fingerprint`; the real hash is computed
  by EAS at build time and at publish time. "Which builds can take this update" is answered by
  `eas update` output and the EAS dashboard, not by reading `app.json`.
- **Publishing to the wrong channel is now possible and nothing in the repository prevents it.**
  `eas update --channel production` is a command somebody types. The blast radius of getting it
  wrong is every production install that relaunches.
- **A crash arriving from an over-the-air update reports against the binary's release.**
  `src/monitoring.ts` sets no `release` or `dist`, so Sentry cannot yet tell a crash in update N
  from a crash in the build it landed on, and source maps for an update are not uploaded by
  anything. This is a real gap opened by this decision and is not closed by it.
- **An update is only recallable for phones that have not taken it yet.** Republishing a good
  bundle to the same channel is the fix, and it reaches people at the same speed the bad one did:
  hours to a day, as phones relaunch.
