import { useRef, useState } from "react";
import {
  useExtractReceipt,
  useLatestReceipt,
  useUploadReceipt,
} from "../api/hooks";
import DashboardCard from "../shared/ui/DashboardCard.tsx";
import ReceiptReview from "./ReceiptReview.tsx";
import { fmtIDR } from "../shared/format";

export default function ReceiptUpload() {
  const [file, setFile] = useState<File | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const upload = useUploadReceipt();
  const extract = useExtractReceipt();
  const latest = useLatestReceipt();
  // Post-delete flag: after deleting, show the upload/empty state even
  // if an older NEEDS_REVIEW row exists. Cleared on new file activity;
  // a browser refresh resets it, restoring latest-review persistence.
  const [cleared, setCleared] = useState(false);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!file) return;
    extract.reset();
    upload.mutate(file);
  };

  // In-session upload wins; otherwise the server's latest NEEDS_REVIEW
  // row is restored (survives refresh via query, never browser storage).
  const sessionId = extract.isSuccess ? extract.data.id : null;
  const reviewId = sessionId ?? (!cleared ? (latest.data?.receipt?.id ?? null) : null);

  return (
    <DashboardCard title="Upload Receipt" subtitle="Scan a receipt with AI">
      <form onSubmit={submit} className="space-y-3">
        <input
          ref={inputRef}
          type="file"
          accept="image/jpeg,image/png,image/webp"
          className="block w-full text-sm text-gray-600"
          onChange={(e) => {
            setFile(e.target.files?.[0] ?? null);
            setCleared(false);
            upload.reset();
            extract.reset();
          }}
        />
        {file && (
          <p className="text-sm text-gray-600">
            Selected: <span className="font-medium">{file.name}</span>
          </p>
        )}
        <button
          type="submit"
          disabled={!file || upload.isPending}
          className="w-full rounded bg-gray-900 px-3 py-2 text-sm text-white disabled:opacity-50"
        >
          {upload.isPending ? "Uploading…" : "Upload"}
        </button>
        {upload.isError && (
          <p className="text-sm text-red-600">
            {(upload.error as Error).message}
          </p>
        )}
        {upload.isSuccess && (
          <p className="text-sm text-green-700">
            Receipt uploaded successfully.
          </p>
        )}
        {upload.isSuccess && (
          <button
            type="button"
            disabled={extract.isPending}
            onClick={() => extract.mutate(upload.data.id)}
            className="w-full rounded border border-gray-900 px-3 py-2 text-sm disabled:opacity-50"
          >
            {extract.isPending ? "Extracting…" : "Extract with AI"}
          </button>
        )}
        {extract.isError && (
          <p className="text-sm text-red-600">
            {(extract.error as Error).message}
          </p>
        )}
        {extract.isSuccess && (
          <dl className="space-y-1 rounded bg-gray-50 p-3 text-sm">
            <div className="flex justify-between">
              <dt className="text-gray-500">Merchant</dt>
              <dd>{extract.data.extraction.merchant ?? "—"}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-gray-500">Amount</dt>
              <dd>
                {extract.data.extraction.amount === null
                  ? "—"
                  : `Rp${fmtIDR.format(extract.data.extraction.amount)}`}
              </dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-gray-500">Date</dt>
              <dd>{extract.data.extraction.date ?? "—"}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-gray-500">Type</dt>
              <dd>{extract.data.extraction.type ?? "—"}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-gray-500">Category</dt>
              <dd>{extract.data.extraction.category ?? "—"}</dd>
            </div>
          </dl>
        )}
        {latest.isError && (
          <p className="text-sm text-red-600">
            {(latest.error as Error).message}{" "}
            <button className="underline" onClick={() => latest.refetch()}>
              Retry
            </button>
          </p>
        )}
      </form>
      {/* Sibling of the upload form, never nested inside it: nested
          <form> is invalid HTML (the inner form is dropped by the parser),
          which used to route "Save review" to the upload submit instead
          of the review PUT. Same layout as StatementImport/ImportReview. */}
      {reviewId && (
        <div className="mt-3">
          <ReceiptReview
            key={reviewId}
            receiptId={reviewId}
            onDeleted={() => {
              setCleared(true);
              upload.reset();
              extract.reset();
            }}
            // A CONFIRMED receipt must not stay pinned as the review
            // target (same empty-state reset as delete): the dashboard
            // and transaction lists already show the new Transaction.
            onConfirmed={() => {
              setCleared(true);
              upload.reset();
              extract.reset();
            }}
          />
        </div>
      )}
    </DashboardCard>
  );
}
