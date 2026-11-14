// Renders one template ad.
//
//   node remotion/render.mjs <jobDir> <out.mp4>
//
// <jobDir>/props.json holds the OfferAd props with asset paths RELATIVE to
// jobDir (photos, motion clips, voiceover). They are served from a throwaway
// HTTP server on 127.0.0.1 for the length of the render, because Remotion's
// browser cannot read the container's files directly.
//
// Uses the bundle prebuilt at image build time (remotion/build, `npm run
// bundle`); bundles on the fly when it is missing (local development).
// Exit code 0 = rendered; anything else and the worker falls back to the
// ffmpeg layout, so a template problem never costs a customer their ad.
import { createServer } from "node:http";
import { createReadStream, existsSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { renderMedia, selectComposition } from "@remotion/renderer";

const here = path.dirname(fileURLToPath(import.meta.url));
const [jobDir, out] = process.argv.slice(2);
if (!jobDir || !out) {
  console.error("usage: node render.mjs <jobDir> <out.mp4>");
  process.exit(2);
}

const TYPES = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp", ".mp4": "video/mp4", ".mp3": "audio/mpeg" };
const root = path.resolve(jobDir);

// Static server for the job's assets, with Range support for video seeking.
const server = createServer((req, res) => {
  const rel = decodeURIComponent((req.url ?? "/").split("?")[0]).replace(/^\/+/, "");
  const file = path.resolve(root, rel);
  if (!file.startsWith(root + path.sep) || !existsSync(file)) {
    res.writeHead(404).end();
    return;
  }
  const size = statSync(file).size;
  const type = TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream";
  const range = /bytes=(\d*)-(\d*)/.exec(req.headers.range ?? "");
  if (range) {
    const start = range[1] ? Number(range[1]) : 0;
    const end = range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
    res.writeHead(206, { "content-type": type, "accept-ranges": "bytes", "content-range": `bytes ${start}-${end}/${size}`, "content-length": end - start + 1 });
    createReadStream(file, { start, end }).pipe(res);
    return;
  }
  res.writeHead(200, { "content-type": type, "accept-ranges": "bytes", "content-length": size });
  createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}/`;

try {
  const props = JSON.parse(await readFile(path.join(root, "props.json"), "utf8"));
  const url = (p) => (p ? base + encodeURIComponent(p) : p);
  const inputProps = { ...props, photos: props.photos.map(url), voiceover: url(props.voiceover), portrait: url(props.portrait) };

  let serveUrl = process.env.REMOTION_SERVE_URL ?? path.join(here, "build");
  if (!existsSync(serveUrl)) {
    const { bundle } = await import("@remotion/bundler");
    serveUrl = await bundle({ entryPoint: path.join(here, "src", "index.ts") });
  }

  const composition = await selectComposition({ serveUrl, id: "OfferAd", inputProps });
  await renderMedia({
    serveUrl,
    composition,
    inputProps,
    codec: "h264",
    crf: 20,
    outputLocation: path.resolve(out),
    concurrency: Number(process.env.REMOTION_CONCURRENCY ?? 2),
    // A stuck frame should fail the job (and fall back), not hold the slot.
    timeoutInMilliseconds: 60_000,
    logLevel: "warn",
  });
  console.log(JSON.stringify({ ok: true, out }));
} finally {
  server.close();
}
