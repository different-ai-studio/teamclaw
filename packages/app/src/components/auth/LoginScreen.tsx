import { useState } from "react";
import { useAuthStore } from "@/stores/auth-store";

export function LoginScreen() {
  const [mode, setMode] = useState<"signIn" | "signUp">("signIn");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const { signIn, signUp, loading, errorMessage } = useAuthStore();

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (mode === "signIn") {
      await signIn(email, password);
    } else {
      await signUp(email, password);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-6">
      <form onSubmit={onSubmit} className="w-full max-w-sm space-y-4 rounded-lg border bg-card p-6 shadow">
        <h1 className="text-xl font-semibold">{mode === "signIn" ? "Sign in to TeamClaw" : "Create your account"}</h1>
        <div className="space-y-2">
          <label className="block text-sm">Email</label>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            className="w-full rounded border bg-background px-3 py-2 text-sm"
            autoFocus
          />
        </div>
        <div className="space-y-2">
          <label className="block text-sm">Password</label>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            minLength={6}
            className="w-full rounded border bg-background px-3 py-2 text-sm"
          />
        </div>
        {errorMessage && (
          <p className="text-sm text-red-600">{errorMessage}</p>
        )}
        <button
          type="submit"
          disabled={loading}
          className="w-full rounded bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
        >
          {loading ? "..." : mode === "signIn" ? "Sign in" : "Create account"}
        </button>
        <button
          type="button"
          onClick={() => setMode(mode === "signIn" ? "signUp" : "signIn")}
          className="block w-full text-center text-sm text-muted-foreground hover:underline"
        >
          {mode === "signIn" ? "Need an account? Create one" : "Have an account? Sign in"}
        </button>
      </form>
    </div>
  );
}
