import { Composition } from "remotion";
import { OfferAd, type OfferAdProps } from "./OfferAd";

const FPS = 30;

// One composition; size and length come from the props render.mjs passes.
const defaults: OfferAdProps = {
  shopName: "Bella Hair Studio",
  area: "",
  priceText: "$10 OFF",
  itemText: "YOUR FIRST CUT",
  validText: "THIS MONTH ONLY",
  benefits: ["Walk-ins welcome"],
  ctaLabel: "Book today",
  website: "bellahair.com",
  brandColor: "#8c1f5b",
  accentColor: "#ffc94a",
  photos: [],
  captions: [],
  durationSeconds: 15,
  width: 1080,
  height: 1920,
};

export const Root: React.FC = () => (
  <Composition
    id="OfferAd"
    component={OfferAd}
    fps={FPS}
    width={1080}
    height={1920}
    durationInFrames={15 * FPS}
    defaultProps={defaults}
    calculateMetadata={({ props }) => ({
      width: props.width,
      height: props.height,
      durationInFrames: Math.round(props.durationSeconds * FPS),
    })}
  />
);
