import { useState } from "react";
import { useLogin } from "../api/hooks";
import { authInputCls } from "../shared/authStyles";

export default function LoginScreen({
  initialIdentifier = "",
  onRegister,
}: {
  initialIdentifier?: string;
  onRegister: () => void;
}) {
  const [identifier, setIdentifier] = useState(initialIdentifier);
  const [password, setPassword] = useState("");
  const login = useLogin();

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!identifier.trim() || !password) return;
    login.mutate({ identifier: identifier.trim(), password });
  };

  const switchMode = () => {
    login.reset();
    onRegister();
  };

  return (
    <section className="rounded border border-gray-200 bg-white p-4">
      <h2 className="text-base font-semibold">Login</h2>
      <form onSubmit={submit} className="mt-3 space-y-3">
        <input
          className={authInputCls}
          type="text"
          aria-label="Email or username"
          placeholder="Email or username"
          autoComplete="username"
          value={identifier}
          onChange={(e) => setIdentifier(e.target.value)}
        />
        <input
          className={authInputCls}
          type="password"
          aria-label="Password"
          placeholder="Password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <button
          type="submit"
          disabled={login.isPending}
          className="w-full rounded bg-gray-900 px-3 py-2 text-sm text-white disabled:opacity-50"
        >
          {login.isPending ? "Please wait…" : "Login"}
        </button>
        {login.isError && (
          <p className="text-sm text-clay-ink">
            {(login.error as Error).message}
          </p>
        )}
      </form>
      <p className="mt-3 text-center text-sm text-gray-600">
        No account yet?{" "}
        <button className="underline" onClick={switchMode}>
          Register
        </button>
      </p>
    </section>
  );
}
