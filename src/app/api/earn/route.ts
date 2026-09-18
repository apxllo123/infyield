import { NextRequest, NextResponse } from "next/server";
import { AD_INTENSITY, type AdIntensity, earnPlan } from "@/lib/premium";
import { getSettings, saveSettings } from "@/lib/settings";
import { runAutoSetup } from "@/lib/autosetup";
import { requireAdmin } from "@/lib/auth";

export const dynamic = "force-dynamic";

/**
 * The Earn panel's single endpoint: how ad revenue is building towards a target,
 * what the premium models need, and the two controls that change it —
 * the savings target and the ad intensity.
 *
 * Every number is derived from the real ledger and the configured CPM; nothing
 * here is simulated. `usingPlaceholderInventory` is reported too, because house
 * campaigns credit the ledger but earn no actual money, and the UI must not
 * imply otherwise.
 *
 * Admin-guarded like every other surface that can change a setting. It used to
 * be the one route with no check at all, which made "set an admin password" mean
 * "set an admin password, except for the ad network and the savings target".
 */
export async function GET(req: NextRequest) {
  const denied = requireAdmin(req);
  if (denied) return denied;
  runAutoSetup();
  return NextResponse.json(earnPlan());
}

export async function PATCH(req: NextRequest) {
  const denied = requireAdmin(req);
  if (denied) return denied;
  const body = (await req.json().catch(() => ({}))) as {
    targetUsd?: unknown;
    intensity?: unknown;
    network?: unknown;
    ethicalAdsPublisherId?: unknown;
    carbonPlacementId?: unknown;
  };

  const settings = getSettings();
  let next = { ...settings };
  const applied: string[] = [];

  if (body.targetUsd !== undefined) {
    const target = Number(body.targetUsd);
    if (!Number.isFinite(target) || target < 0) {
      return NextResponse.json({ error: "targetUsd must be a number of 0 or more." }, { status: 400 });
    }
    next = { ...next, earnTargetUsd: Math.round(target * 100) / 100 };
    applied.push("targetUsd");
  }

  if (body.intensity !== undefined) {
    const key = String(body.intensity) as AdIntensity;
    if (!(key in AD_INTENSITY)) {
      return NextResponse.json(
        { error: `intensity must be one of: ${Object.keys(AD_INTENSITY).join(", ")}.` },
        { status: 400 },
      );
    }
    // One control, two knobs — the scheduler reads cadence and the cap.
    const preset = AD_INTENSITY[key];
    next = {
      ...next,
      ads: { ...next.ads, cadenceSteps: preset.cadenceSteps, maxAdsPerResponse: preset.maxAdsPerResponse },
    };
    applied.push("intensity");
  }

  if (body.network !== undefined) {
    const network = String(body.network);
    // Every value the Settings UI offers must be accepted here, or the same
    // choice succeeds in one panel and fails in another.
    if (network !== "house" && network !== "ethicalads" && network !== "carbon") {
      return NextResponse.json({ error: 'network must be "house", "ethicalads" or "carbon".' }, { status: 400 });
    }
    next = { ...next, ads: { ...next.ads, network } };
    applied.push("network");
  }

  if (body.ethicalAdsPublisherId !== undefined) {
    next = { ...next, ads: { ...next.ads, ethicalAdsPublisherId: String(body.ethicalAdsPublisherId).trim() } };
    applied.push("ethicalAdsPublisherId");
  }

  if (body.carbonPlacementId !== undefined) {
    next = { ...next, ads: { ...next.ads, carbonPlacementId: String(body.carbonPlacementId).trim() } };
    applied.push("carbonPlacementId");
  }

  if (!applied.length) {
    return NextResponse.json({ error: "Nothing to change. Send targetUsd, intensity, network or ethicalAdsPublisherId." }, { status: 400 });
  }

  saveSettings(next);
  return NextResponse.json({ ok: true, applied, plan: earnPlan() });
}
