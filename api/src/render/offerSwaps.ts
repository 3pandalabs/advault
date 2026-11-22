import { runOfferSwapSweep } from "../lib/offerSwap/sweep.js";

// "Change my offer" (lib/offerSwap): the swap sweep, in the renderer because
// it already holds the Google credentials and runs the YouTube queue, and the
// API would run it once per replica. Since 2026-11-22 the renderer also
// advances a change the moment its cuts finish rendering / uploading
// (advanceOfferChangeForCreative); this sweep is the backstop. Steps are
// serialised per change and every status move is conditional on the status
// it was decided on, so the two never both act on one step.
const INTERVAL_MS = Number(process.env.OFFER_SWAP_SWEEP_INTERVAL_MS ?? 10 * 60 * 1000);

function log(msg: string, extra?: unknown): void {
  console.log(JSON.stringify({ job: "offer-swap", msg, extra: extra ?? undefined }));
}

export function startOfferSwapSweep(): void {
  const tick = () =>
    runOfferSwapSweep()
      .then((stats) => {
        if (Object.keys(stats).length) log("sweep complete", stats);
      })
      // Never throw out of the interval: it would take the renderer down.
      .catch((err) => log("sweep threw", String(err)));
  void tick();
  setInterval(tick, INTERVAL_MS).unref();
  log("offer swap sweep started", { intervalMs: INTERVAL_MS });
}
