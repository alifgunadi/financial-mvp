import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, apiUpload } from "./client";

export interface AuthUser {
  id: string;
  email: string;
  role: "CLIENT" | "SUPERADMIN";
}

export function useMe() {
  return useQuery({
    queryKey: ["me"],
    queryFn: () => api<AuthUser>("/api/auth/me"),
    retry: false,
  });
}

export function useRegister() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { email: string; password: string }) =>
      api<AuthUser>("/api/auth/register", {
        method: "POST",
        body: JSON.stringify(input),
      }),
    onSuccess: (user) => qc.setQueryData(["me"], user),
  });
}

export function useLogin() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { email: string; password: string }) =>
      api<AuthUser>("/api/auth/login", {
        method: "POST",
        body: JSON.stringify(input),
      }),
    onSuccess: (user) => qc.setQueryData(["me"], user),
  });
}

export function useLogout() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api<{ ok: true }>("/api/auth/logout", { method: "POST" }),
    onSuccess: () => {
      qc.clear();
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
  category: Category;
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
  categoryId: string;
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
  return useMutation({
    mutationFn: (receiptId: string) =>
      api<ReceiptExtraction>(`/api/receipts/${receiptId}/extract`, {
        method: "POST",
      }),
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

export function useUpdateReceipt(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: ReviewInput) =>
      api<ReceiptDetail>(`/api/receipts/${id}`, {
        method: "PUT",
        body: JSON.stringify(input),
      }),
    // Review saves stay local to this receipt: no transactions or
    // dashboard invalidation (no Transaction exists yet).
    onSuccess: (data) => qc.setQueryData(["receipt", id], data),
  });
}
