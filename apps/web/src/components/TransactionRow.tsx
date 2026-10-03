import type { Transaction } from "../api/hooks";
import { fmtIDR } from "../shared/format";

export default function TransactionRow({ t }: { t: Transaction }) {
  const income = t.type === "income";
  return (
    <li className="flex items-center gap-3 py-3">
      <span
        aria-hidden="true"
        className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-sm font-bold ${
          income ? "bg-leaf/10 text-leaf-ink" : "bg-clay/10 text-clay-ink"
        }`}
      >
        {income ? "+" : "−"}
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">
          {t.category?.name ?? "Uncategorized"}
          <span className="ml-2 text-xs font-normal text-subtle">{t.date}</span>
        </p>
        {(t.merchant || t.note) && (
          <p className="truncate text-xs text-subtle">
            {[t.merchant, t.note].filter(Boolean).join(" — ")}
          </p>
        )}
      </div>
      <p
        className={`shrink-0 text-sm font-bold tabular-nums ${
          income ? "text-leaf-ink" : "text-clay-ink"
        }`}
      >
        {income ? "+" : "−"}Rp{fmtIDR.format(t.amount)}
      </p>
    </li>
  );
}
