"use client";

import { useEffect, useRef, useState } from "react";
import { assetDownloadUrl, listAssets, uploadAsset, type Asset } from "@/lib/api/browser";
import { Button } from "@/components/ui/button";

// Google requires a square logo (1:1, at least 128x128) on every Demand Gen
// video ad. Advertisers upload whatever they have — usually a wide wordmark or
// a phone photo — so the browser fits it onto a white 512x512 square before
// upload. Fitted, not cropped: cropping a wide wordmark cuts the name off.
const SIZE = 512;

async function toSquarePng(file: File): Promise<File> {
  const bitmap = await createImageBitmap(file);
  const canvas = document.createElement("canvas");
  canvas.width = SIZE;
  canvas.height = SIZE;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("canvas_unavailable");

  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, SIZE, SIZE);
  // 8% padding so the logo doesn't touch the edge of the round crops YouTube
  // sometimes applies.
  const inner = SIZE * 0.84;
  const scale = Math.min(inner / bitmap.width, inner / bitmap.height);
  const w = bitmap.width * scale;
  const h = bitmap.height * scale;
  ctx.drawImage(bitmap, (SIZE - w) / 2, (SIZE - h) / 2, w, h);
  bitmap.close();

  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
  if (!blob) throw new Error("encode_failed");
  return new File([blob], "logo.png", { type: "image/png" });
}

/** Shows the advertiser's current logo, or asks for one. Reports it upward. */
export function SquareLogo({ onChange }: { onChange: (logo: Asset | null) => void }) {
  const [logo, setLogo] = useState<Asset | null | undefined>(undefined);
  const [preview, setPreview] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    listAssets()
      .then((all) => {
        // Newest first from the API, so this is the logo launch will use.
        const found = all.find((a) => a.kind === "logo") ?? null;
        setLogo(found);
        onChange(found);
      })
      .catch(() => setLogo(null));
    // onChange is a state setter from the parent; it never changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!logo) return;
    assetDownloadUrl(logo.r2Key)
      .then(({ url }) => setPreview(url))
      .catch(() => undefined);
  }, [logo]);

  async function onFile(file: File | undefined) {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      const asset = await uploadAsset(await toSquarePng(file), "logo");
      setLogo(asset);
      onChange(asset);
    } catch {
      setError("That image could not be used. Try a PNG or JPEG.");
    } finally {
      setBusy(false);
      if (input.current) input.current.value = "";
    }
  }

  if (logo === undefined) return null;

  return (
    <div className="mt-4 flex items-center gap-4 rounded-lg border border-zinc-800 p-3">
      {logo && preview ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={preview} alt="Your logo" className="h-14 w-14 rounded bg-white object-contain" />
      ) : (
        <div className="flex h-14 w-14 items-center justify-center rounded border border-dashed border-zinc-700 text-xs text-zinc-500">
          Logo
        </div>
      )}
      <div className="flex-1 text-sm">
        <p className="text-zinc-200">{logo ? "Your logo" : "Add your logo"}</p>
        <p className="text-xs text-zinc-500">
          {logo
            ? "Shown beside your ad on YouTube."
            : "Google needs a logo on every YouTube ad. We fit it onto a square for you."}
        </p>
        {error && <p className="mt-1 text-xs text-red-300">{error}</p>}
      </div>
      <input
        ref={input}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        className="hidden"
        onChange={(e) => onFile(e.target.files?.[0])}
      />
      <Button variant="outline" disabled={busy} onClick={() => input.current?.click()}>
        {busy ? "Uploading…" : logo ? "Replace" : "Upload logo"}
      </Button>
    </div>
  );
}
