---
name: stash
description: A self-hosted torrent box you watch from. The interface is the dark warm room; the film is the light.
colors:
  ground: "#14110f"
  panel: "#1b1714"
  raised: "#241f1a"
  hair: "#3a312a"
  hair-strong: "#4d4238"
  hair-hover: "#5e5045"
  text: "#f3ece0"
  text-2: "#bcb09f"
  text-3: "#968a7a"
  amber: "#f0a33a"
  amber-hover: "#f6b65c"
  amber-ink: "#1f1406"
  ready: "#a9c79f"
  danger: "#ec7a6c"
  danger-ground: "#3a1d18"
  danger-text: "#ffd9d3"
typography:
  headline:
    fontFamily: "Hanken Grotesk Variable, ui-sans-serif, system-ui, sans-serif"
    fontSize: "1.75rem"
    fontWeight: 700
    lineHeight: 1.15
    letterSpacing: "-0.025em"
    fontFeature: '"ss01"'
  title:
    fontFamily: "Hanken Grotesk Variable, ui-sans-serif, system-ui, sans-serif"
    fontSize: "1.4375rem"
    fontWeight: 700
    letterSpacing: "-0.02em"
    fontFeature: '"ss01"'
  wordmark:
    fontFamily: "Hanken Grotesk Variable, ui-sans-serif, system-ui, sans-serif"
    fontSize: "1.1875rem"
    fontWeight: 700
    letterSpacing: "-0.02em"
    fontFeature: '"ss01"'
  body:
    fontFamily: "Hanken Grotesk Variable, ui-sans-serif, system-ui, sans-serif"
    fontSize: "1rem"
    fontWeight: 400
    lineHeight: 1.5
    fontFeature: '"ss01"'
  control:
    fontFamily: "Hanken Grotesk Variable, ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 500
    lineHeight: 1
    fontFeature: '"ss01"'
  body-sm:
    fontFamily: "Hanken Grotesk Variable, ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 400
    lineHeight: 1.5
    fontFeature: '"ss01"'
  label:
    fontFamily: "Hanken Grotesk Variable, ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.8125rem"
    fontWeight: 400
    fontFeature: '"ss01"'
rounded:
  sm: "6px"
  md: "10px"
  lg: "14px"
  pill: "999px"
spacing:
  "4": "4px"
  "8": "8px"
  "12": "12px"
  "16": "16px"
  "20": "20px"
  "24": "24px"
  "32": "32px"
  "48": "48px"
  "64": "64px"
components:
  button-primary:
    backgroundColor: "{colors.amber}"
    textColor: "{colors.amber-ink}"
    typography: "{typography.control}"
    rounded: "{rounded.md}"
    padding: "0 16px"
    height: "40px"
  button-primary-hover:
    backgroundColor: "{colors.amber-hover}"
  button-secondary:
    backgroundColor: "{colors.raised}"
    textColor: "{colors.text}"
    typography: "{typography.control}"
    rounded: "{rounded.md}"
    padding: "0 16px"
    height: "40px"
  button-quiet:
    backgroundColor: "transparent"
    textColor: "{colors.text-2}"
    rounded: "{rounded.md}"
    padding: "0 16px"
  button-quiet-hover:
    backgroundColor: "{colors.raised}"
    textColor: "{colors.text}"
  button-danger:
    backgroundColor: "transparent"
    textColor: "{colors.danger}"
    rounded: "{rounded.md}"
    padding: "0 16px"
  button-danger-hover:
    backgroundColor: "{colors.danger-ground}"
  button-sm:
    typography: "{typography.label}"
    padding: "0 12px"
    height: "32px"
  input:
    backgroundColor: "{colors.panel}"
    textColor: "{colors.text}"
    typography: "{typography.body-sm}"
    rounded: "{rounded.md}"
    padding: "0 14px"
    height: "40px"
  input-focus:
    backgroundColor: "{colors.raised}"
  nav-link:
    textColor: "{colors.text-2}"
    rounded: "{rounded.md}"
    padding: "0 12px"
    height: "44px"
  nav-link-active:
    backgroundColor: "{colors.raised}"
    textColor: "{colors.text}"
  nav-count:
    textColor: "{colors.amber}"
    typography: "{typography.label}"
    rounded: "{rounded.pill}"
    padding: "2px 8px"
  segmented-tabs:
    backgroundColor: "{colors.panel}"
    typography: "{typography.control}"
    rounded: "{rounded.md}"
    padding: "3px"
  segmented-tab-active:
    backgroundColor: "{colors.raised}"
    textColor: "{colors.text}"
    height: "34px"
  file-row:
    padding: "8px 12px"
    height: "60px"
  screen:
    backgroundColor: "#000000"
    rounded: "{rounded.lg}"
  banner-error:
    backgroundColor: "{colors.danger-ground}"
    textColor: "{colors.danger-text}"
    rounded: "{rounded.md}"
    padding: "12px 16px"
