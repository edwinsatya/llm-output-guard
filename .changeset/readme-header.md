---
"llm-output-guard": patch
---

Give the README a logo and a downloads badge, and correct the size claim.

The mark is the pitch as a picture: five blocks that vary in height and hue,
then four that are identical in all three, then the guard. It is
`assets/logo.svg`, 2.9 KB, and it is solid shapes rather than drawn lines for
one reason: an earlier stroked version was fine at 560px and turned to mush at
the 220px the README actually displays.

Two constraints shaped it, both worth writing down because the obvious version
of each is wrong:

- **It is referenced by absolute `raw.githubusercontent.com` URL, not a relative
  path.** GitHub resolves `./assets/logo.svg`; npmjs.com does not do so
  reliably, and the npm listing is the page most people see first.
- **It carries one palette rather than a `prefers-color-scheme` swap.** An SVG
  loaded through an `img` tag cannot be styled by the host page, and npm strips
  `style` elements out of README SVGs, so a theme swap would work on GitHub and
  silently fail on npm. All seven colours clear 3:1 against white *and* against
  `#0d1117` on their own, worst case 3.06.

That last point is why the mark does not use the playground's palette: `--accent`
`#10617a` measures 2.68 on a dark ground, and the dark `--fail` `#e08074`
measures 2.80 on white. Each is correct in a page that knows its own theme, and
this file never does.

Nothing in the mark carries an opacity, and that is a fix rather than a
preference: the blocks do not overlap, so the `0.9` it shipped with mid-draft
bought no blending while compositing the two lightest teals down to 2.55 and
2.88 on white, under the bar for no visible gain.

`assets/` stays outside the `files` allowlist, so the published tarball carries
the README and not the image it links to.

Two smaller fixes rode along:

- **`~3 KB gzipped` was wrong, and had been for a while.** Measured against
  `680ca66`, the whole entry was already 4,784 B min+gzip before this release,
  and `SCRIPT_MISMATCH` adds 523 B on top, so it now reads `~5 KB`. The number
  sits three lines above a badge that displays the real one, in a README whose
  credibility rests on claims being measured.
- **The size badge moved from bundlephobia to bundlejs.** Bundlephobia's API has
  been answering `429 rate limited by upstream service`, which renders as that
  text in place of a number. bundlejs reports the same figure and is up.
