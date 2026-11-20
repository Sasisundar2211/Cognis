import type { Plan } from "../env";

/**
 * Plan entitlements. Enforced server-side. Prices live in docs/PRICING.md;
 * billing is not wired yet, so every account is on "free" until a payment
 * provider is connected.
 */
export const PLAN_LIMITS: Record<Plan, { maxItems: number; maxCollections: number; maxUrlIngestPerDay: number }> = {
  free: { maxItems: 500, maxCollections: 10, maxUrlIngestPerDay: 50 },
  plus: { maxItems: 10_000, maxCollections: 200, maxUrlIngestPerDay: 500 },
  pro: { maxItems: 50_000, maxCollections: 1_000, maxUrlIngestPerDay: 2_000 },
};
