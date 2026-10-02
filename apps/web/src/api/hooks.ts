import {
  useMutation,
  useQuery,
  useQueryClient,
  type Query,
  type QueryClient,
} from "@tanstack/react-query";
import {
  ApiError,
  api,
  apiUpload,
  getAuthEpoch,
  hasSessionToken,
  setSessionToken,
} from "./client";

export interface AuthUser {
  id: string;
  email: string;
  role: "CLIENT" | "SUPERADMIN";
}

// Register/login response: AuthUser plus the runtime-only session token.
// The token lives in frontend memory only and is verified via /api/auth/me.
export interface AuthSession extends AuthUser {
  sessionToken: string;
}

export function useMe() {
  return useQuery<AuthUser | null>({
    queryKey: ["me"],
    // No token in memory means logged out: resolve unauthenticated without
    // a network call (a fetch could only 401). App gates on !data.
    queryFn: async () => {
      if (!hasSessionToken()) return null;
      return api<AuthUser>("/api/auth/me");
    },
    retry: false,
    // Logged-out state must be stable without network: after the logout
    // reset below, no background refetch (mount/focus/reconnect) may revive
    // the query. Login/register still refetch explicitly via invalidation,
    // which always bypasses staleTime. A kept /me error (Phase 3 notice)
    // must not refetch on its own either; only a new login/register does.
    staleTime: Infinity,
    retryOnMount: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
}

// Local-only auth reset (no server call: the server session is already
// invalid when this runs). Shared by logout and the global 401 handler.
// Order matters: cancelQueries MUST come first — its sync revert dispatch
// in onCancel would overwrite the null below if the order were reversed.
export function resetAuthState(qc: QueryClient): void {
  setSessionToken(null);
  void qc.cancelQueries({ queryKey: ["me"] });
  qc.setQueryData(["me"], null);
  qc.removeQueries({ predicate: (query) => query.queryKey[0] !== "me" });
}

// Global 401 handler for the QueryCache/MutationCache onError hooks.
// Resets only when the failing request belongs to the current session:
// no token (e.g. wrong password on /login) or a stale epoch (a previous
// session's in-flight request) never triggers a reset. Idempotent: the
// first reset bumps the epoch, so parallel 401s cannot reset twice.
export function handleAuthError(qc: QueryClient, error: unknown): void {
  if (!(error instanceof ApiError) || error.status !== 401) return;
  if (!hasSessionToken()) return;
  if (error.authEpoch !== getAuthEpoch()) return;
  resetAuthState(qc);
}

// QueryCache onError entry point. A non-401 /me failure while a token
// exists (login/register succeeded but verification failed) keeps its
// error state so AuthScreen can explain it; only the dangling token is
// dropped. Everything else follows the silent 401 reset above.
export function handleQueryError(
  qc: QueryClient,
  error: unknown,
  query: Pick<Query, "queryKey">,
): void {
  if (
    query.queryKey[0] === "me" &&
    hasSessionToken() &&
    !(error instanceof ApiError && error.status === 401)
  ) {
    setSessionToken(null);
    return;
  }
  handleAuthError(qc, error);
}

export function useRegister() {
  return useMutation({
    // Registration creates no session: the response is AuthUser only
    // (no sessionToken). Callers handle success per call; nothing here
    // touches the token, the epoch, or ["me"], so no /me request follows.
    mutationFn: (input: { email: string; password: string }) =>
      api<AuthUser>("/api/auth/register", {
        method: "POST",
        body: JSON.stringify(input),
      }),
  });
}

export function useLogin() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { email: string; password: string }) =>
      api<AuthSession>("/api/auth/login", {
        method: "POST",
        body: JSON.stringify(input),
      }),
    // Server is the source of truth: store the token, then re-verify via me.
    onSuccess: (session) => {
      setSessionToken(session.sessionToken);
      qc.invalidateQueries({ queryKey: ["me"] });
    },
  });
}

export function useLogout() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api<{ ok: true }>("/api/auth/logout", { method: "POST" }),
    // Token is sent with the request, so cleanup must run even when the
    // request fails: an aborted/failed logout still ends the local session.
    // Shared reset (see resetAuthState): ["me"] becomes null (never
    // undefined: setQueryData ignores undefined) so the mounted useMe
    // observer is notified synchronously and App renders AuthScreen.
    onSettled: () => {
      resetAuthState(qc);
    },
  });
}

export type CategoryType = "income" | "expense" | "both";
export type TransactionType = "income" | "expense";

export interface Category {
  id: string;
  name: string;
  type: CategoryType;
}

export interface Transaction {
  id: string;
  type: TransactionType;
  amount: number;
  date: string;
  note: string | null;
  merchant: string | null;
  // Null for statement-import rows confirmed without a category.
  category: Category | null;
  createdAt: string;
}

export interface TransactionList {
  data: Transaction[];
  total: number;
}

