import { createAuthClient } from "better-auth/react";

export const authClient = createAuthClient({ basePath: "/api/auth" });

export const { useSession } = authClient;

/** Map Better Auth error codes to plain, specific messages. */
export function authErrorMessage(err: { code?: string; message?: string; status?: number } | null | undefined): string {
  if (!err) return "";
  switch (err.code) {
    case "INVALID_EMAIL_OR_PASSWORD":
      return "That email and password do not match.";
    case "EMAIL_NOT_VERIFIED":
      return "Verify your email first. We sent you a link when you signed up.";
    case "USER_ALREADY_EXISTS":
    case "USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL":
      return "An account with this email already exists. Sign in instead.";
    case "PASSWORD_TOO_SHORT":
      return "Use at least 10 characters.";
    case "PASSWORD_TOO_LONG":
      return "Use 128 characters or fewer.";
    case "INVALID_TOKEN":
      return "This link has expired. Request a new one.";
  }
  if (err.status === 429) return "Too many attempts. Wait a minute and try again.";
  return err.message || "Something went wrong. Try again.";
}
