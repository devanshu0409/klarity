# Design System — Claude Brand (Klarity)

> Companion to `DESIGN.md` (the Mastercard-inspired exploration). This document
> replaces it as the active direction: a warm, editorial-but-utilitarian look
> borrowed from Anthropic/Claude's own product language, adapted for a dense
> desktop dev tool. Both light and dark themes are first-class — see §8 for
> how theming should be wired.

## 1. Visual theme & atmosphere

Klarity reads like a calm, warm-neutral developer tool rather than a cold
blue/gray IDE. The canvas is Ivory (`#FAF9F5`) in light mode and Slate
(`#141413`) in dark mode — never pure white or pure black. Content panels
(cards, tables, dialogs) sit one step lighter/darker than the canvas to
create depth without shadows. There is exactly one accent color — Clay
(`#D97757`) — used sparingly for the active nav item, selected rows, primary
buttons, and focus/selection states. Status is communicated with muted,
desaturated warm semantic colors (green/amber/red) rather than saturated
"alert" colors, so the accent still reads as the loudest thing on screen.

**Key characteristics:**
- Warm neutral canvas (Ivory/Slate) — never cool gray, never pure white/black
- A single accent (Clay) used for interactive state only — never decorative
- A persistent dark icon rail (Slate) on the left in *both* themes — it does
  not flip to light in light mode, which is what visually unifies the two
  themes as one product
- Serif display type for page/section titles only; sans for everything else;
  mono for all Kafka data (offsets, keys, partition ids, hex, config)
- Minimal borders (hairline, low-opacity, derived from the text color) —
  never colored borders for structural chrome
- Status badges are pill-shaped with a tinted background + matching border +
  matching text, at ~20% strength of the underlying hue

## 2. Color palette

### Primary (foundation)

| Token | Light | Dark | Use |
|---|---|---|---|
| Canvas | `#FAF9F5` (Ivory) | `#141413` (Slate) | Page background |
| Panel | `#FFFFFF` | `#1F1E1D` | Cards, tables, dialogs, topbar |
| Sunken panel | `#FAF9F5` | `#1A1918` | Toolbar strips, secondary panels |
| Rail | `#141413` (both) | `#0F0E0D` | Icon rail — always dark |
| Text primary | `#141413` | `#F5F4ED` | Body/headings |
| Text secondary | `#5E5D59` | `#B0AEA5` | Metadata, labels |
| Text tertiary | `#87867F` | `#87867F` | Placeholder, disabled |
| Text faint | `#B0AEA5` | `#5E5D59` | Empty states, hints |
| Border | `rgba(20,19,19,0.14)` | `rgba(245,244,237,0.12)` | All structural borders |
| Divider | `rgba(20,19,19,0.07)` | `rgba(245,244,237,0.06)` | Row/section separators |
| Placeholder bar | `#E8E6DC` | `#3D3D3A` | Skeleton/loading content |

### Accent

| Token | Hex | Use |
|---|---|---|
| Clay (light) | `#D97757` | Primary accent — buttons, active nav, selected rows, links |
| Clay (dark) | `#E2896B` | Same role, lightened for AA contrast on dark panels |
| Oat (light soft fill) | `#E3DACC` | Selected-row/chip-active background |
| Clay soft fill (dark) | `rgba(217,119,87,0.16)` | Selected-row/chip-active background |
| Clay text-on-soft | `#8A3F22` (light) / `#E8A588` (dark) | Text sitting on the soft accent fill |

**Rule: button text on Clay is always Slate (`#141413`), never white**, in both
themes — Clay's mid-lightness fails AA contrast against white text but passes
comfortably against near-black.

### Semantic (status)

| State | Text (light) | Bg (light) | Border (light) | Text (dark) | Bg (dark) | Border (dark) |
|---|---|---|---|---|---|---|
| Success | `#3F7A34` | `#EAF1E4` | `#C7D9BD` | `#7FB36B` | `rgba(85,138,66,.16)` | `rgba(85,138,66,.35)` |
| Warning | `#A9821F` | `#FBF3DC` | `#EDDFA9` | `#E0BB4A` | `rgba(201,168,45,.16)` | `rgba(201,168,45,.35)` |
| Danger | `#B23B2E` | `#FBEAE7` | `#EFC7BE` | `#E58A7A` | `rgba(191,74,61,.16)` | `rgba(191,74,61,.35)` |

Used for: connection status dots, consumer-group state chips, ISR health,
lag trend lines, read-only badges, destructive confirmations.

## 3. Typography

- **Sans** (UI, body, labels, buttons): `'Anthropic Sans', system-ui, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif`
- **Serif** (page titles, panel headings only — not body copy): `'Anthropic Serif', Georgia, 'Times New Roman', Times, serif`
- **Mono** (all Kafka data — offsets, keys, timestamps, hex, config values, IDs): `'Anthropic Mono', 'JetBrains Mono', 'SF Mono', Monaco, 'Courier New', monospace`

Font files are not bundled/licensed for this project — the fallback stacks
render in the actual app (Segoe UI on Windows, which is most of this user
base). Do not substitute Inter, Roboto, or Arial as the *primary* choice.

| Role | Family | Size | Weight |
|---|---|---|---|
| Screen title (topbar) | Serif | 16px | 500 |
| Dialog/panel heading | Serif | 14–18px | 500 |
| Section label (uppercase) | Sans | 10px | 600, +0.04em tracking |
| Body / field text | Sans | 12–13px | 400–600 |
| Data (offsets, keys, hex) | Mono | 11px | 400–700 |

