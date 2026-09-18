import { NextRequest } from "next/server";
import { getSettings, saveSettings } from "@/lib/settings";
import type { AppSettings } from "@/lib/types";
import { requireAdmin } from "@/lib/auth";

export const dynamic = "force-dynamic";

/**
 * The settings object as it may leave the server.
 *
 * Three secrets live on it and none may be serialised to a client:
 * `payments.stripeSecretKey`, a live credential that can create payment pages and
 * read transactions, and `apiPassword`/`adminPassword`, which *are* the access
 * control on this server. Each is reported as a boolean instead. The passwords
 * are written back through this route; the Stripe key only through
 * /api/payments, which validates it.
 */
function redacted(s: AppSettings) {
  const { apiPassword, adminPassword, payments, ...rest } = s;
  return {
    ...rest,
    hasApiPassword: apiPassword.trim().length > 0,
    hasAdminPassword: adminPassword.trim().length > 0,
    payments: payments ? publicPaymentsShape(payments) : undefined,
  };
}

/** A payment-settings object with the secret replaced by whether one is stored. */
function publicPaymentsShape(p: NonNullable<AppSettings["payments"]>) {
  const { stripeSecretKey, ...safe } = p;
  return { ...safe, hasStripeKey: stripeSecretKey.trim().length > 0 };
}

/**
 * A settings patch, plus the two read-only booleans this route also *emits*.
 *
 * They are accepted in the type so a client that echoes a GET response back is
 * not a type error, and then dropped below: a caller must not be able to assert
 * that a password is set.
 */
type SettingsPatchBody = Partial<AppSettings> & {
  hasApiPassword?: unknown;
  hasAdminPassword?: unknown;
};

export async function GET(req: NextRequest) {
  const denied = requireAdmin(req);
  if (denied) return denied;
  return Response.json(redacted(getSettings()));
}

export async function PATCH(req: NextRequest) {
  const denied = requireAdmin(req);
  if (denied) return denied;
  const patch = (await req.json().catch(() => ({}))) as SettingsPatchBody;
  const current = getSettings();
  const { payments: incoming, hasApiPassword: assertedApi, hasAdminPassword: assertedAdmin, ...rest } = patch;
  void assertedApi;
  void assertedAdmin;
  const next: AppSettings = {
    ...current,
    ...rest,
    ads: { ...current.ads, ...(patch.ads ?? {}) },
    // Merged, not replaced: a caller tightening one limit must not silently
    // reset the others to whatever it did not send.
    ...(patch.funding ? { funding: { ...current.funding, ...patch.funding } } : {}),
    // Payment credentials are only written through /api/payments, so a generic
    // settings save cannot swap the key or point the app at a different provider.
    payments: current.payments,
  };
  void incoming;
  saveSettings(next);
  return Response.json(redacted(next));
}