---

# Design System: stash

## Overview

**Creative North Star: "The Projection Booth"**

stash is a projection booth at night. The interface is the dark, warm room: near-black walls with a brown cast, hairline seams, off-white print-stock text. The film is the only real light. When something plays, its sampled colour washes the top of the room and the rail edge, and the player throws a soft spill of that colour around itself. A single tungsten amber lamp marks what to press, where focus is, and what is moving.

The system is dense and operational, not a poster wall. Files are a ruled list with a small warm swatch per row, transfers are rows with a reel that fills as they download, and the watch page gives the player the full width with an actions rail beside it. One workhorse sans with tabular figures carries everything. There is no display face, no artwork and no invented metadata; colour that stands in for a frame is a generated swatch, never a picture.

The room scales with the screen: a 224px rail on desktop collapses to an icon rail on tablets and a bottom tab bar on phones. At 1800px and wider (the living-room TV) the root type size rises to 19px, the content centres in a 1520px column and the focus ring thickens to 3px.

**Key Characteristics:**

- Warm near-black tonal layering (ground, panel, raised) separated by 1px hairlines.
- One amber lamp: primary action, focus, progress, the active count and the stash mark.
- Light comes from the film: a live `--screen` colour drives the room wash and the player spill.
- Reel rings, not bars, for download progress.
- One sans (Hanken Grotesk Variable, ss01) with tabular figures for every number.
- Status is always a word; colour and the reel only reinforce it.

## Colors

A brown-black room lit by one amber lamp and by whatever film is on the screen.

### Primary

- **Tungsten Amber** (amber): the booth's lamp. The primary button in each region (Add in the top bar, Play/Pause on the actions rail), the focus outline, caret, accent-color, text selection tint (38% mix), streaming status and its reel, the active-transfer count, and the stash mark. Hover lifts to **Warm Filament** (amber-hover). Text on amber is **Burnt Ink** (amber-ink), never white.

### Secondary

- **Projected Light** (`--screen`, runtime): not a fixed token. A registered `<color>` custom property, defaulting to `rgb(150 96 52)`, set from the average colour of the playing video sampled every 500ms (2s under reduced motion). It feeds the room wash, the rail-edge glow and the player spill, transitioning over 1.6s. The room keeps the last film's light after playback; only real frames change it.
- **Film-stock swatch** (`--sw`, runtime): a stable per-filename colour confined to a warm band, `hsl(12–49 42% 26–39%)`, used only on the 16:9 file-row frame until real thumbnails exist.

### Tertiary

- **Ready Sage** (ready): the "Ready" status dot and word, and the "Copied" confirmation, and the VPN-only network status and signal path.
- **Signal Coral** (danger): destructive outlines and text, error status. It sits on **Ember Ground** (danger-ground) in banners, the add-error toast and the inline delete confirm, with **Blush Text** (danger-text) for message copy.

### Neutral

