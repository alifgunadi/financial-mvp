import { useState } from "react";
import {
  useCategories,
  useTransactions,
  type TransactionFilter,
} from "../api/hooks";
import DashboardCard from "../shared/ui/DashboardCard.tsx";
import TransactionRow from "./TransactionRow.tsx";

export default function TransactionList() {
  const [filter, setFilter] = useState<TransactionFilter>({
    type: "",
    categoryId: "",
  });
  const { data, isPending, isError, error, refetch } = useTransactions(filter);
  const { data: categories } = useCategories();

  return (
    <DashboardCard
      title={`History${data ? ` (${data.total})` : ""}`}
      subtitle="All recorded transactions"
      actionHeader={
        <div className="flex shrink-0 gap-2">
          <select
            aria-label="Filter by type"
            className="rounded-lg border border-line bg-surface px-2 py-1.5 text-[13px]"
            value={filter.type}
            onChange={(e) =>
              setFilter((f) => ({
                ...f,
                type: e.target.value as TransactionFilter["type"],
              }))
            }
          >
            <option value="">all types</option>
            <option value="expense">expense</option>
            <option value="income">income</option>
          </select>
          <select
            aria-label="Filter by category"
            className="max-w-36 rounded-lg border border-line bg-surface px-2 py-1.5 text-[13px]"
            value={filter.categoryId}
            onChange={(e) =>
              setFilter((f) => ({ ...f, categoryId: e.target.value }))
            }
          >
            <option value="">all categories</option>
            {(categories ?? []).map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </div>
      }
    >
      {isPending && <p className="text-sm text-subtle">Loading…</p>}
      {isError && (
        <p className="text-sm text-clay-ink">
          {(error as Error).message}{" "}
          <button className="underline" onClick={() => refetch()}>
            Retry
          </button>
        </p>
      )}
      {data && data.data.length === 0 && (
        <p className="text-sm text-subtle">
          No transactions yet. Add your first one using the New transaction
          form.
        </p>
      )}
      {data && data.data.length > 0 && (
        <ul className="divide-y divide-line">
          {data.data.map((t) => (
            <TransactionRow key={t.id} t={t} />
          ))}
        </ul>
      )}
    </DashboardCard>
  );
}
