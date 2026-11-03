# Quire's mark

A quire is a gathering of sheets folded together. The mark is one: three sheets, each a Q with a
round window, stepping down to the right; the top one's square corner is turned over into its
window, which makes the Q's tail.

## Files

- `src/assets/app-icon.svg`: the app icon. `{{bg}}` and `{{ink}}` are filled from the active
  theme (`--bg-2` and `--accent`, see `src/lib/appIcon.ts`), so the Dock icon follows the theme.
- `src/assets/app-icon-small.svg`: the same at 16 to 32 px, where the pages beneath would be less
  than a pixel apart: the top sheet with its turned corner and the next sheet's corner beneath.
- `src/components/QuireMark.tsx`: the small cut at the size of text, in its colour, before the
  name in the top bar.
- `npm run icon` makes the bundled icons (`src-tauri/icons`) from both, in the neutral base palette.

## Colour

Always one ink, the theme's accent, on the theme's panel colour. The pages beneath are the ink at
70% and 45%, the turned-over corner at 45%; thin gaps in the ground's colour keep the sheets apart.
Nothing else: no outline, glow, gradient or second accent.

## Keep

- The corner square and inside the round body's reach. Rounded or pointed, it reads as a map pin
  or a speech bubble.
- The window open all the way through. Filled, the Q becomes a button.
- Room around it of at least half the window's width.
- The full mark from 48 px up; below that, the small cut.

## The name

In the top bar the small cut is the name's Q: `UIRE` follows in the theme's display face, the mark a
capital's height on the baseline, in the name's colour, glow and letter spacing. In running text it
is Quire.