- **Booth Wall** (ground): page background, rail (82% mix), top bar (94% mix), phone tab bar (92% mix).
- **Panel** (panel): inputs, selects, the segmented tab track.
- **Raised** (raised): secondary buttons, the hovered/active nav link, the pressed segmented tab, row hover (80% mix), focused input, skeletons.
- **Hairline** (hair): every structural divider: rail edge, top bar bottom, list rules, tab track and select borders.
- **Strong Hairline** (hair-strong): control borders (buttons, inputs, kbd hint) and the scrollbar thumb; **Hover Seam** (hair-hover) on button and input hover.
- **Print** (text): primary text. **Faded Print** (text-2): secondary text, cells, idle nav. **Dim Print** (text-3): meta lines, placeholders, sub-heads, paused/checking status.

### Named Rules

**The Tungsten Rule.** Amber is the lamp, not paint: it marks the primary action, focus, progress and live counts, and the stash mark. At most one amber button per region; never use amber for decoration, headings, dividers or container outlines.

**The Film Is The Light Rule.** The only colour allowed to tint the room is the film's own sampled light (`--screen`) or a file's warm swatch. Room washes mix it at low strength (22–30%) over the dark ground, never as solid fills; only the player's own spill runs stronger (up to 55%).

## Typography

**Display Font:** none.
**Body Font:** Hanken Grotesk Variable (with ui-sans-serif, system-ui, sans-serif), stylistic set ss01 on globally.

**Character:** A single humanist grotesk doing every job, from the 28px page titles to 13px meta lines. Hierarchy comes from weight (400/500/550/600/650/700) and the warm-grey text steps, not from a second family.

### Hierarchy

- **Headline** (700, 1.75rem, 1.15, -0.025em): page titles and the film title on Watch (which uses 1.2 line-height, -0.02em, balanced wrapping).
- **Title** (700, 1.4375rem, -0.02em): empty-state headings.
- **Wordmark** (700, 1.1875rem, -0.02em): the "stash" wordmark; the same 19px size carries the screen-note heading.
- **Body** (400, 1rem, 1.5): default text. Row titles at 550, transfer names at 600. Prose blocks cap at 44–56ch.
- **Control** (500, 0.875rem, 1): buttons, segmented tabs, selects.
- **Body-sm** (400, 0.875rem, 1.5): inputs, list cells, status words, page sub-heads, watch meta, transfer file links.
- **Label** (400, 0.8125rem): row meta, transfer meta, nav count (650), side notes, kbd hint. The format column is the only uppercase text (0.04em tracking) and it is data, not a label.

### Named Rules

**The Tabular Rule.** Every number that changes or lines up (sizes, percentages, counts, speeds) is set in tabular figures.

**The One Voice Rule.** No display face and no second family. Emphasis is weight and text step within the one sans.

## Layout

A two-column booth: a sticky full-height rail (224px) beside the main column, with a sticky 64px top bar holding search (max 520px, `/` shortcut) and the add-magnet form pushed right. Pages pad 28px 32px 64px; Watch uses a two-column grid of the player and a 300px actions rail with a 32px gap.

Spacing runs on a 4px base, mostly 8 / 12 / 16 / 20 / 32, with 48 and 64 for empty states and page bottoms. Lists are full-width ruled rows: the file row grid is 56px frame, flexible name, 132px format, 92px size, 168px status, with a 16px gap and a 60px minimum height.

Responsive behaviour:

- **≥1800px (TV):** root font 19px; page, watch and top bar share a centred 1520px column; file rows drop format and size columns so status sits next to the name (size moves into the meta line); focus ring 3px.
- **≤1180px:** format column drops; Watch stacks to one column and the actions rail becomes a wrapping row.
- **≤1023px:** rail narrows to 76px icons-only; the active count becomes a badge on the icon.
- **≤640px (phone):** rail hides, a fixed bottom tab bar (52px targets, safe-area aware) appears, the top bar wraps search and add to full width, page padding 20px 16px 96px, the actions rail becomes a two-column grid with the primary, notes and delete spanning both columns.

## Elevation & Depth

