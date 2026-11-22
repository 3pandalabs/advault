import { runOfferSwapSweep } from "../lib/offerSwap/sweep.js";

// "Change my offer" (lib/offerSwap): the swap sweep, in the renderer because
// it already holds the Google credentials and runs the YouTube queue, and the
// API would run it once per replica. Every step is idempotent at the row
// level (a status moves forward once), so a double run is harmless.
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
