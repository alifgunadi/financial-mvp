import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import {
  MutationCache,
  QueryCache,
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query";
import App from "./App.tsx";
import { ApiError } from "./api/client";
import { handleAuthError, handleQueryError } from "./api/hooks";
import "./index.css";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // A 4xx is a final answer, never retry it. Anything else keeps the
      // library default (up to 3 retries with backoff). Mutations untouched.
      retry: (failureCount, error) =>
        error instanceof ApiError && error.status >= 400 && error.status < 500
          ? false
          : failureCount < 3,
    },
  },
  // A 401 from any query/mutation of the current session means the server
  // session is gone: reset local auth so App renders AuthScreen. Login
  // failures carry no token and stale sessions a stale epoch, so neither
  // can trigger a reset here (see handleAuthError).
  queryCache: new QueryCache({
    onError: (error, query) => handleQueryError(queryClient, error, query),
  }),
  mutationCache: new MutationCache({
    onError: (error) => handleAuthError(queryClient, error),
  }),
});

const rootEl = document.getElementById("root");
if (!rootEl) throw new Error("Missing #root element");

createRoot(rootEl).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
);