Depth is tonal first: ground, panel and raised steps separated by hairlines. Shadows are rare and soft, used for the pressed tab and the file swatch. The one strong depth effect is light, not shadow: the player throws a coloured spill from `--screen`, and a fixed radial wash (70% × 45% at 62% 0%) plus a rail-edge gradient tint the room at 0.55 opacity, rising to 1 on Watch.

### Shadow Vocabulary

- **Pressed tab** (`box-shadow: 0 1px 2px rgb(0 0 0 / 0.35)`): the selected segment in a segmented control.
- **Film frame** (`box-shadow: 0 2px 6px rgb(0 0 0 / 0.45)`): the 16:9 swatch in a file row.
- **Screen spill** (`box-shadow: 0 0 0 1px color-mix(in srgb, var(--screen) 28%, var(--hair)), 0 30px 90px -20px color-mix(in srgb, var(--screen) 55%, transparent), 0 0 160px 10px color-mix(in srgb, var(--screen) 22%, transparent)`): the player only.

### Named Rules

**The Light Not Lift Rule.** Panels, rows and buttons never float on drop shadows; small contact shadows belong only to the pressed tab and the swatch frame. Only the screen glows, and it glows in the film's colour.

## Shapes

Gently rounded rectangles throughout: 6px for focus rings and small links, 10px for buttons, inputs, nav links, banners and the tab track, 14px for the player. Pills (999px) only for the count badge; full circles for status dots, reels and the logo. File rows and transfer rows are square-cornered ruled bands, not cards. The recurring silhouette is the reel: an outer ring with a hub and three spoke holes, shared by the stash mark and the progress reels.

## Components

### Buttons

Calm, solid and legible from the sofa.

- **Shape:** gently rounded (10px), 40px minimum height, 16px horizontal padding, 8px icon gap, 18px Lucide icons.
- **Primary:** amber fill and border, burnt-ink text at weight 650; hover lifts to warm filament.
- **Secondary (default):** raised fill, strong-hairline border, print text; hover darkens to the hover seam border. Transitions 160ms on the ease-out curve.
- **Quiet:** transparent with faded-print text; hover takes the raised fill.
- **Danger:** transparent with a 45% coral border and coral text; hover and focus fill with ember ground. A solid coral variant confirms deletion.
- **Small:** 32px, 12px padding, label size. **Icon:** 40px square.
- **Focus:** a 2px amber outline at 2px offset (3px at TV sizes).

### Chips

- **Count badge:** amber at 18% mix behind amber text, pill-shaped, label size at 650, tabular figures. Only for live counts.
- **Status:** an 8px dot (or an 18px reel when streaming or paused) plus a word, coloured by state: sage ready, amber streaming, dim print paused/checking/not downloaded, coral error.

### Cards / Containers

- **Corner Style:** none for list rows; 10px for banners and the delete confirm; 14px for the player.
- **Background:** rows are transparent with raised hover; banners use ember ground.
- **Shadow Strategy:** see Elevation; containers are flat.
- **Border:** 1px hairline rules between rows; coral at 45–50% around error containers.
- **Internal Padding:** rows 8px 12px (transfers 14px 12px); banners 12px 16px.

### Inputs / Fields

- **Style:** panel fill, strong-hairline border, 10px radius, 40px tall, 14px padding, dim-print placeholder. Search carries a leading 18px icon and a trailing `/` key hint.
- **Focus:** the outline is replaced by an amber border and the field lifts to raised.
- **Hover:** border warms to the hover seam.
- **Select:** panel fill, hairline border, inline chevron in dim print, appearance none.

### Navigation

- **Rail:** wordmark with the reel mark at top, then 44px nav links (20px icon, 12px gap) in faded print. Hover and current page both take the raised fill and print text; the current page is not amber. The footer holds the network chip.
- **Network chip:** rail footer, 40px, hairline border, 10px radius. A shield icon (shield-off for "No VPN") with a 7px status dot at its lower right, then the word at label size in the status colour: sage "VPN only" (kill switch bound) or "VPN tunnel", coral "No VPN", dim "Stopped" (kill switch, no VPN), "Reconnecting" (VPN changed), "Restarting" (settings applied), coral "Restart failed" (stash could not restart itself), "Checking", "Unknown" (failed or stale check) and "Offline". Never shows an IP. In the icon rail only the icon and dot show; on phones there is no chip.
- **Segmented tabs:** a panel track with a 3px inset; the pressed tab is raised with the soft pressed shadow.
- **Phone:** a fixed bottom tab bar with stacked icon and label, 52px targets.

