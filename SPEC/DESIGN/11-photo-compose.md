# Surface: photo compose

## Purpose

The step between choosing a photo and sending it: a look at the picture, a crop, and a caption.
Built 2026-08-15 from a reference the founder sent (Instagram's send sheet), reduced to the two
tools that earn their place here.

Before it existed, choosing a photo uploaded and posted it in the same breath. There was no moment
to see what you had picked, no way to take it back without deleting a message, and no way to say
anything about it - though the server had accepted a caption alongside a photo since Phase 0 and no
interface had ever offered one.

## Where it appears

Over chat, on both photo paths: **Photos** and **Camera**. Not on **Document** - there is nothing
to look at and nothing to crop, so the step would only ever be dismissed.

## Anatomy

| Part | What it is |
|---|---|
| Surface | Full-bleed `inverseSurface`, the same dark ground `PhotoViewer` uses |
| Close | A circular translucent button, top left. Backs out of the crop first, then out of the sheet |
| Title | "Send to `<conversation>`", centred. The conversation, never the app |
| Stage | The picture, fitted to its own proportions with a `radius.lg` corner |
| Crop | One tool, below the picture. The reference has three; two of them are not this product |
| Caption bar | A translucent pill field, "Add a caption...", with the composer's accent send disc |
| Crop footer | Replaces the caption bar while cropping: **Reset** and a filled **Done** |
| Frame | A draggable rectangle with thirds guides and four accent corner handles, shaded outside |

## Rules that must survive

1. **Nothing leaves the phone until send is pressed.** The upload moved here from the picker, so
   backing out costs no round trip and leaves no object for the nightly sweep. This is the rule
   that makes the sheet worth having rather than merely nice.

2. **The crop is stored as FRACTIONS of the picture, never as points on screen.** The drawn size
   changes whenever the layout does - and it does so on the very tap that confirms the crop,
   because the crop footer is a different height from the caption bar. Storing points shipped on
   2026-08-15 and produced three symptoms from one cause: the frame drew outside the photo, the
   shading around it vanished, and **the crop was discarded by the tap meant to apply it**, so the
   full picture posted. See `crop-rect.ts`.

3. **The phone chooses the rectangle; the server cuts the pixels.** Nothing on this surface imports
   a native module, and that is a rule rather than a convenience - see
   [`AGENTS.md`](../../AGENTS.md) failure modes 8 and 32, both of which this screen caused.

4. **The title names the conversation.** "Send to Binghamton Running Club", because the one thing a
   full-screen photo surface takes away is the context of where you are.

5. **The send control is the composer's disc, in the accent.** A photo being sent and a message
   being sent are the same act; two different buttons would say they are not.

6. **There is no "add another".** The reference puts one top-right. This app picks one photo at a
   time on purpose - multi-select would need the send outbox to model a batch, and a partially sent
   batch is a worse failure than sending twice. The corner is left empty rather than filled with
   something else, so the title stays centred on the screen.

7. **The crop is free-form and opens on the whole picture.** A chat photo is displayed at its own
   proportions, so a square would discard most of what was chosen - the rule
   [`07-media-pipeline`](../TECH/07-media-pipeline.md) states for avatars in reverse. A frame that
   opened inset would have cropped the picture before anybody asked it to.

8. **Cropping is a mode, and its footer replaces the caption bar rather than joining it.** A mode
   that leaves the exit from the mode it interrupts on screen is how somebody sends a photo while
   still adjusting it. **Done applies nothing** - it closes the mode. The rectangle travels with
   the send, so there is no spinner and nothing that can fail.

9. **The `@` list is the composer's own component**, not a second one. A caption offers exactly the
   people a message would, and a fix to either lands on both.

## States

| State | Treatment |
|---|---|
| Loading | A spinner on the stage while the picture is measured |
| Ready | Picture, Crop, caption bar, send disc |
| Cropped | The tool reads "Cropped" rather than "Crop", so the choice is visible without entering the mode |
| Cropping | Frame with thirds and four accent corner handles; shaded outside; Reset and Done |
| Mentioning | The `@` list rises above the caption bar, on the dark treatment |
| Unreadable picture | A line under the stage rather than a blank surface |

## Obligations it creates elsewhere

- The server applies the rectangle at `complete`, before dimensions are measured - see
  [`07-media-pipeline`](../TECH/07-media-pipeline.md), which owns what that owes.
- The caption is a real message body, so everything that applies to a body applies to it: the
  language filter, mention resolution, and the reply preview drawn from it.

## Accessibility

Every control is labelled by what it does rather than what it is: "Discard this photo", "Crop this
photo", "Finish cropping", "Send this photo". The crop handles are drag targets of 44pt around a
22pt drawn corner, so the thing you can hit is larger than the thing you can see.

## Rejected alternatives

**The OS editor** (`allowsEditing`). Free, and square-only on iOS, which is the one shape a chat
photo must not be forced into. It also fires inside the picker, so a Crop button on this sheet
could never have triggered it.

**Cropping on the device** with `expo-image-manipulator`. The obvious choice, and the reason this
screen has its own entry in the failure-mode list twice over. It also buys less than it looks:
the server decodes every upload anyway.

**Pinch-to-zoom cropping.** The gesture everybody knows, and it would have meant two more native
dependencies for a screen that needs one rectangle moved. A draggable frame answers "take this bit
of it" with the gesture layer React Native already ships.

**Uploading on pick and cropping afterwards.** Would have kept the old instant-send path intact,
and means every cancelled photo is already in the object store.
