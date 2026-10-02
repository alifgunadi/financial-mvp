import { useRef, useState } from "react";
import { ApiError } from "../api/client";
import {
  useCategories,
  useConfirmImport,
  useImportPreview,
  useUploadStatement,
  type ImportCandidate,
} from "../api/hooks";
import DashboardCard from "./DashboardCard.tsx";
import { fmtIDR } from "./TransactionRow.tsx";

const inputCls =
  "w-full rounded border border-gray-300 px-3 py-2 text-sm focus:border-gray-500 focus:outline-none";

// Backend disposition is the lowercase CandidateDisposition
// (see bluSemantic.ts + toApi in the preview handler).
function isReady(c: ImportCandidate): boolean {
  return c.disposition === "ready";
}

function dispositionLabel(disposition: string): string {
  switch (disposition) {
    case "skipped_internal_transfer":
      return "Skipped: possible internal transfer";
    case "blocked_fractional":
      return "Blocked: fractional amount";
    case "blocked_unreconciled":
      return "Blocked: unreconciled pocket";
    case "ready":
      return "Ready";
    default:
      return disposition;
  }
}

function CandidateCard({
  candidate,
  categoryId,
  onCategory,
  categories,
}: {
  candidate: ImportCandidate;
  categoryId: string;
  onCategory: (categoryId: string) => void;
  categories: { id: string; name: string; type: string }[];
}) {
  const income = candidate.type === "income";
  // Same ownership/type rule as the manual form: the candidate type,
  // or "both" which fits everywhere. No default: the user must choose.
  const options = categories.filter(
    (c) => c.type === candidate.type || c.type === "both",
  );
  return (
    <li className="min-w-0 rounded-xl border border-line p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">
            {candidate.note || (
              <span className="font-normal text-subtle">No description</span>
            )}
          </p>
          <p className="mt-0.5 truncate text-xs text-subtle">
            {candidate.date} · {candidate.pocket} ·{" "}
            <span className="capitalize">{candidate.type}</span>
          </p>
        </div>
        <p
          className={`shrink-0 text-sm font-bold tabular-nums ${
            income ? "text-leaf-ink" : "text-clay-ink"
          }`}
        >
          {income ? "+" : "−"}Rp{fmtIDR.format(candidate.amount)}
        </p>
      </div>
      <select
        aria-label="Category"
        className={`${inputCls} mt-3`}
        value={categoryId}
        onChange={(e) => onCategory(e.target.value)}
      >
        <option value="">Select category</option>
        {options.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}
          </option>
        ))}
      </select>
    </li>
  );
}

