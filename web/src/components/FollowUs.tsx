// "Follow us" row for the footer, plus the public business phone. Icons are
// inline SVG in the footer's own text colour. An empty href hides the icon:
// fill Instagram in once the account is live.
const SOCIAL = [
  { label: "Facebook", href: "https://www.facebook.com/advaultads", d: "M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z" },
  { label: "Instagram", href: "", d: "M7.5 0h9A7.5 7.5 0 0 1 24 7.5v9a7.5 7.5 0 0 1-7.5 7.5h-9A7.5 7.5 0 0 1 0 16.5v-9A7.5 7.5 0 0 1 7.5 0zm0 2.2A5.3 5.3 0 0 0 2.2 7.5v9a5.3 5.3 0 0 0 5.3 5.3h9a5.3 5.3 0 0 0 5.3-5.3v-9a5.3 5.3 0 0 0-5.3-5.3zM12 5.8a6.2 6.2 0 1 1 0 12.4 6.2 6.2 0 0 1 0-12.4zm0 2.2a4 4 0 1 0 0 8 4 4 0 0 0 0-8zm6.4-3.8a1.4 1.4 0 1 1 0 2.8 1.4 1.4 0 0 1 0-2.8z" },
  { label: "YouTube", href: "https://www.youtube.com/@advaultads", d: "M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z" },
].filter((s) => s.href);

export function FollowUs({ className = "" }: { className?: string }) {
  return (
    <div className={`flex basis-full flex-wrap items-center gap-x-5 gap-y-2 pb-2 text-sm ${className}`}>
      <a href="tel:+13323168453" className="whitespace-nowrap hover:underline">
        +1 (332) 316-8453
      </a>
      <span className="flex items-center gap-3 sm:ml-auto">
        Follow us
        {SOCIAL.map((s) => (
          <a
            key={s.label}
            href={s.href}
            target="_blank"
            rel="noopener noreferrer"
            aria-label={s.label}
            title={s.label}
            className="p-1 hover:opacity-70"
          >
            <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" className="size-5">
              <path fillRule="evenodd" d={s.d} />
            </svg>
          </a>
        ))}
      </span>
    </div>
  );
}
