import { betterAuth } from "better-auth";
import type { Env } from "./env";
import { hashPassword, verifyPassword } from "./lib/password";
import { sendEmail } from "./lib/email";
import { audit } from "./lib/audit";

/** Better Auth instance. Built per request because Workers bindings are per request. */
export function createAuth(env: Env) {
  const emailEnabled = env.EMAIL_MODE !== "disabled";
  return betterAuth({
    appName: "Cognis",
    database: env.DB,
    secret: env.BETTER_AUTH_SECRET,
    baseURL: env.BETTER_AUTH_URL,
    basePath: "/api/auth",
    trustedOrigins: [env.BETTER_AUTH_URL],
    telemetry: { enabled: false },
    emailAndPassword: {
      enabled: true,
      minPasswordLength: 10,
      maxPasswordLength: 128,
      requireEmailVerification: emailEnabled,
      revokeSessionsOnPasswordReset: true,
      password: { hash: hashPassword, verify: verifyPassword },
      sendResetPassword: async ({ user, url }) => {
        await sendEmail(env, {
          to: user.email,
          subject: "Reset your Cognis password",
          text: `Someone asked to reset the password for your Cognis account.\n\nReset it here: ${url}\n\nThe link expires in 1 hour. If you did not ask for this, ignore this email.`,
        });
      },
    },
    emailVerification: {
      sendOnSignUp: emailEnabled,
      autoSignInAfterVerification: true,
      sendVerificationEmail: async ({ user, url }) => {
        await sendEmail(env, {
          to: user.email,
          subject: "Verify your Cognis email",
          text: `Welcome to Cognis.\n\nVerify your email here: ${url}\n\nIf you did not create an account, ignore this email.`,
        });
      },
    },
    user: {
      additionalFields: {
        plan: { type: "string", required: false, defaultValue: "free", input: false },
      },
      deleteUser: {
        enabled: true,
        afterDelete: async (user) => {
          await audit(env.DB, user.id, "account.deleted");
        },
      },
    },
    session: { expiresIn: 60 * 60 * 24 * 30, updateAge: 60 * 60 * 24 },
    rateLimit: {
      enabled: env.APP_ENV !== "test",
      storage: "database",
      window: 60,
      max: 60,
      customRules: {
        "/sign-in/email": { window: 60, max: 5 },
        "/sign-up/email": { window: 60, max: 5 },
        "/request-password-reset": { window: 300, max: 3 },
        "/send-verification-email": { window: 300, max: 3 },
      },
    },
    advanced: {
      ipAddress: { ipAddressHeaders: ["cf-connecting-ip"] },
      useSecureCookies: env.BETTER_AUTH_URL.startsWith("https://"),
      defaultCookieAttributes: { sameSite: "lax", httpOnly: true },
    },
    databaseHooks: {
      user: { create: { after: async (u) => { await audit(env.DB, u.id, "account.created"); } } },
      session: { create: { after: async (s) => { await audit(env.DB, s.userId, "session.created"); } } },
    },
  });
}

export type Auth = ReturnType<typeof createAuth>;
