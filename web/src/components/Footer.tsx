// Exact copy from 3pandalabs/brand footer/ — do not reword. The company is a
// registered US LLC and this line is the attribution every org property
// carries.
export function Footer() {
  return (
    <footer className="border-t border-white/10 px-6 py-8">
      <div className="mx-auto flex w-full max-w-5xl flex-wrap items-center justify-between gap-2 text-sm text-zinc-500">
        <span>&copy; 3PandaLabs LLC &middot; Registered in USA. All rights reserved.</span>
        <a
          href="https://3pandalabs.com"
          target="_blank"
          rel="noopener noreferrer"
          className="hover:text-zinc-300 hover:underline"
        >
          3pandalabs.com
        </a>
      </div>
    </footer>
  );
}
