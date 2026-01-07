import { useState, FormEvent } from "react";
import { useNavigate } from "react-router";
import type { LoaderFunctionArgs } from "react-router";
import { getAuthMode } from "~/.server/auth/oauth-config";

export async function loader({ request }: LoaderFunctionArgs) {
  const authMode = getAuthMode();

  // If OAuth mode, redirect to OAuth authorize endpoint
  if (authMode === 'oauth') {
    return Response.redirect('/api/oauth/authorize', 302);
  }

  // If no auth required, redirect to home
  if (authMode === 'none') {
    return Response.redirect('/', 302);
  }

  // Password mode: show login form
  return null;
}

export default function LoginPage() {
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const navigate = useNavigate();

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError("");
    setIsLoading(true);

    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });

      if (response.ok) {
        navigate("/");
      } else {
        const data = await response.json();
        setError(data.error || "Invalid password");
      }
    } catch {
      setError("An error occurred. Please try again.");
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-background px-4">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <h1 className="text-3xl font-bold mb-2">MyLifeDB</h1>
          <p className="text-muted-foreground">Enter your password to continue</p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Password"
              autoFocus
              required
              disabled={isLoading}
              className="w-full px-4 py-3 rounded-lg border border-border bg-background text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring disabled:opacity-50"
            />
          </div>

          {error && <div className="text-sm text-red-500 text-center">{error}</div>}

          <button
            type="submit"
            disabled={isLoading || !password}
            className="w-full px-4 py-3 rounded-lg bg-primary text-primary-foreground font-medium hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed transition-opacity"
          >
            {isLoading ? "Signing in..." : "Sign In"}
          </button>
        </form>
      </div>
    </div>
  );
}
