import { useState } from "react";
import {
  useCategories,
  useConfirmReceipt,
  useDeleteReceipt,
  useReceipt,
  type ReceiptDetail,
  type TransactionType,
} from "../api/hooks";
import { fmtIDR } from "../shared/format";

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
  const confirm = useConfirmReceipt(detail.id);
  // Local confirm step (no modal system exists in this app): Save only
  // validates and shows the read-only summary; Confirm carries the
  // payload in a single POST /confirm. Cancel returns to editing
  // without any request.
  const [mode, setMode] = useState<"editing" | "confirming">("editing");
  const ai = detail.aiOriginal;

  // Categories of the chosen type; "both" fits everywhere. When no type
  // is picked yet, offer all of the user's categories.
  const options = (categories ?? []).filter(
    (c) => !type || c.type === type || c.type === "both",
  );

  // Display name for the confirming summary (the id travels in the
  // Confirm payload).
  const categoryName =
    (categories ?? []).find((c) => c.id === categoryId)?.name ?? "—";

  const parseAmount = (): number | null => {
    const trimmed = amount.trim();
    if (trimmed === "") return null;
    const n = Number(trimmed);
    return Number.isInteger(n) && n > 0 ? n : null;
  };

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    setLocalError(null);
    // Local validation only: no request leaves the browser here. The
    // review payload travels with Confirm.
    if (parseAmount() === null) {
      setLocalError("Amount must be a positive whole number.");
      return;
    }
    if (date === "") {
      setLocalError("Date is required.");
      return;
    }
    if (type === "") {
      setLocalError("Type is required.");
      return;
    }
    if (categoryId === "") {
      setLocalError("Category is required.");
      return;
    }
    setMode("confirming");
  };

  const fireConfirm = () => {
    if (confirm.isPending) return;
    const parsedAmount = parseAmount();
    if (parsedAmount === null) return; // unreachable: validated on Save
    confirm.mutate(
      {
        amount: parsedAmount,
        date,
        merchant: merchant.trim() === "" ? null : merchant.trim(),
        type: type as TransactionType,
        categoryId,
      },
      { onSuccess: () => onConfirmed?.() },
    );
  };

  const cancelConfirm = () => {
    confirm.reset();
    setMode("editing");
  };

  return (
    <form onSubmit={submit} className="mt-3 space-y-3">
      {mode === "editing" ? (
        <>
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
            className="w-full rounded bg-gray-900 px-3 py-2 text-sm text-white disabled:opacity-50"
          >
            Save review
          </button>
          {localError && <p className="text-sm text-red-600">{localError}</p>}
        </>
      ) : (
        <div className="space-y-1 rounded bg-gray-50 p-3 text-sm">
          {(
            [
              ["Merchant", merchant.trim() === "" ? "—" : merchant.trim()],
              ["Amount", `Rp${fmtIDR.format(parseAmount() ?? 0)}`],
              ["Date", date],
              ["Type", type],
              ["Category", categoryName],
            ] as [string, string][]
          ).map(([label, value]) => (
            <div key={label} className="flex justify-between">
              <span className="text-gray-500">{label}</span>
              <span>{value}</span>
            </div>
          ))}
          <div className="flex gap-2 pt-2">
            <button
              type="button"
              disabled={confirm.isPending}
              onClick={fireConfirm}
              className="flex-1 rounded bg-gray-900 px-3 py-2 text-sm text-white disabled:opacity-50"
            >
              {confirm.isPending ? "Confirming…" : "Confirm"}
            </button>
            <button
              type="button"
              disabled={confirm.isPending}
              onClick={cancelConfirm}
              className="flex-1 rounded border border-gray-300 px-3 py-2 text-sm text-gray-600 disabled:opacity-50"
            >
              Cancel
            </button>
          </div>
          {confirm.isError && (
            <p className="text-sm text-red-600">
              {(confirm.error as Error).message}
            </p>
          )}
        </div>
      )}
    </form>
  );
}

export default function ReceiptReview({
  receiptId,
  onDeleted,
  onConfirmed,
}: {
  receiptId: string;
  onDeleted?: () => void;
  onConfirmed?: () => void;
}) {
  const { data, isPending, isError, error, refetch } = useReceipt(receiptId);
  const remove = useDeleteReceipt(receiptId);
  // Set once when Confirm creates the Transaction (see onConfirmed).
  // The component is keyed per receipt, so no reset is needed.
  const [confirmed, setConfirmed] = useState(false);
  const handleConfirmed = () => {
    setConfirmed(true);
    onConfirmed?.();
  };
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
          onConfirmed={handleConfirmed}
        />
      )}
      {data && data.status === "needs_review" && (
        <div className="mt-3 border-t border-gray-200 pt-3">
          <p className="text-xs text-gray-500">
            Save your review, then press Confirm to create the transaction.
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
