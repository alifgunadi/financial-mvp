import { useState } from "react";
import {
  useCategories,
  useCreateCategory,
  type CategoryType,
} from "../api/hooks";
import DashboardCard from "./DashboardCard.tsx";

const inputCls =
  "w-full rounded border border-gray-300 px-3 py-2 text-sm focus:border-gray-500 focus:outline-none";

export default function CategoryManager() {
  const { data, isPending, isError, error, refetch } = useCategories();
  const create = useCreateCategory();
  const [name, setName] = useState("");
  const [type, setType] = useState<CategoryType>("expense");

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    create.mutate(
      { name: name.trim(), type },
      { onSuccess: () => setName("") },
    );
  };

  return (
    <DashboardCard title="Categories" subtitle="Labels for your transactions">
      {isPending && <p className="text-sm text-subtle">Loading…</p>}
      {isError && (
        <p className="text-sm text-clay-ink">
          {(error as Error).message}{" "}
          <button className="underline" onClick={() => refetch()}>
            Retry
          </button>
        </p>
      )}
      {data && data.length === 0 && (
        <p className="text-sm text-subtle">
          No categories yet. Add one below.
        </p>
      )}
      {data && data.length > 0 && (
        <ul className="divide-y divide-line text-sm">
          {data.map((c) => (
            <li key={c.id} className="flex justify-between py-1.5">
              <span>{c.name}</span>
              <span className="text-xs text-subtle">{c.type}</span>
            </li>
          ))}
        </ul>
      )}

      <form onSubmit={submit} className="mt-3 flex gap-2">
        <input
          className={inputCls}
          placeholder="New category"
          value={name}
          maxLength={100}
          onChange={(e) => setName(e.target.value)}
        />
        <select
          className="rounded border border-gray-300 px-2 py-2 text-sm"
          value={type}
          onChange={(e) => setType(e.target.value as CategoryType)}
        >
          <option value="expense">expense</option>
          <option value="income">income</option>
          <option value="both">both</option>
        </select>
        <button
          type="submit"
          disabled={create.isPending || !name.trim()}
          className="rounded bg-gray-900 px-3 py-2 text-sm text-white disabled:opacity-50"
        >
          Add
        </button>
      </form>
      {create.isError && (
        <p className="mt-2 text-sm text-clay-ink">
          {(create.error as Error).message}
        </p>
      )}
    </DashboardCard>
  );
}
