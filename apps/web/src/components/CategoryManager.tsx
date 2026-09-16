import { useState } from "react";
import {
  useCategories,
  useCreateCategory,
  type CategoryType,
} from "../api/hooks";

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
    <section className="rounded border border-gray-200 bg-white p-4">
      <h2 className="text-base font-semibold">Categories</h2>

      {isPending && <p className="mt-2 text-sm text-gray-500">Loading…</p>}
      {isError && (
        <p className="mt-2 text-sm text-red-600">
          {(error as Error).message}{" "}
          <button className="underline" onClick={() => refetch()}>
            Retry
          </button>
        </p>
      )}
      {data && data.length === 0 && (
        <p className="mt-2 text-sm text-gray-500">
          No categories yet. Add one below.
        </p>
      )}
      {data && data.length > 0 && (
        <ul className="mt-2 divide-y divide-gray-100 text-sm">
          {data.map((c) => (
            <li key={c.id} className="flex justify-between py-1.5">
              <span>{c.name}</span>
              <span className="text-xs text-gray-500">{c.type}</span>
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
        <p className="mt-2 text-sm text-red-600">
          {(create.error as Error).message}
        </p>
      )}
    </section>
  );
}