export function useCategories() {
  return useQuery({
    queryKey: ["categories"],
    queryFn: () => api<Category[]>("/api/categories"),
  });
}

export function useCreateCategory() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { name: string; type: CategoryType }) =>
      api<Category>("/api/categories", {
        method: "POST",
        body: JSON.stringify(input),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["categories"] }),
  });
}

export interface TransactionFilter {
  type: "" | TransactionType;
  categoryId: string;
}

export function useTransactions(filter: TransactionFilter) {
  const params = new URLSearchParams();
  if (filter.type) params.set("type", filter.type);
  if (filter.categoryId) params.set("categoryId", filter.categoryId);
  const qs = params.size ? `?${params}` : "";
  return useQuery({
    queryKey: ["transactions", filter],
    queryFn: () => api<TransactionList>(`/api/transactions${qs}`),
  });
}

export function useCreateTransaction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      type: TransactionType;
      amount: number;
      date: string;
      categoryId: string;
      note?: string;
      merchant?: string;
    }) =>
      api<Transaction>("/api/transactions", {
        method: "POST",
        body: JSON.stringify(input),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["transactions"] });
      qc.invalidateQueries({ queryKey: ["dashboard"] });
    },
  });
}

export interface SummaryPeriod {
  from: string;
  to: string;
}

export interface CategoryTotal {
  // Null for the "Uncategorized" import group (see dashboard summary).
  categoryId: string | null;
  name: string;
  total: number;
}

export interface DashboardSummary {
  from: string | null;
  to: string | null;
  totalIncome: number;
  totalExpense: number;
  balance: number;
  expenseByCategory: CategoryTotal[];
  recent: Transaction[];
  spendingPace: SpendingPace | null;
}

export type SpendingPaceStatus =
  | "on_track"
  | "over_budget"
  | "no_data"
  | "period_ended"
  | "unbounded";

// Additive daily guide on the existing summary response.
// Null when not computable (unbounded or ended period).
export interface SpendingPace {
  asOf: string;
  remainingDays: number;
  recommendedMaxPerDay: number;
  spentToday: number;
  remainingToday: number;
  status: SpendingPaceStatus;
}

export function useDashboardSummary(period: SummaryPeriod) {
  const params = new URLSearchParams();
  if (period.from) params.set("from", period.from);
  if (period.to) params.set("to", period.to);
  const qs = params.size ? `?${params}` : "";
  return useQuery({
    queryKey: ["dashboard", "summary", period],
    queryFn: () => api<DashboardSummary>(`/api/dashboard/summary${qs}`),
  });
}

export interface UploadedReceipt {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
  createdAt: string;
}

export function useUploadReceipt() {
  return useMutation({
    mutationFn: (file: File) => {
      const form = new FormData();
      form.append("file", file);
      return apiUpload<UploadedReceipt>("/api/receipts", form);
    },
  });
}

export interface ReceiptExtraction {
  id: string;
  status: string;
  extraction: {
    amount: number | null;
    date: string | null;
    merchant: string | null;
    type: "income" | "expense" | null;
    category: string | null;
  };
}

export function useExtractReceipt() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (receiptId: string) =>
      api<ReceiptExtraction>(`/api/receipts/${receiptId}/extract`, {
        method: "POST",
      }),
    // A fresh extraction is the newest NEEDS_REVIEW row: refresh latest.
    onSuccess: () => qc.invalidateQueries({ queryKey: ["receipts", "latest"] }),
  });
}

export interface ReceiptCandidate {
  amount: number | null;
  date: string | null;
  merchant: string | null;
  type: TransactionType | null;
  category: string | null;
}

// Stage 4 review state: current (reviewed) candidate, the reviewer's
// chosen category, and the untouched AI original for comparison.
export interface ReceiptDetail {
  id: string;
  status: string;
  extraction: ReceiptCandidate;
  suggestedCategory: Category | null;
  aiOriginal: ReceiptCandidate | null;
  extractedAt: string | null;
  error: string | null;
}

export interface ReviewInput {
  amount?: number | null;
  date?: string | null;
  merchant?: string | null;
  type?: TransactionType | null;
  categoryId?: string | null;
}

export function useReceipt(id: string | null) {
  return useQuery({
    queryKey: ["receipt", id],
    queryFn: () => api<ReceiptDetail>(`/api/receipts/${id}`),
    enabled: !!id,
    retry: false,
  });
}

// Save-and-confirm: PUT persists the review and, when the stored
// review is complete, the backend also creates the Transaction and
// flips the receipt to CONFIRMED in the same call.
export interface UpdateReceiptResponse {
  receipt: ReceiptDetail;
  transaction: Transaction | null;
}

