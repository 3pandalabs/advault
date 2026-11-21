"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

// One tab bar for every admin page, instead of "Page →" links in each page's
// intro line. Each page still does its own admin check; this is navigation only.
const TABS = [
  { href: "/dashboard/admin", label: "Ad performance" },
  { href: "/dashboard/admin/business", label: "Business" },
  { href: "/dashboard/admin/reviews", label: "Video reviews" },
  { href: "/dashboard/admin/reports", label: "Reports & wording" },
  { href: "/dashboard/admin/users", label: "Users & admins" },
] as const;

function isActive(pathname: string, href: string): boolean {
  if (href === "/dashboard/admin") return pathname === href || pathname === `${href}/`;
  return pathname === href || pathname.startsWith(`${href}/`);
}

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname() ?? "";
  return (
    <div>
      <nav aria-label="Admin sections" className="-mx-1 mb-6 overflow-x-auto border-b border-white/10">
        <ul className="flex min-w-max gap-1 px-1">
          {TABS.map((t) => {
            const active = isActive(pathname, t.href);
            return (
              <li key={t.href}>
                <Link
                  href={t.href}
                  aria-current={active ? "page" : undefined}
                  className={
                    active
                      ? "-mb-px block border-b-2 border-amber-400 px-3 py-2 text-sm font-medium text-amber-300"
                      : "-mb-px block border-b-2 border-transparent px-3 py-2 text-sm text-zinc-400 hover:border-white/20 hover:text-zinc-200"
                  }
                >
                  {t.label}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>
      {children}
    </div>
  );
}
