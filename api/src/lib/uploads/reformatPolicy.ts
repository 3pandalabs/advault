// Pure rules for the other-shape copy of an owner upload (otherFormat.ts).

export type UploadAspect = "16:9" | "9:16";

export const REFORMAT_ENGINE = "reformat";

export function otherAspect(a: string): UploadAspect | null {
  return a === "16:9" ? "9:16" : a === "9:16" ? "16:9" : null;
}

/** Was this creative made by AdVault from the owner's other-shape video? */
export function isReformatCopy(renderInfo: unknown): boolean {
  return (renderInfo as { engine?: unknown } | null)?.engine === REFORMAT_ENGINE;
}
