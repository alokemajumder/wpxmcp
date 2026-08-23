---
name: design
title: Designing a site that looks considered
description: Aesthetic guidance for producing distinctive, polished WordPress themes rather than generic ones.
keywords: design, aesthetic, style, colors, typography, layout, spacing, polish, ui, look
---

## Decide the character first

Before writing any CSS, commit to a direction in one sentence — "editorial and quiet", "technical and dense", "warm and hand-made". Every later decision refers back to it. The failure mode is a site with no opinion: system fonts, a blue button, evenly grey cards.

## Type

- **Two families at most.** One for headings, one for body — or one family across two weights, which is often better.
- **Set a real scale.** 1.25 or 1.333 between steps, not arbitrary pixel values. `clamp()` for headings so they respond without breakpoints.
- **Body copy: 16–19px, line-height 1.6–1.75, measure 60–75 characters.** A wide unconstrained paragraph is the most common readability failure on a WordPress site.
- Headings want tighter line-height (1.1–1.25) and often negative letter-spacing.

## Color

- **One dominant neutral, one accent.** The accent appears on interactive elements and almost nothing else.
- Derive greys from the ink color rather than pure `#666` — `color-mix(in srgb, var(--color-ink) 65%, var(--color-surface))` keeps the palette coherent.
- **Check contrast.** Body text needs 4.5:1 against its background; large text 3:1. This is not optional.
- Restraint reads as confidence. Three colors used precisely beats eight used decoratively.

## Space

- **Space is the design.** Generous vertical rhythm between sections (`clamp(3rem, 8vw, 6rem)`) does more for perceived quality than any effect.
- Use a consistent scale (4px or 8px base). Arbitrary margins are what make a layout feel unresolved.
- **Group by proximity.** Related items close, unrelated items far apart. Most "cluttered" layouts are just uniformly spaced.

## Detail that earns its place

- One considered detail beats five effects: a rule under headings, a distinctive link underline offset, a slightly asymmetric card layout.
- Transitions: 150–250ms, on `transform` and `opacity`. Never animate `width` or `top`.
- Shadows should be soft and large rather than tight and dark: `0 8px 24px rgb(0 0 0 / 0.06)`.
- Give images a consistent aspect ratio and `object-fit: cover`. Mixed ratios are the fastest way to look unfinished.

## Non-negotiables

1. **Responsive from the start.** Design the narrow layout first; the wide one is the easy case.
2. **Visible focus states.** Removing the focus ring without replacing it makes the site unusable by keyboard.
3. **Respect `prefers-reduced-motion`.**
4. **Test with real content.** A long title, a missing image, an eight-item menu, an empty archive. Designs collapse on the content nobody designed for.

## Where it lives

All of it belongs in `theme.css` as custom properties, referenced through Tailwind aliases. If a change means editing more than one file, the tokens are wrong.