export function useUpdateReceipt(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: ReviewInput) =>
      api<UpdateReceiptResponse>(`/api/receipts/${id}`, {
        method: "PUT",
        body: JSON.stringify(input),
      }),
    onSuccess: (data) => {
      qc.setQueryData(["receipt", id], data.receipt);
      // A transaction was created: same invalidation as manual creation.
      // Partial saves stay local to this receipt.
      if (data.transaction) {
        qc.invalidateQueries({ queryKey: ["transactions"] });
        qc.invalidateQueries({ queryKey: ["dashboard"] });
      }
    },
  });
}

// Latest NEEDS_REVIEW receipt of the caller (at most one row). Null
// means empty state: the user can upload a new receipt. The server is
// the source of truth; no browser storage is involved.
export interface LatestReceiptResponse {
  receipt: ReceiptDetail | null;
}

export function useLatestReceipt() {
  return useQuery({
    queryKey: ["receipts", "latest"],
    queryFn: () => api<LatestReceiptResponse>("/api/receipts/latest"),
    retry: false,
  });
}

export function useDeleteReceipt(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api<{ ok: true }>(`/api/receipts/${id}`, { method: "DELETE" }),
    // Only NEEDS_REVIEW rows are deletable (no Transaction exists yet),
    // so transactions/dashboard stay untouched.
    onSuccess: () => {
      qc.removeQueries({ queryKey: ["receipt", id] });
      qc.invalidateQueries({ queryKey: ["receipts", "latest"] });
    },
  });
}

// ---------- statement imports (Stage 6: PDF upload → preview → confirm) ----------

// Prisma ImportBatch → API shape (mirrors toApiImport: never exposes
// filePath or userId). bankId/statementFrom/To are null until resolved.
export interface ImportBatch {
  id: string;
  fileHash: string;
  originalName: string;
  mimeType: string;
  size: number;
  bankId: string | null;
  statementFrom: string | null;
  statementTo: string | null;
  status: string;
  error: string | null;
  createdAt: string;
}

// One ImportCandidate per parser row (mirrors toImportCandidates + the
// preview mapping: lowercase type/disposition, whole-IDR amount).
// merchant is reserved (always null from the parser); the description
// lives in note. fingerprint is the only identity (rowIndex restarts
// per pocket and is not unique across candidates).
export interface ImportCandidate {
  type: TransactionType;
  amount: number;
  date: string;
  merchant: string | null;
  note: string;
  reference: string | null;
  fingerprint: string;
  disposition: string;
  pocket: string;
  rowIndex: number;
}

export interface ImportDiagnostic {
  pocket: string | null;
  page: number | null;
  rowIndex: number | null;
  code: string;
}

export interface ImportPocket {
  pocket: string;
  openingMinor: number | null;
  totalIncomeMinor: number;
  totalExpenseMinor: number;
  closingMinor: number | null;
  rowCount: number;
  reconciled: boolean;
  importable: boolean;
  diagnostics: ImportDiagnostic[];
}

export interface ImportStatementPeriod {
  from: string;
  to: string;
}

export interface ImportDetection {
  isBlu: boolean;
  confidence: number;
  signals: { id: string; weight: number; matched: boolean }[];
}

export interface ImportSummary {
  total: number;
  ready: number;
  skippedInternalTransfer: number;
  blockedFractional: number;
  blockedUnreconciled: number;
  readyIncome: number;
  readyExpense: number;
}

export interface ImportPreview {
  batch: ImportBatch;
  bank: string;
  detected: ImportDetection;
  statementPeriod: ImportStatementPeriod | null;
  pockets: ImportPocket[];
  globalReconciled: boolean | null;
  importable: boolean;
  diagnostics: ImportDiagnostic[];
  summary: ImportSummary;
  candidates: ImportCandidate[];
}

export interface ConfirmImportInput {
  fingerprint: string;
  // Null = import without a category. Manual creation still requires one.
  categoryId: string | null;
}

export interface ConfirmImportResponse {
  batch: ImportBatch;
  created: number;
  skipped: number;
}

export function useUploadStatement() {
  return useMutation({
    mutationFn: (file: File) => {
      const form = new FormData();
      form.append("file", file);
      return apiUpload<ImportBatch>("/api/imports", form);
    },
  });
}

export function useImportPreview(id: string | null) {
  return useQuery({
    queryKey: ["imports", id, "preview"],
    queryFn: () => api<ImportPreview>(`/api/imports/${id}/preview`),
    enabled: !!id,
    retry: false,
  });
}

export function useConfirmImport(id: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (candidates: ConfirmImportInput[]) => {
      if (!id) throw new Error("no import selected");
      return api<ConfirmImportResponse>(`/api/imports/${id}/confirm`, {
        method: "POST",
        body: JSON.stringify({ candidates }),
      });
    },
    // Confirm writes Transactions: same invalidation as manual creation,
    // plus the preview of this batch (batch is now IMPORTED).
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["transactions"] });
      qc.invalidateQueries({ queryKey: ["dashboard"] });
      if (id) qc.invalidateQueries({ queryKey: ["imports", id, "preview"] });
    },
  });
}
