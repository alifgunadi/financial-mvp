import { useState } from "react";
import {
  useCategories,
  useTransactions,
  type TransactionFilter,
} from "../api/hooks";
import TransactionRow from "./TransactionRow.tsx";

export default function TransactionList() {
  const [filter, setFilter] = useState<TransactionFilter>({
    type: "",
    categoryId: "",
  });
  const { data, isPending, isError, error, refetch } = useTransactions(filter);
  const { data: categories } = useCategories();

  return (
    <section className="rounded border border-gray-200 bg-white p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-base font-semibold">
          History{data ? ` (${data.total})` : ""}
        </h2>
        <div className="flex gap-2">
          <select
            className="rounded border border-gray-300 px-2 py-1.5 text-sm"
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
            className="rounded border border-gray-300 px-2 py-1.5 text-sm"
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
      </div>

      {isPending && <p className="mt-3 text-sm text-gray-500">Loading…</p>}
      {isError && (
        <p className="mt-3 text-sm text-red-600">
          {(error as Error).message}{" "}
          <button className="underline" onClick={() => refetch()}>
            Retry
          </button>
        </p>
      )}
      {data && data.data.length === 0 && (
        <p className="mt-3 text-sm text-gray-500">
          No transactions yet. Add your first one on the left.
        </p>
      )}
      {data && data.data.length > 0 && (
        <ul className="mt-2 divide-y divide-gray-100">
          {data.data.map((t) => (
            <TransactionRow key={t.id} t={t} />
          ))}
        </ul>
      )}
    </section>
  );
}
