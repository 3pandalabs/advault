# Template ad (Remotion)

The look of the home-page demo ads, rendered inside `advault-renderer`. Ported
from `advault-creative-lab/src/OfferAd.tsx` on 2026-11-13.

- `src/OfferAd.tsx`: the composition. Hook with the offer sticker, the
  business photos and motion clips, word-by-word captions, end card.
- `render.mjs`: `node remotion/render.mjs <jobDir> <out.mp4>`. Reads
  `<jobDir>/props.json` (written by `src/render/template.ts`) and serves the
  job's files to the browser from a throwaway server on 127.0.0.1.
- Own `package.json`, so Remotion and Chrome are installed only in the
  renderer image (`Dockerfile.renderer`, `template` stage: `npm ci`,
  `npm run bundle`, `npx remotion browser ensure`).

On only when `RENDER_ENGINE=template` on `advault-renderer`. Any failure, and
the worker renders the old ffmpeg layout instead, so the template never costs
a customer their ad.

Local test: `npm install`, put photos/clips/voice and a `props.json` in a
folder, then `node render.mjs <folder> out.mp4` (first run downloads Chrome).
`npm run studio` previews with the default props in `src/Root.tsx`.

Remotion's licence is free for companies of up to 3 people; past that it
needs a company licence (remotion.pro).