Serif is used *only* for the small set of moments listed above — screen
titles, dialog headings, empty-state headlines. Everything data-dense
(tables, forms, badges) stays Sans/Mono. Do not use serif for buttons,
labels, or table content.

## 4. Component patterns

**Icon rail** (68px, fixed, always Slate/near-black): logo mark (white
rounded-square chip with a Clay inner dot) at top, then nav items each with
a small line-icon + 9px label underneath. Active item = solid Clay pill,
Slate icon/label on top of it. Inactive = `#87867F` (light theme rail) /
`#73726C` (dark theme rail) icon+label, no fill.

**Buttons**
- Primary: Clay fill, Slate text, no border-radius tricks — 6px radius, 700 weight
- Secondary: transparent/white fill, hairline border, secondary text color
- Destructive: solid danger-red fill, white/ivory text

**Chips / segmented controls**: hairline border, 5px radius. Active segment
= Clay fill with Slate text (segmented control) or Clay border + Clay text +
Oat/soft-clay fill (toggle chip like "Search / Peek / Live tail").

**Status badges**: pill (4px radius), semantic bg/border/text triplet from
§2, 10px text, 600 weight.

**Tables**: no vertical rules; 10px uppercase sans column headers in
tertiary text color; rows alternate panel/sunken-panel background only when
it aids scanning (message tables), otherwise flat; selected/active row =
Clay left border (3px) + Oat/soft-clay background.

**Dialogs / floating panels**: panel background, 10px radius, soft shadow
tinted with Clay at low opacity (`0 16px 40px rgba(217,119,87,.16)` light /
plain dark shadow), header strip in the soft-accent fill with serif title.

**Destructive confirmation** (type-to-confirm): whole footer strip takes the
danger bg/border tint; the confirm input and button both danger-colored;
button stays disabled until the typed value matches (implement client-side).

## 5. Layout principles

- 8px base spacing unit; common paddings 6/8/12/14/16/20/24px
- Icon rail: 68px fixed
- Left/detail panels: 252–420px depending on content density
- Topbar: 52px; status bar: 26px
- Border radius: 4–6px everywhere (never the oversized/pill radii from the
  Mastercard exploration — this is a dense tool, not a marketing page)
- A 3px accent gradient strip (Clay → gold, `linear-gradient(90deg, #D97757, #C9A82D)`
  in light / `#E2896B → #D9B94A` in dark) runs across the very top of the
  window as the one purely decorative brand touch

## 6. Depth & elevation

Flat by default — almost no shadows. Borders (hairline, derived from text
color at low opacity) separate regions, not elevation. The one exception is
a floating dialog (e.g. the serde "try it" panel), which gets a soft,
Clay-tinted shadow to lift it off the canvas.

## 7. Do's and don'ts

**Do**
- Use Ivory/Slate as canvas, never pure white/black backgrounds
- Keep Clay as the *only* accent hue in UI chrome — no secondary brand color
- Use serif only for titles/headings, never for data or buttons
- Keep the icon rail dark in both themes
- Derive borders from the text color at low opacity, not a fixed gray

**Don't**
- Don't use Inter/Roboto/Arial as the primary UI font
- Don't tint buttons white-on-Clay — always Slate text on Clay
- Don't introduce a second accent hue (no blue, no purple) — Clay carries
  every interactive/emphasis moment
- Don't round corners past ~8px — no pill buttons, no oversized radii
- Don't use saturated pure red/green/amber for status — use the muted
  semantic triplets in §2, which are calibrated to sit quietly next to Clay

## 8. Theming implementation notes (for Claude Code)

This app already has a light/dark requirement (`PLAN.md` §0/§2) and a
`styles/tokens.css` + `styles/globals.css` pair driving CSS custom
properties. Implementing this system means:

1. Replace the token values in `renderer/src/styles/tokens.css` with the
   hex/rgba values in §2 above, keyed the same way the Mastercard pass was
   (a `:root` block for light, `[data-theme="dark"]` or `prefers-color-scheme`
   block for dark) — don't invent new token names if the existing file
   already has a working structure, just swap values.
2. Add the three font stacks from §3 as CSS variables
   (`--font-sans`, `--font-serif`, `--font-mono`) and apply `--font-serif`
   only to the specific heading elements named in §3 — this is a targeted
   change, not a global font swap.
3. Every component under `renderer/src/components/` should resolve color
   through the tokens, per the existing convention noted in `PLAN.md`
   ("every component resolves color through those tokens") — same rule
   applies here, just pointed at new values.
4. Reference screenshots for all 5 screens (Browse, Clusters, Topic detail,
   Consumer groups, Produce) in both themes are in `design/wireframes/` next
   to this file.

## 9. Quick reference (for prompting an agent)

- Canvas: "Ivory `#FAF9F5` in light, Slate `#141413` in dark — never pure white/black"
- Accent: "Clay `#D97757`, the only accent color, Slate text on top of it"
- Rail: "68px icon rail, always dark Slate, active item is a solid Clay pill"
- Headings: "Anthropic Serif at 500 weight for screen/panel titles only"
- Data: "Anthropic Mono for every offset, key, timestamp, and hex value"
- Status: "muted semantic triplets (text/bg/border) from §2, never saturated alert colors"
- Radius: "4–6px everywhere, no pill shapes"
