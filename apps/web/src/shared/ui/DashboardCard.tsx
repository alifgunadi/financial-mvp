import type { ReactNode } from "react";

// Unified card shell: identical padding, radius, border, header hierarchy
// and full-height behavior for every dashboard widget. Bodies (metrics,
// charts, lists, forms) stay in their own components; only the shell and
// the title/subtitle header are standardized here.
export default function DashboardCard({
  title,
  subtitle,
  actionHeader,
  children,
  tone = "light",
}: {
  title: ReactNode;
  subtitle?: string;
  actionHeader?: ReactNode;
  children: ReactNode;
  tone?: "light" | "dark";
}) {
  const dark = tone === "dark";
  return (
    <div
      className={`flex h-full min-w-0 flex-col justify-between rounded-2xl border border-line p-6 shadow-sm transition-colors ${
        dark ? "bg-ink text-white" : "bg-surface text-ink"
      }`}
    >
      <div className="mb-4 flex items-center justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold tracking-tight">{title}</h3>
          {subtitle && (
            <p className={`mt-0.5 text-xs ${dark ? "text-white/60" : "text-subtle"}`}>
              {subtitle}
            </p>
          )}
        </div>
        {actionHeader}
      </div>
      <div className="flex flex-1 flex-col justify-center">{children}</div>
    </div>
  );
}
