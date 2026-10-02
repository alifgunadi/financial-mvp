const API_URL = import.meta.env.VITE_API_URL ?? "";

// Error with the HTTP status attached. message is exactly what api()
// threw before (body.error ?? fallback), so readers of error.message
// behave the same as with a plain Error.
export class ApiError extends Error {
  readonly status: number;
  // Auth epoch captured when the request started (see below).
  readonly authEpoch: number;
  constructor(message: string, status: number, authEpoch: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.authEpoch = authEpoch;
  }
}

// Session token: memory-first, mirrored to localStorage so login survives
// a browser refresh. Trade-off: any XSS on this origin can read it (an
// HttpOnly cookie would need backend changes).
const SESSION_STORAGE_KEY = "financial-mvp.sessionToken";

function readStoredToken(): string | null {
  try {
    return localStorage.getItem(SESSION_STORAGE_KEY);
  } catch {
    return null;
  }
}

let sessionToken: string | null = readStoredToken();

// Counts every setSessionToken call (including null). Captured per request
// so a 401 arriving from a previous session never resets the new one.
let authEpoch = 0;

export function setSessionToken(token: string | null): void {
  sessionToken = token;
  authEpoch += 1;
  // Storage is best-effort: memory is authoritative, so a full or
  // unavailable storage only loses persistence, never the session itself.
  try {
    if (token === null) localStorage.removeItem(SESSION_STORAGE_KEY);
    else localStorage.setItem(SESSION_STORAGE_KEY, token);
  } catch {
    // Fall through to memory-only.
  }
}

export function hasSessionToken(): boolean {
  return sessionToken !== null;
}

export function getAuthEpoch(): number {
  return authEpoch;
}

function authHeaders(): Record<string, string> {
  return sessionToken ? { Authorization: `Bearer ${sessionToken}` } : {};
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const epoch = authEpoch;
  const res = await fetch(`${API_URL}${path}`, {
    headers: { "Content-Type": "application/json", ...authHeaders() },
    ...init,
  });
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok)
    throw new ApiError(
      body.error ?? `Request failed (${res.status})`,
      res.status,
      epoch,
    );
  return body as T;
}

// Multipart variant: same { error } convention, no JSON content-type
// (the browser sets the boundary automatically).
export async function apiUpload<T>(path: string, form: FormData): Promise<T> {
  const epoch = authEpoch;
  const res = await fetch(`${API_URL}${path}`, {
    method: "POST",
    headers: { ...authHeaders() },
    body: form,
  });
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok)
    throw new ApiError(
      body.error ?? `Request failed (${res.status})`,
      res.status,
      epoch,
    );
  return body as T;
}