### Privacy page

Operate mode, top to bottom: page head; the **signal path**; the network panel; then ruled setting sections (Kill switch, Blocklist, Connections) and a right-aligned "Save and restart" primary button (the page's one amber button).

- **Signal path:** three hops in a row (stash · interface · Peers see), panel fill, hairline border, 10px radius, 19px/650 labels with label-size detail, joined by 2px links. Bound to a VPN: the interface and peer hops and links take sage at 45% border / 7% fill; exposed: coral the same way; blocked or reconnecting: muted, the second link dashed and the last hop's border dashed ("Peers see: Nothing"). At ≤760px the hops stack and the links turn vertical.
- **Choice cards (kill switch):** three radio cards in a row (one column ≤1180px), panel fill, strong hairline, 10px radius; the native radio uses amber accent-color; the checked card lifts to raised with a faded-print border. "Recommended" is a dim label, not a badge.
- **Switch:** 48×28 pill track. Off: raised track, faded knob. On: amber border, amber 30% track, amber knob (a control state, like focus).
- **Locked by env:** the control is disabled and a dim line names the variable.

### Network panel

The first block on Transfers (`#network`): a ruled band (hairlines above and below), not a card. A pill badge with the status word and dot, then the headline sentence at body size and weight 600 ("Peers see … stash's traffic leaves through utun4, which looks like a VPN tunnel."), then a dim label-size line with the check time and the kill-switch caveat. Details (disclosure) and Check again sit at the right. Details lists IPv4 and IPv6 as a two-column definition list. Wording is hedged: never "safe", never "your own IP".

### Reel

The signature progress mark. An SVG ring (3px stroke) whose rim fills clockwise from twelve o'clock as the transfer completes: the track is the current colour at 22%, the fill is the current colour with round caps, animating over 700ms. At 28px and up it shows a hub and three spoke holes at 70%. Sizes in use: 18px inline in status, 40px in transfer rows. It is a real `progressbar` with an accessible label.

### Screen

The player: 16:9, black, 14px radius, wearing the screen spill. When there is nothing to play, a centred note sits on a radial gradient of the projected light into black.

### File row frame

A 56px 16:9 swatch: the film-stock colour with a soft highlight at the top left, darkening to 40% black, a white 16px kind icon at 82% opacity, and the film-frame shadow.

## Do's and Don'ts

### Do:

- **Do** keep amber to the primary action per region, focus, progress, live counts and the stash mark (The Tungsten Rule).
- **Do** let the film tint the room through `--screen`, mixed at 22–30% in room washes (the player spill alone reaches 55%), and transition hue changes slowly (1.6s).
- **Do** show progress as a reel ring, and always pair status colour with a word.
- **Do** set every changing number in tabular figures.
- **Do** separate surfaces with 1px hairlines and the ground → panel → raised steps.
- **Do** scale for the TV at 1800px and up: 19px root type, a centred 1520px column, a 3px focus ring.
- **Do** use Lucide line icons as inline SVG at 16–20px.

### Don't:

- **Don't** add a second family or a display face; hierarchy is weight and text step in the one sans.
- **Don't** introduce a second UI accent. The only other hues are sage for ready, coral for danger, and the film's own light.
- **Don't** put white text on amber; use burnt ink.
- **Don't** invent artwork, posters or dates; a generated warm swatch is the only stand-in for a frame.
- **Don't** lift panels, rows or buttons on drop shadows; only the screen glows (The Light Not Lift Rule).
- **Don't** mark the current nav item in amber; it takes the raised fill.
