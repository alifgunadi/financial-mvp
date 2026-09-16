import type { Transaction } from "../api/hooks";

export const fmtIDR = new Intl.NumberFormat("id-ID");

export default function TransactionRow({ t }: { t: Transaction }) {
  return (
    <li className="flex items-center justify-between py-2.5">
      <div className="min-w-0">
        <p className="truncate text-sm font-medium">
          {t.category.name}
          <span className="ml-2 text-xs font-normal text-gray-500">
            {t.date}
          </span>
        </p>
        {(t.merchant || t.note) && (
          <p className="truncate text-xs text-gray-500">
            {[t.merchant, t.note].filter(Boolean).join(" — ")}
          </p>
        )}
      </div>
      <p
        className={`shrink-0 pl-4 text-sm font-semibold ${
          t.type === "income" ? "text-green-700" : "text-red-700"
        }`}
      >
        {t.type === "income" ? "+" : "−"}
        {fmtIDR.format(t.amount)}
      </p>
    </li>
  );
}
