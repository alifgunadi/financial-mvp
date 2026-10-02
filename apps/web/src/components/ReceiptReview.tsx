import { useState } from "react";
import {
  useCategories,
  useDeleteReceipt,
  useReceipt,
  useUpdateReceipt,
  type ReceiptDetail,
  type TransactionType,
} from "../api/hooks";
import { fmtIDR } from "./TransactionRow.tsx";

const inputCls =
  "w-full rounded border border-gray-300 px-3 py-2 text-sm focus:border-gray-500 focus:outline-none";
const aiCls = "text-xs text-gray-500";

function aiAmount(v: number | null | undefined): string {
  return v === null || v === undefined ? "—" : `Rp${fmtIDR.format(v)}`;
}

function aiStr(v: string | null | undefined): string {
  return v === null || v === undefined || v === "" ? "—" : v;
}

function ReviewForm({
  detail,
  onConfirmed,
}: {
  detail: ReceiptDetail;
  onConfirmed?: () => void;
}) {
  const [merchant, setMerchant] = useState(detail.extraction.merchant ?? "");
  const [amount, setAmount] = useState(
    detail.extraction.amount === null ? "" : String(detail.extraction.amount),
  );
  const [date, setDate] = useState(detail.extraction.date ?? "");
  const [type, setType] = useState<TransactionType | "">(
    detail.extraction.type ?? "",
  );
  const [categoryId, setCategoryId] = useState(
    detail.suggestedCategory?.id ?? "",
  );
  const [localError, setLocalError] = useState<string | null>(null);

  const { data: categories } = useCategories();
  const save = useUpdateReceipt(detail.id);
  const ai = detail.aiOriginal;

  // Categories of the chosen type; "both" fits everywhere. When no type
  // is picked yet, offer all of the user's categories.
  const options = (categories ?? []).filter(
    (c) => !type || c.type === type || c.type === "both",
  );

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    setLocalError(null);
    const trimmedAmount = amount.trim();
    let parsedAmount: number | null = null;
    if (trimmedAmount !== "") {
      const n = Number(trimmedAmount);
      if (!Number.isInteger(n) || n <= 0) {
        setLocalError("Amount must be a positive whole number.");
        return;
      }
      parsedAmount = n;
    }
    save.mutate(
      {
        amount: parsedAmount,
        date: date === "" ? null : date,
        merchant: merchant.trim() === "" ? null : merchant.trim(),
        type: type === "" ? null : type,
        categoryId: categoryId === "" ? null : categoryId,
      },
      {
        // Save-and-confirm: the backend creates the Transaction when the
        // stored review is complete and reports it in the response.
        onSuccess: (data) => {
          if (data.transaction) onConfirmed?.();
        },
      },
    );
  };

  return (
    <form onSubmit={submit} className="mt-3 space-y-3">
      <div>
        <label htmlFor={`rr-merchant-${detail.id}`} className="text-sm font-medium">
          Merchant
        </label>
        {ai && <p className={aiCls}>AI: {aiStr(ai.merchant)}</p>}
        <input
          id={`rr-merchant-${detail.id}`}
          className={inputCls}
          placeholder="Merchant"
          value={merchant}
          maxLength={200}
          onChange={(e) => setMerchant(e.target.value)}
        />
      </div>

      <div>
        <label htmlFor={`rr-amount-${detail.id}`} className="text-sm font-medium">
          Amount (Rp)
        </label>
        {ai && <p className={aiCls}>AI: {aiAmount(ai.amount)}</p>}
        <input
          id={`rr-amount-${detail.id}`}
          className={inputCls}
          inputMode="numeric"
          placeholder="Amount in Rupiah (whole units)"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
        />
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div>
          <label htmlFor={`rr-date-${detail.id}`} className="text-sm font-medium">
            Date
          </label>
          {ai && <p className={aiCls}>AI: {aiStr(ai.date)}</p>}
          <input
            id={`rr-date-${detail.id}`}
            className={inputCls}
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
          />
        </div>
        <div>
          <label htmlFor={`rr-type-${detail.id}`} className="text-sm font-medium">
            Type
          </label>
          {ai && <p className={aiCls}>AI: {aiStr(ai.type)}</p>}
          <select
            id={`rr-type-${detail.id}`}
            className={inputCls}
            value={type}
            onChange={(e) => {
              const next = e.target.value as TransactionType | "";
              setType(next);
              // Preserve a still-compatible selection: only clear the
              // chosen category when it no longer fits the new type.
              // Unconditional reset silently wiped valid selections,
              // which then saved as null and kept Confirm disabled.
              setCategoryId((prev) => {
                if (prev === "") return prev;
                const kept = (categories ?? []).find((c) => c.id === prev);
                if (
                  kept &&
                  (next === "" || kept.type === next || kept.type === "both")
                )
                  return prev;
                return "";
              });
            }}
          >
            <option value="">Unset</option>
            <option value="expense">Expense</option>
            <option value="income">Income</option>
          </select>
        </div>
      </div>

      <div>
        <label htmlFor={`rr-category-${detail.id}`} className="text-sm font-medium">
          Category
        </label>
        {ai && <p className={aiCls}>AI suggestion: {aiStr(ai.category)}</p>}
        <select
          id={`rr-category-${detail.id}`}
          className={inputCls}
          value={categoryId}
          onChange={(e) => setCategoryId(e.target.value)}
        >
          <option value="">No category</option>
          {options.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </div>

      <button
        type="submit"
        disabled={save.isPending}
        className="w-full rounded bg-gray-900 px-3 py-2 text-sm text-white disabled:opacity-50"
      >
        {save.isPending ? "Saving…" : "Save review"}
      </button>
      {localError && <p className="text-sm text-red-600">{localError}</p>}
      {save.isError && (
        <p className="text-sm text-red-600">{(save.error as Error).message}</p>
      )}
      {save.isSuccess && (
        <p className="text-sm text-green-700">Review saved.</p>
      )}
    </form>
  );
}

