// The org's three-blob blurred backdrop + dot grid, in the amber/violet
// register AdVault uses rather than RsvpVault's emerald. Copied from
// 3pandalabs/brand background/ per branding.md — not re-guessed.
export function GradientBackdrop() {
  return (
    <div aria-hidden className="pointer-events-none fixed inset-0 -z-10 overflow-hidden bg-zinc-950">
      <div className="absolute -top-40 -left-32 h-[32rem] w-[32rem] rounded-full bg-amber-500/20 blur-3xl" />
      <div className="absolute -top-24 right-[-10rem] h-[28rem] w-[28rem] rounded-full bg-violet-600/20 blur-3xl" />
      <div className="absolute bottom-[-14rem] left-1/3 h-[34rem] w-[34rem] rounded-full bg-amber-400/10 blur-3xl" />
      <div
        className="absolute inset-0 text-zinc-100 opacity-[0.04]"
        style={{
          backgroundImage: "radial-gradient(circle, currentColor 1px, transparent 1px)",
          backgroundSize: "24px 24px",
        }}
      />
    </div>
  );
}
