import { useState } from "react";
import {
  useCategories,
  useCreateTransaction,
  type TransactionType,
} from "../api/hooks";
import DashboardCard from "../shared/ui/DashboardCard.tsx";

const inputCls =
  "w-full rounded border border-gray-300 px-3 py-2 text-sm focus:border-ink focus:outline-none";
const today = () => new Date().toISOString().slice(0, 10);

export default function TransactionForm() {
  const [type, setType] = useState<TransactionType>("expense");
  const [amount, setAmount] = useState("");
  const [date, setDate] = useState(today());
  const [categoryId, setCategoryId] = useState("");
  const [note, setNote] = useState("");
  const [merchant, setMerchant] = useState("");

  const { data: categories } = useCategories();
  const create = useCreateTransaction();

  // Categories matching the type, "both" fits everywhere.
  const options = (categories ?? []).filter(
    (c) => c.type === type || c.type === "both",
  );

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const parsed = Number(amount);
    if (!Number.isInteger(parsed) || parsed <= 0 || !categoryId || !date)
      return;
    create.mutate(
      {
        type,
        amount: parsed,
        date,
        categoryId,
        ...(note.trim() ? { note: note.trim() } : {}),
        ...(merchant.trim() ? { merchant: merchant.trim() } : {}),
      },
      {
        onSuccess: () => {
          setAmount("");
          setNote("");
          setMerchant("");
          setCategoryId("");
          setDate(today());
        },
      },
    );
  };

  return (
    <DashboardCard title="New transaction" subtitle="Record income or expense">
      <form onSubmit={submit} className="space-y-3">
        <div className="flex gap-2">
          {(["expense", "income"] as const).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => {
                setType(t);
                setCategoryId("");
              }}
              className={`flex-1 rounded border px-3 py-2 text-sm capitalize ${
                type === t
                  ? "border-gray-900 bg-gray-900 text-white"
                  : "border-gray-300 text-gray-600"
              }`}
            >
              {t}
            </button>
          ))}
        </div>

        <input
          className={inputCls}
          inputMode="numeric"
          type="number"
          min={1}
          step={1}
          placeholder="Amount in Rupiah (whole units)"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
        />
        <div className="flex flex-col gap-2 sm:flex-row">
          <input
            className={inputCls}
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
          />
          <select
            className={inputCls}
            value={categoryId}
            onChange={(e) => setCategoryId(e.target.value)}
          >
            <option value="">Select category</option>
            {options.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </div>
        <input
          className={inputCls}
          placeholder="Merchant (optional)"
          value={merchant}
          maxLength={200}
          onChange={(e) => setMerchant(e.target.value)}
        />
        <input
          className={inputCls}
          placeholder="Note (optional)"
          value={note}
          maxLength={500}
          onChange={(e) => setNote(e.target.value)}
        />

        <button
          type="submit"
          disabled={create.isPending}
          className="w-full rounded bg-gray-900 px-3 py-2 text-sm text-white disabled:opacity-50"
        >
          {create.isPending ? "Saving…" : "Save transaction"}
        </button>
        {create.isError && (
          <p className="text-sm text-clay-ink">
            {(create.error as Error).message}
          </p>
        )}
        {create.isSuccess && (
          <p className="text-sm text-green-700">Saved.</p>
        )}
      </form>
    </DashboardCard>
  );
}