export default function ReceiptReview({
  receiptId,
  onDeleted,
}: {
  receiptId: string;
  onDeleted?: () => void;
}) {
  const { data, isPending, isError, error, refetch } = useReceipt(receiptId);
  const remove = useDeleteReceipt(receiptId);
  // Set once when a save also creates the Transaction (see onConfirmed).
  // The component is keyed per receipt, so no reset is needed.
  const [confirmed, setConfirmed] = useState(false);
  // Inline two-step delete (no modal system exists in this app): Delete
  // arms the confirmation, Confirm delete fires once (disabled pending).
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  return (
    <div className="mt-3 rounded border border-gray-200 p-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold">Review AI candidate</h3>
        {data && (
          <span className="text-xs text-gray-500">Status: {data.status}</span>
        )}
      </div>

      {isPending && <p className="mt-2 text-sm text-gray-500">Loading…</p>}
      {isError && (
        <p className="mt-2 text-sm text-red-600">
          {(error as Error).message}{" "}
          <button className="underline" onClick={() => refetch()}>
            Retry
          </button>
        </p>
      )}
      {data && data.status !== "needs_review" && !confirmed && (
        <p className="mt-2 text-sm text-gray-600">
          This receipt is not ready for review.
        </p>
      )}
      {/* Mount once per extraction: reviewed values persist server-side,
          the form keeps the user's in-progress edits. */}
      {data && data.status === "needs_review" && (
        <ReviewForm
          key={data.extractedAt ?? data.id}
          detail={data}
          onConfirmed={() => setConfirmed(true)}
        />
      )}
      {data && data.status === "needs_review" && (
        <div className="mt-3 border-t border-gray-200 pt-3">
          <p className="text-xs text-gray-500">
            Saving a complete review creates the transaction.
          </p>
          {!confirmingDelete ? (
            <button
              type="button"
              onClick={() => setConfirmingDelete(true)}
              className="mt-2 w-full rounded border border-gray-300 px-3 py-2 text-sm text-gray-600 disabled:opacity-50"
            >
              Delete
            </button>
          ) : (
            <div className="mt-2 flex gap-2">
              <button
                type="button"
                disabled={remove.isPending}
                onClick={() =>
                  remove.mutate(undefined, { onSuccess: () => onDeleted?.() })
                }
                className="flex-1 rounded bg-gray-900 px-3 py-2 text-sm text-white disabled:opacity-50"
              >
                {remove.isPending ? "Deleting…" : "Confirm delete"}
              </button>
              <button
                type="button"
                disabled={remove.isPending}
                onClick={() => setConfirmingDelete(false)}
                className="flex-1 rounded border border-gray-300 px-3 py-2 text-sm text-gray-600 disabled:opacity-50"
              >
                Cancel
              </button>
            </div>
          )}
          {remove.isError && (
            <p className="mt-2 text-sm text-red-600">
              {(remove.error as Error).message}
            </p>
          )}
        </div>
      )}
      {confirmed && (
        <p className="mt-2 text-sm text-green-700">
          Transaction created successfully.
        </p>
      )}
    </div>
  );
}
