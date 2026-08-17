# 41. A document opens in the platform's own viewer, through a local native module

Date: 2026-08-17

## Status

Accepted. Extends [PRD/13](../PRD/13-media-and-galleries.md) rule 7 and
[DESIGN/15](../DESIGN/15-document-bubble.md), and is the first local native module in
`apps/mobile/modules/`.

## Context

A document bubble had shown a filename and a size since 2026-07-30 and had never been openable. The
founder asked for two things in one sentence - *"if I upload any documents, I can click the
document first of all"*, with a mockup for the tile - and then, seeing a first answer, sent a
screen recording of **GroupMe** and asked *"can we do like this for pdf"*.

The recording is specific and worth reading closely, because it names the implementation. Tapping
the file opens a full-screen white sheet **inside GroupMe**: the filename across the top with a
close button beside it, a `1 of 2` page counter, the PDF rendered inline, and a magnifier and a
share control along the bottom. That is not a browser, and it is not a share sheet. It is
`QLPreviewController` - iOS's own document previewer - which is why it can count pages and search
text without GroupMe knowing what a PDF is.

Nothing in an Expo app's JavaScript can present one. The question was therefore not *what* to
build but *what to build it out of*, and the four candidates differ enough to be worth recording.

## Decision

### Tapping a document previews it, full screen, in the platform's own viewer

A local Expo module, `apps/mobile/modules/quick-look`, wrapping `QLPreviewController`. One Swift
file and a podspec.

It renders all seven types the upload allowlist accepts - PDF, DOC, DOCX, XLS, XLSX, TXT, CSV -
because it is the same component Files and Mail use, and it arrives with the page count, the text
search and the share control already in it.

### The share sheet stays, as the fallback rather than as the destination

`openDocument` stages the file, asks the previewer to show it, and hands it to
`Sharing.shareAsync` only if that answers no. Two things answer no: a type iOS has no previewer
for, and **a binary built before this module existed**, which includes every build already on a
phone. The fallback is what keeps a document openable on an app that has not been rebuilt yet
instead of turning the tile into a control that does nothing.

### The module is required optionally, never required

`requireOptionalNativeModule`, which answers `null` rather than throwing.

This is [TECH/14](../TECH/14-engineering-pitfalls.md) entry 8 applied before it happens rather than
after: a native module that does not exist in the running binary throws **at import time**, and an
import-time throw takes the whole bundle down - a blank screen on every route, not one broken
button. That failure has already shipped twice in this repo, once from `expo-sqlite`'s wasm and
once from `expo-media-library` on web. A module whose whole purpose is to be newer than some
installed binaries would have been the third.

## Rejected alternatives

**The share sheet as the destination.** What was built first, and what the founder was shown
before the recording arrived. It reaches the same previewer - iOS puts **Preview** first in the
action list for a document - and it needs no rebuild at all, which made it the right first answer.
It is one tap too many and the intermediate sheet is the wrong object: the person tapped a
document to read it, not to decide where to send it.

**`expo-web-browser`, an in-app Safari sheet.** Stays inside the app and renders a PDF, so it
looks close on paper. It is wrong on both ends: the chrome is a browser's, with a URL bar over a
signed link nobody should be reading, and a `.docx` or `.xlsx` downloads rather than opening -
which is most of the allowlist. It also costs the same rebuild as the real thing.

**`react-native-file-viewer`.** Presents the same `QLPreviewController` and would have been ~15
lines of integration instead of ~60 of Swift. Rejected on
[AGENTS.md](../../AGENTS.md) standing instruction 3: development cost is close to worthless as an
argument, and a third-party package in the binary is a dependency to track, audit and eventually
migrate, for a wrapper over a framework that has not changed since iOS 4. Sixty lines that this
repo owns is simpler to reason about in a year.

**A DOM component around an `<iframe>`, to avoid the rebuild.** `ExpoDomWebView` is already
compiled into the installed binary, so this was the only candidate needing no new build. It
covers PDFs at best - WKWebView's inline-PDF support in an iframe is unreliable and a `.docx`
renders as nothing - and the chrome, the page count and the search would all have had to be
rebuilt by hand, badly. Offered to the founder with its uncertainty stated, and not chosen.

## Consequences

**The app has to be rebuilt to get this**, on the simulator and on the founder's phone, and this
is the first change in the project where a JavaScript reload is not enough. The optional require
is what makes that a gradual rollout rather than a cliff: an un-rebuilt binary keeps the share
sheet and says nothing about it.

**`apps/mobile/modules/` exists now**, and `package.json` carries
`expo.autolinking.nativeModulesDir`. Autolinking has no default for that key - without it the
directory is never scanned and the module is silently absent from the build, with no error
anywhere.

**Android is unimplemented**, which matches the state of the Android build: there is none.
`expo-module.config.json` declares `apple` only, so autolinking skips the module there and
`previewDocument` answers `false`, landing on the share sheet - the behaviour an Android build
would have wanted anyway until somebody writes the `Intent` half.