// Review view is keyed by import id from the parent, so assignments
// always start empty for a new batch (never carried over).
function ImportReview({ importId }: { importId: string }) {
  const preview = useImportPreview(importId);
  const confirm = useConfirmImport(importId);
  const { data: categories } = useCategories();
  // Draft review state: fingerprint → chosen categoryId. Fingerprint is
  // the only candidate identity (rowIndex is per-pocket, not unique).
  const [assignments, setAssignments] = useState<Record<string, string>>({});

  const candidates = preview.data?.candidates ?? [];
  const ready = candidates.filter(isReady);
  const categorized = ready.filter((c) => assignments[c.fingerprint]);
  const remaining = ready.length - categorized.length;
  const canConfirm =
    ready.length > 0 && remaining === 0 && !confirm.isPending;

  const submitConfirm = (e: React.FormEvent) => {
    e.preventDefault();
    if (!canConfirm) return;
    // Exact-set: every READY candidate, fingerprint + categoryId only.
    // The backend re-parses the PDF itself for the rest.
    confirm.mutate(
      ready.map((c) => ({
        fingerprint: c.fingerprint,
        categoryId: assignments[c.fingerprint],
      })),
    );
  };

  return (
    <div className="mt-6">
      {preview.isPending && (
        <p className="text-sm text-subtle">Loading…</p>
      )}
      {preview.isError && (
        <p className="text-sm text-clay-ink">
          {(preview.error as Error).message}{" "}
          <button className="underline" onClick={() => preview.refetch()}>
            Retry
          </button>
        </p>
      )}
      {preview.data && (
        <div className="space-y-6">
          <DashboardCard
            title="Statement preview"
            subtitle={`${preview.data.batch.originalName} · ${preview.data.bank}`}
          >
            <dl className="grid grid-cols-1 gap-2 text-sm sm:grid-cols-2">
              <div className="flex justify-between gap-3">
                <dt className="text-subtle">Bank</dt>
                <dd className="truncate font-medium">{preview.data.bank}</dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-subtle">Period</dt>
                <dd className="truncate font-medium">
                  {preview.data.statementPeriod
                    ? `${preview.data.statementPeriod.from} → ${preview.data.statementPeriod.to}`
                    : "—"}
                </dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-subtle">Status</dt>
                <dd className="truncate font-medium">
                  {preview.data.batch.status}
                </dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-subtle">Detected</dt>
                <dd className="truncate font-medium">
                  {preview.data.detected.isBlu ? "Yes" : "No"}
                </dd>
              </div>
            </dl>
          </DashboardCard>

          <DashboardCard title="Summary" subtitle="Parsed candidates">
            <dl className="grid grid-cols-1 gap-2 text-sm sm:grid-cols-2">
              <div className="flex justify-between gap-3">
                <dt className="text-subtle">Total</dt>
                <dd className="font-medium tabular-nums">
                  {preview.data.summary.total}
                </dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-subtle">Ready</dt>
                <dd className="font-medium tabular-nums">
                  {preview.data.summary.ready}
                </dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-subtle">Internal transfer</dt>
                <dd className="font-medium tabular-nums">
                  {preview.data.summary.skippedInternalTransfer}
                </dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-subtle">Fractional</dt>
                <dd className="font-medium tabular-nums">
                  {preview.data.summary.blockedFractional}
                </dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-subtle">Unreconciled</dt>
                <dd className="font-medium tabular-nums">
                  {preview.data.summary.blockedUnreconciled}
                </dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-subtle">Ready income</dt>
                <dd className="font-medium tabular-nums">
                  Rp{fmtIDR.format(preview.data.summary.readyIncome)}
                </dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-subtle">Ready expense</dt>
                <dd className="font-medium tabular-nums">
                  Rp{fmtIDR.format(preview.data.summary.readyExpense)}
                </dd>
              </div>
            </dl>
          </DashboardCard>

          <DashboardCard
            title={`Candidate review${ready.length ? ` (${ready.length})` : ""}`}
            subtitle={
              ready.length === 0
                ? "No importable candidates in this statement."
                : `${categorized.length} of ${ready.length} candidates categorized`
            }
          >
            {candidates.length === 0 ? (
              <p className="text-sm text-subtle">
                No candidates found in this statement.
              </p>
            ) : (
              <form onSubmit={submitConfirm} className="space-y-3">
                <ul className="space-y-3">
                  {ready.map((c) => (
                    <CandidateCard
                      key={c.fingerprint}
                      candidate={c}
                      categoryId={assignments[c.fingerprint] ?? ""}
                      categories={categories ?? []}
                      onCategory={(categoryId) =>
                        setAssignments((a) => ({
                          ...a,
                          [c.fingerprint]: categoryId,
                        }))
                      }
                    />
                  ))}
                </ul>

                {candidates.some((c) => !isReady(c)) && (
                  <div className="rounded-xl bg-canvas p-4">
                    <p className="text-sm font-medium">
                      Not importable ({candidates.length - ready.length})
                    </p>
                    <ul className="mt-2 space-y-1.5">
                      {candidates
                        .filter((c) => !isReady(c))
                        .map((c) => (
                          <li
                            key={c.fingerprint}
                            className="truncate text-xs text-subtle"
                          >
                            {c.date} · {c.note || "No description"} ·{" "}
                            {dispositionLabel(c.disposition)}
                          </li>
                        ))}
                    </ul>
                  </div>
                )}

                <button
                  type="submit"
                  disabled={!canConfirm}
                  className="w-full rounded bg-gray-900 px-3 py-2 text-sm text-white disabled:opacity-50"
                >
                  {confirm.isPending
                    ? "Confirming…"
                    : remaining > 0
                      ? `${remaining} remaining`
                      : "Confirm import"}
                </button>
                {confirm.isError && (
                  <p className="text-sm text-red-600">
                    {(confirm.error as Error).message}{" "}
                    {confirm.error instanceof ApiError &&
                      confirm.error.status === 409 && (
                        <button
                          type="button"
                          className="underline"
                          onClick={() => preview.refetch()}
                        >
                          Reload preview
                        </button>
                      )}
                  </p>
                )}
                {confirm.isSuccess && (
                  <p className="text-sm text-green-700">
                    Imported {confirm.data.created} transactions.
                  </p>
                )}
              </form>
            )}
          </DashboardCard>
        </div>
      )}
    </div>
  );
}

export default function StatementImport() {
  const [file, setFile] = useState<File | null>(null);
  const [selectedImportId, setSelectedImportId] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const upload = useUploadStatement();

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!file) return;
    upload.mutate(file, {
      onSuccess: (batch) => setSelectedImportId(batch.id),
    });
  };

  return (
    <DashboardCard
      title="Statement Import"
      subtitle="Upload a bank statement PDF, review, then confirm"
    >
      <form onSubmit={submit} className="space-y-3">
        <input
          ref={inputRef}
          type="file"
          accept="application/pdf"
          className="block w-full text-sm text-gray-600"
          onChange={(e) => {
            setFile(e.target.files?.[0] ?? null);
            upload.reset();
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
            Statement uploaded successfully.
          </p>
        )}
      </form>
      {selectedImportId && (
        <ImportReview key={selectedImportId} importId={selectedImportId} />
      )}
    </DashboardCard>
  );
}
