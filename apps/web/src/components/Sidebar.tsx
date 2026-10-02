import type { ReactNode } from "react";
import { useLogout, type AuthUser } from "../api/hooks";

export interface NavItem {
  id: string;
  label: string;
  icon: (cls: string) => ReactNode;
}

function Icon({
  d,
  cls = "h-[18px] w-[18px]",
}: {
  d: string;
  cls?: string;
}) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={cls}
      aria-hidden="true"
    >
      <path d={d} />
    </svg>
  );
}

export const NAV_ITEMS: NavItem[] = [
  {
    id: "dashboard",
    label: "Dashboard",
    icon: (cls) => (
      <Icon
        cls={cls}
        d="M4 4h7v7H4zM13 4h7v4h-7zM13 11h7v9h-7zM4 14h7v6H4z"
      />
    ),
  },
  {
    id: "new-transaction",
    label: "New transaction",
    icon: (cls) => <Icon cls={cls} d="M12 5v14M5 12h14" />,
  },
  {
    id: "categories",
    label: "Categories",
    icon: (cls) => (
      <Icon
        cls={cls}
        d="M4 7V5a1 1 0 0 1 1-1h4l2 2h8a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1z"
      />
    ),
  },
  {
    id: "receipts",
    label: "Receipts",
    icon: (cls) => (
      <Icon
        cls={cls}
        d="M6 3h12v18l-2-1.5L14 21l-2-1.5L10 21l-2-1.5L6 21zM9 8h6M9 12h6"
      />
    ),
  },
  {
    id: "imports",
    label: "Statement Import",
    icon: (cls) => (
      <Icon cls={cls} d="M12 3v12m0 0l-4-4m4 4l4-4M4 21h16" />
    ),
  },
  {
    id: "history",
    label: "History",
    icon: (cls) => <Icon cls={cls} d="M4 6h16M4 12h16M4 18h10" />,
  },
];

function LogoutButton({ compact = false }: { compact?: boolean }) {
  const logout = useLogout();
  if (compact) {
    return (
      <button
        type="button"
        onClick={() => logout.mutate()}
        disabled={logout.isPending}
        aria-label="Logout"
        className="rounded-xl border border-line p-2 text-subtle transition-colors hover:bg-canvas hover:text-ink disabled:opacity-50"
      >
        <Icon d="M9 21H5a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h4M16 17l5-5-5-5M21 12H9" />
      </button>
    );
  }
  return (
    <button
      type="button"
      onClick={() => logout.mutate()}
      disabled={logout.isPending}
      className="flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-sm text-subtle transition-colors hover:bg-canvas hover:text-ink disabled:opacity-50"
    >
      <Icon d="M9 21H5a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h4M16 17l5-5-5-5M21 12H9" />
      {logout.isPending ? "Logging out…" : "Logout"}
    </button>
  );
}

export function Sidebar({
  user,
  active,
  onNav,
}: {
  user: AuthUser;
  active: string;
  onNav: (id: string) => void;
}) {
  return (
    <aside className="sticky top-0 hidden h-screen w-60 shrink-0 flex-col bg-surface px-4 py-6 lg:flex">
      <a
        href="#dashboard"
        onClick={() => onNav("dashboard")}
        className="px-2 text-[17px] font-bold tracking-tight"
      >
        Financial&nbsp;MVP
      </a>
      <nav aria-label="Primary" className="mt-8 flex-1 space-y-1">
        {NAV_ITEMS.map((item) => {
          const selected = active === item.id;
          return (
            <a
              key={item.id}
              href={`#${item.id}`}
              onClick={() => onNav(item.id)}
              aria-current={selected ? "page" : undefined}
              className={`flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm transition-colors ${
                selected
                  ? "bg-ink font-semibold text-white"
                  : "text-subtle hover:bg-canvas hover:text-ink"
              }`}
            >
              {item.icon("h-[18px] w-[18px] shrink-0")}
              {item.label}
            </a>
          );
        })}
      </nav>
      <div className="border-t border-line pt-4">
        <div className="flex min-w-0 items-center gap-3 px-1">
          <span
            aria-hidden="true"
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-sand text-sm font-bold text-ink"
          >
            {user.email.slice(0, 1).toUpperCase()}
          </span>
          <div className="min-w-0">
            <p className="truncate text-sm font-medium">{user.email}</p>
            <p className="text-xs capitalize text-subtle">{user.role.toLowerCase()}</p>
          </div>
        </div>
        <div className="mt-2">
          <LogoutButton />
        </div>
      </div>
    </aside>
  );
}

export function MobileBar({
  user,
  active,
  onNav,
}: {
  user: AuthUser;
  active: string;
  onNav: (id: string) => void;
}) {
  return (
    <div className="sticky top-0 z-10 border-b border-line bg-surface/95 backdrop-blur lg:hidden">
      <div className="flex items-center justify-between gap-3 px-4 py-3">
        <a
          href="#dashboard"
          onClick={() => onNav("dashboard")}
          className="text-[15px] font-bold tracking-tight"
        >
          Financial&nbsp;MVP
        </a>
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate text-xs text-subtle">{user.email}</span>
          <LogoutButton compact />
        </div>
      </div>
      <nav
        aria-label="Primary"
        className="flex gap-1 overflow-x-auto px-3 pb-2"
      >
        {NAV_ITEMS.map((item) => {
          const selected = active === item.id;
          return (
            <a
              key={item.id}
              href={`#${item.id}`}
              onClick={() => onNav(item.id)}
              aria-current={selected ? "page" : undefined}
              className={`shrink-0 rounded-lg px-3 py-1.5 text-[13px] transition-colors ${
                selected
                  ? "bg-ink font-semibold text-white"
                  : "text-subtle hover:bg-canvas hover:text-ink"
              }`}
            >
              {item.label}
            </a>
          );
        })}
      </nav>
    </div>
  );
}
