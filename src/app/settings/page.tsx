"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { ErrorState, Notice, SectionHeading, Skeleton } from "@/components/ui";
import { IconCheck, IconInvoice, IconLayers, IconLock, IconPlug, IconSettings, IconSparkle, IconWallet } from "@/components/icons";
import { api, errorMessage, setAccessToken } from "@/lib/client/api";
import type { PaymentsPatch, PaymentsPublic } from "@/lib/client/api";
import type { AdsSettings } from "@/lib/types";
import { notifyDataChanged, useMotionPref, useResource } from "@/lib/client/store";
import { usd } from "@/lib/client/format";

type SectionId = "general" | "appearance" | "connections" | "billing" | "payments" | "privacy" | "advanced";

/**
 * Billing and Payments are deliberately absent.
 *
 * They are revenue and invoicing controls — the "credits display" Freebuff's
 * spec exists to delete — and their panels live on `/economy` with the rest of
 * the books. Both still work; they are simply not part of the product's visible
 * surface any more. Add the two entries back here to restore them in Settings.
 */
const SECTIONS: { id: SectionId; label: string; Icon: typeof IconSettings; blurb: string }[] = [
  { id: "general", label: "General", Icon: IconSettings, blurb: "Workspace and model access" },
  { id: "appearance", label: "Appearance", Icon: IconSparkle, blurb: "Motion and density" },
  { id: "connections", label: "Connections", Icon: IconPlug, blurb: "Providers and keys" },
  { id: "privacy", label: "Privacy", Icon: IconLock, blurb: "Access passwords" },
  { id: "advanced", label: "Advanced", Icon: IconLayers, blurb: "Ads and the API" },
];

export default function SettingsPage() {
  const settings = useResource(() => api.settings(), []);
  const bootstrap = useResource(() => api.bootstrap(), []);
  const workspace = useResource(() => api.workspace(), []);
  // The delivery report is what tells you whether the ad slot is actually
  // paying: a rejected publisher id looks exactly like healthy delivery unless
  // it is shown.
  const delivery = useResource(() => api.economy(), []);
  // The intensity dial lives here now: it used to be on Economy → Earn, and
  // Freebuff's rule is that ads cannot be switched off — only how hard they
  // work. Keeping the dial in Advanced means the cadence is still tunable with
  // the money page out of the navigation.
  const earnPlan = useResource(() => api.earn(), []);
  const { motion, setMotion, systemReduced } = useMotionPref();

  const [section, setSection] = useState<SectionId>("general");
  const [saved, setSaved] = useState("");
  const [error, setError] = useState("");
  const [workspaceRoot, setWorkspaceRoot] = useState("");
  const [payoutAccount, setPayoutAccount] = useState("");
  /**
   * The access passwords, as *this browser* holds them.
   *
   * The server never sends them back — it reports whether each is set — so these
   * fields start empty and are write-only. What is typed is saved to the server
   * and, on success, kept in this browser's storage so the very next request can
   * still authenticate; clearing the field clears it in both places.
   */
  const [apiPassword, setApiPassword] = useState("");
  const [adminPassword, setAdminPassword] = useState("");
  // What each field held when it was focused, so a blur that changed nothing
  // does not send a write (and so clearing a field back to empty *does*).
  const [apiPwBase, setApiPwBase] = useState("");
  const [adminPwBase, setAdminPwBase] = useState("");
  const [unlockPw, setUnlockPw] = useState("");

  // Collection: where invoices actually get paid. The key is write-only from the
  // client's point of view — the server tells us whether one is stored, never
  // what it is.
  const payments = useResource(() => api.payments(), []);
  const [payProvider, setPayProvider] = useState<PaymentsPublic["provider"]>("none");
  const [payLink, setPayLink] = useState("");
  const [payKey, setPayKey] = useState("");
  const [paySuccess, setPaySuccess] = useState("");
  const [payCancel, setPayCancel] = useState("");
  const [busy, setBusy] = useState(false);
  const [payResult, setPayResult] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    if (!settings.data) return;
    setWorkspaceRoot(settings.data.workspaceRoot);
    setPayoutAccount(settings.data.payoutAccount);
  }, [settings.data]);

  useEffect(() => {
    const p = payments.data?.payments;
    if (!p) return;
    setPayProvider(p.provider);
    setPayLink(p.linkUrl);
    setPaySuccess(p.successUrl);
    setPayCancel(p.cancelUrl);
    // The key is never sent back, so the field starts empty and only a value the
    // user actually types is written.
    setPayKey("");
  }, [payments.data]);

  const savePayments = async (patch: PaymentsPatch, label: string) => {
    setError("");
    setPayResult(null);
    try {
      await api.setPayments(patch);
      payments.refresh();
      setSaved(label);
      setTimeout(() => setSaved((s) => (s === label ? "" : s)), 2200);
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  /** Actions that talk to the provider, so they get their own busy/result state. */
  const runPayments = async (fn: () => Promise<{ ok: boolean; message: string }>) => {
    setBusy(true);
    setError("");
    setPayResult(null);
    try {
      const res = await fn();
      setPayResult({ ok: res.ok, text: res.message });
      payments.refresh();
      notifyDataChanged();
    } catch (e) {
      setPayResult({ ok: false, text: errorMessage(e) });
    } finally {
      setBusy(false);
    }
  };

  /** Saves a patch and reports whether it landed, so callers can follow up only
   * on success. */
  const save = async (patch: Parameters<typeof api.saveSettings>[0], label: string): Promise<boolean> => {
    setError("");
    try {
      await api.saveSettings(patch);
      settings.refresh();
      workspace.refresh();
      notifyDataChanged();
      setSaved(label);
      setTimeout(() => setSaved((s) => (s === label ? "" : s)), 2200);
      return true;
    } catch (e) {
      setError(errorMessage(e));
      return false;
    }
  };

  /**
   * Save one access password, then remember it here — in that order.
   *
   * The request that sets a password is the last one this browser can make
   * without it, so the token is only stored once the write has actually
   * succeeded; storing it first would leave a wrong token behind after a failed
   * save and every later request would 401.
   */
  const savePassword = async (kind: "admin" | "api", value: string, label: string) => {
    const ok = await save(kind === "admin" ? { adminPassword: value } : { apiPassword: value }, label);
    if (ok) setAccessToken(kind, value);
  };

  /**
   * Adopt a password this browser was not told about.
   *
   * Reachable when the server has a password and this browser's storage does not
   * — a second browser profile, cleared storage, or a password set from the
   * command line. It is verified immediately, because a wrong password left in
   * storage would fail every subsequent request with a 401 instead of saying so
   * once, here.
   */
  const unlock = async () => {
    setError("");
    setAccessToken("admin", unlockPw);
    try {
      await api.settings();
      setSaved("Access");
      setUnlockPw("");
      settings.refresh();
      workspace.refresh();
      delivery.refresh();
      earnPlan.refresh();
      payments.refresh();
    } catch (e) {
      setAccessToken("admin", "");
      setError(errorMessage(e));
    }
  };

  const ads = settings.data?.ads;
  const patchAds = (patch: Partial<AdsSettings>, label: string) => ads && save({ ads: { ...ads, ...patch } }, label);

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <SectionHeading eyebrow="Settings" title="Preferences" hint="Everything here is stored server-side with the rest of the app's state." />
        {saved && (
          <span className="chip chip-mint fade mb-5">
            <IconCheck size={12} />
            {saved} saved
          </span>
        )}
      </div>

      {settings.error && <ErrorState title="Can’t read settings" body={settings.error} onRetry={settings.refresh} retrying={settings.loading} />}
      {error && <Notice tone="danger" title="Couldn’t save that">{error}</Notice>}

      <div className="grid gap-6 lg:grid-cols-[248px_minmax(0,1fr)]">
        {/* ------------------------- section nav ------------------------ */}
        <nav className="glass h-fit rounded-[var(--r-xl)] p-2">
          {SECTIONS.map(({ id, label, Icon, blurb }) => {
            const active = section === id;
            return (
              <button
                key={id}
                onClick={() => setSection(id)}
                className={`flex w-full items-center gap-3 rounded-[var(--r-md)] px-3 py-2.5 text-left transition-colors ${
                  active ? "bg-[rgba(255,255,255,0.08)]" : "hover:bg-[rgba(255,255,255,0.04)]"
                }`}
              >
                <span className={`grid h-7 w-7 shrink-0 place-items-center rounded-[var(--r-xs)] border ${active ? "border-[rgba(53,224,161,0.32)] text-[var(--mint)]" : "border-[var(--border-1)] text-[var(--text-3)]"}`}>
                  <Icon size={14} />
                </span>
                <span className="min-w-0">
                  <span className={`block truncate text-[13px] ${active ? "text-[var(--text-1)]" : "text-[var(--text-2)]"}`}>{label}</span>
                  <span className="t-micro block truncate">{blurb}</span>
                </span>
              </button>
            );
          })}
        </nav>

        {/* --------------------------- panels -------------------------- */}
        <div className="min-w-0 space-y-6">
          {settings.loading && !settings.data ? (
            <div className="glass panel space-y-4">
              <Skeleton className="h-4 w-40" />
              <Skeleton className="h-10" />
              <Skeleton className="h-4 w-32" />
              <Skeleton className="h-10" />
            </div>
          ) : (
            <>
              {section === "general" && (
                <Panel eyebrow="General" title="Workspace" hint="The single folder the agent can read, edit and run commands in. Everything it does is scoped to this directory.">
                  <Field label="Workspace root">
                    <input
                      className="input"
                      value={workspaceRoot}
                      onChange={(e) => setWorkspaceRoot(e.target.value)}
                      onBlur={() => workspaceRoot !== settings.data?.workspaceRoot && save({ workspaceRoot }, "Workspace")}
                      placeholder="/Users/you/project"
                    />
                  </Field>
                  <div className="mt-4 flex flex-wrap items-center gap-2">
                    {workspace.data?.exists ? (
                      <span className="chip chip-mint">
                        <IconCheck size={12} />
                        {workspace.data.entries.length} entries found
                      </span>
                    ) : (
                      <span className="chip chip-amber">Folder not found</span>
                    )}
                    <Link href="/library" className="chip">
                      Browse in Library
                    </Link>
                  </div>
                  <p className="t-micro mt-4">
                    Paths are resolved server-side. Ask the agent to change a file and it happens here — the client never writes to disk itself.
                  </p>
                </Panel>
              )}

              {section === "appearance" && (
                <Panel eyebrow="Appearance" title="Motion" hint="Infyield animates its surfaces. Calm keeps the layout identical but removes movement and long transitions.">
                  <div className="seg">
                    <button className="seg-item" data-active={motion === "default"} onClick={() => setMotion("default")}>
                      Default
                    </button>
                    <button className="seg-item" data-active={motion === "calm"} onClick={() => setMotion("calm")}>
                      Calm
                    </button>
                  </div>
                  <div className="mt-5 space-y-3">
                    <Row label="Your system preference" value={systemReduced ? "Reduce motion is on" : "Motion allowed"} />
                    <Row label="Preference source" value="This device" />
                    <Row label="Effective setting" value={motion === "calm" || systemReduced ? "Calm" : "Default"} />
                  </div>
                  <p className="t-micro mt-5">
                    macOS&apos;s own Reduce Motion setting is always honoured, whatever is chosen here.
                  </p>
                </Panel>
              )}

              {section === "connections" && (
                <Panel eyebrow="Connections" title="Providers" hint="Keys are pooled server-side and never exposed to this client.">
                  <div className="grid gap-4 sm:grid-cols-2">
                    <Row label="Funding mode" value={bootstrap.data?.funding.mode ?? "—"} />
                    <Row label="Keys in pool" value={String(bootstrap.data?.keys ?? 0)} />
                    <Row label="Models servable" value={bootstrap.data ? `${bootstrap.data.servableCount} of ${bootstrap.data.totalModels}` : "—"} />
                    <Row label="OpenRouter" value={bootstrap.data?.hasAnyKey ? "Connected" : "Not connected"} />
                  </div>
                  <Link href="/connections" className="btn btn-glass btn-sm mt-6">
                    <IconPlug size={14} />
                    Manage connections
                  </Link>
                </Panel>
              )}

              {section === "billing" && (
                <Panel eyebrow="Billing" title="Ad revenue" hint="Infyield has no subscription and no user balance: ad revenue funds the model spend, and what's left can be paid out.">
                  {/* Available and collectible are the honest pair: the ledger's
                      booked total includes seeded placeholder inventory that no
                      advertiser will ever pay, so it is shown as its own row. */}
                  <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
                    <Row label="Available" value={usd(bootstrap.data?.earn.spendableUsd ?? 0)} />
                    <Row label="Collectible" value={usd(bootstrap.data?.earn.collectibleUsd ?? 0)} />
                    <Row label="Booked" value={usd(bootstrap.data?.economy.adRevenueUsd ?? 0)} />
                    <Row label="Spent" value={usd(bootstrap.data?.economy.spendUsd ?? 0)} />
                  </div>
                  <div className="mt-6">
                    <Field label="Account the money lands in">
                      <input
                        className="input"
                        value={payoutAccount}
                        onChange={(e) => setPayoutAccount(e.target.value)}
                        onBlur={() => payoutAccount !== settings.data?.payoutAccount && save({ payoutAccount }, "Payout account")}
                        placeholder="Wise ··4821 or paypal.me/you"
                      />
                    </Field>
                  </div>
                  <Link href="/economy" className="btn btn-glass btn-sm mt-6">
                    <IconWallet size={14} />
                    Open the economy
                  </Link>
                </Panel>
              )}

              {section === "payments" && (
                <Panel
                  eyebrow="Payments"
                  title="Getting paid"
                  hint="How an advertiser actually sends money for an invoice. The app never holds funds or sees card details — it hands over a payment page, then reads the transaction back when the provider allows it."
                >
                  <div className="grid gap-4 sm:grid-cols-3">
                    <Row
                      label="Provider"
                      value={payments.data?.payments.provider === "stripe" ? "Stripe" : payments.data?.payments.provider === "link" ? "Static link" : "Not set up"}
                    />
                    <Row
                      label="Key stored"
                      value={payments.data?.payments.hasStripeKey ? (payments.data?.payments.keyMode === "restricted" ? "restricted" : "secret") : "—"}
                    />
                    <Row
                      label="Last checked"
                      value={payments.data?.payments.lastSyncAt ? new Date(payments.data.payments.lastSyncAt).toLocaleString() : "never"}
                    />
                  </div>

                  {payments.data?.payments.lastSyncText && (
                    <p className="t-micro mt-3">{payments.data.payments.lastSyncText}</p>
                  )}

                  <div className="mt-6">
                    <Field label="How invoices are collected">
                      <div className="flex flex-wrap gap-2">
                        {([
                          { id: "none", label: "Nothing — settle by hand" },
                          { id: "link", label: "A payment link I already have" },
                          { id: "stripe", label: "Stripe checkout" },
                        ] as const).map((opt) => (
                          <button
                            key={opt.id}
                            className={`btn btn-sm ${payProvider === opt.id ? "btn-primary" : "btn-glass"}`}
                            disabled={busy}
                            onClick={() => {
                              setPayProvider(opt.id);
                              savePayments({ provider: opt.id }, "Payment provider");
                            }}
                          >
                            {opt.label}
                          </button>
                        ))}
                      </div>
                    </Field>
                  </div>

                  {payProvider === "link" && (
                    <div className="mt-5 space-y-4">
                      <Field label="Payment link">
                        <input
                          className="input"
                          value={payLink}
                          onChange={(e) => setPayLink(e.target.value)}
                          onBlur={() => payLink !== payments.data?.payments.linkUrl && savePayments({ linkUrl: payLink }, "Payment link")}
                          placeholder="https://buy.stripe.com/… or https://paypal.me/you"
                        />
                      </Field>
                      <p className="t-micro">
                        Must be https. The app cannot verify a link beyond its shape and cannot see whether anyone paid through it — record the payment
                        yourself when it lands, or use Stripe below to have the transaction read back automatically.
                      </p>
                    </div>
                  )}

                  {payProvider === "stripe" && (
                    <div className="mt-5 space-y-4">
                      <Field label="Restricted secret key">
                        <input
                          className="input mono"
                          type="password"
                          value={payKey}
                          onChange={(e) => setPayKey(e.target.value)}
                          onBlur={() => payKey.trim() && savePayments({ stripeSecretKey: payKey }, "Stripe key")}
                          placeholder={payments.data?.payments.hasStripeKey ? "•••••• stored — type to replace" : "rk_live_…"}
                        />
                      </Field>
                      <p className="t-micro">
                        Stored server-side and never sent back to the browser. A <strong>restricted</strong> key (<code className="mono">rk_…</code>) with
                        Checkout Sessions write access is enough — this app only ever creates a checkout page and lists them, so it has no reason to hold a
                        key that can move money.
                      </p>
                      <div className="grid gap-3 md:grid-cols-2">
                        <Field label="After paying, send them to">
                          <input
                            className="input"
                            value={paySuccess}
                            onChange={(e) => setPaySuccess(e.target.value)}
                            onBlur={() => paySuccess !== payments.data?.payments.successUrl && savePayments({ successUrl: paySuccess }, "Success URL")}
                            placeholder="https://yoursite.com/thanks"
                          />
                        </Field>
                        <Field label="If they back out">
                          <input
                            className="input"
                            value={payCancel}
                            onChange={(e) => setPayCancel(e.target.value)}
                            onBlur={() => payCancel !== payments.data?.payments.cancelUrl && savePayments({ cancelUrl: payCancel }, "Cancel URL")}
                            placeholder="https://yoursite.com/pricing"
                          />
                        </Field>
                      </div>
                      <p className="t-micro">
                        Stripe requires a destination after checkout. These must be pages you control — the app is local and cannot host a public one.
                      </p>
                    </div>
                  )}

                  <div className="mt-6 flex flex-wrap items-center gap-2">
                    <button
                      className="btn btn-glass btn-sm"
                      disabled={busy || payProvider === "none"}
                      onClick={() => runPayments(() => api.testPayments())}
                    >
                      {busy ? "Checking…" : "Test connection"}
                    </button>
                    <button
                      className="btn btn-accent btn-sm"
                      disabled={busy || payProvider !== "stripe"}
                      title={payProvider !== "stripe" ? "Only Stripe can be checked automatically" : "Ask Stripe what has been paid"}
                      onClick={() => runPayments(async () => {
                        const r = await api.syncPayments();
                        return { ok: r.ok, message: r.error ?? r.message };
                      })}
                    >
                      <IconInvoice size={13} />
                      Check for payments
                    </button>
                    {saved && <span className="chip chip-mint">{saved} saved</span>}
                  </div>

                  {payResult && (
                    <div className="mt-4">
                      <Notice tone={payResult.ok ? "success" : "danger"} title={payResult.ok ? "Provider confirmed" : "Could not confirm"}>
                        {payResult.text}
                      </Notice>
                    </div>
                  )}

                  {/*
                    Stated plainly because its absence looks like a bug: a server
                    bound to 127.0.0.1 has no public URL, and every provider pushes
                    payment events to one. Reconciliation here is pull-based.
                  */}
                  <p className="t-micro mt-6">
                    Payments are pulled, not pushed. A provider normally notifies you by calling a public webhook URL, which an app listening on your own
                    machine cannot provide — so the app asks what has been paid, either when you press the button above or from the invoice itself.
                  </p>
                </Panel>
              )}

              {section === "privacy" && (
                <>
                  {/*
                    Shown only when the server refused a read — which, with no
                    password set, it cannot do. So this appears exactly in the
                    case it is for: the server is protected and this browser has
                    not been told the password.
                  */}
                  {settings.error && (
                    <Panel
                      eyebrow="Privacy"
                      title="Unlock this browser"
                      hint="The server is protected, and this browser is not holding the password yet. Nothing is sent until you unlock, and a wrong password is not kept."
                    >
                      <div className="flex flex-wrap items-end gap-3">
                        <div className="min-w-[240px] flex-1">
                          <Field label="Admin password">
                            <input
                              className="input"
                              type="password"
                              value={unlockPw}
                              onChange={(e) => setUnlockPw(e.target.value)}
                              onKeyDown={(e) => e.key === "Enter" && unlockPw && void unlock()}
                              placeholder="the password this server was set up with"
                            />
                          </Field>
                        </div>
                        <button className="btn btn-glass btn-sm" disabled={!unlockPw} onClick={() => void unlock()}>
                          Unlock
                        </button>
                      </div>
                      <p className="t-micro mt-3">
                        The admin password unlocks these screens. Chat and the model catalog use the API password, which is set separately below — if
                        they differ, this browser will ask for that one when you open Chat.
                      </p>
                    </Panel>
                  )}

                  <Panel
                    eyebrow="Privacy"
                    title="Access control"
                    hint="Both passwords are optional. With neither set, only this machine can reach the server's endpoints; set one and a Bearer token is the only way in."
                  >
                    <div className="grid gap-5 sm:grid-cols-2">
                      <Field label="API password (Bearer for /v1 and /api/chat)">
                        <input
                          className="input"
                          type="password"
                          value={apiPassword}
                          onChange={(e) => setApiPassword(e.target.value)}
                          onFocus={() => setApiPwBase(apiPassword)}
                          onBlur={() => apiPassword !== apiPwBase && void savePassword("api", apiPassword, "API password")}
                          placeholder={settings.data?.hasApiPassword ? "set — type to replace, clear to remove" : "empty = local access only"}
                        />
                      </Field>
                      <Field label="Admin password (the screens above)">
                        <input
                          className="input"
                          type="password"
                          value={adminPassword}
                          onChange={(e) => setAdminPassword(e.target.value)}
                          onFocus={() => setAdminPwBase(adminPassword)}
                          onBlur={() => adminPassword !== adminPwBase && void savePassword("admin", adminPassword, "Admin password")}
                          placeholder={settings.data?.hasAdminPassword ? "set — type to replace, clear to remove" : "empty = local access only"}
                        />
                      </Field>
                    </div>
                    <p className="t-micro mt-3">
                      A password is stored server-side and in this browser, which is what lets the app keep working after you set one. The server
                      never sends a password back — it only reports whether one is set.
                    </p>
                    <div className="mt-5">
                      <Notice tone="info" title="What leaves this machine">
                        Conversations, files and keys stay local. The only outbound traffic is to the model provider you connected, plus the ad
                        network when it is enabled — nothing else.
                      </Notice>
                    </div>
                  </Panel>
                </>
              )}

              {section === "advanced" && (
                <>
                  <Panel eyebrow="Advanced" title="Ad inventory" hint="Ads are always on — that is what makes the agent free. These controls tune cadence and inventory rather than switching it off.">
                    <div className="grid gap-5 sm:grid-cols-2 xl:grid-cols-3">
                      <div className="sm:col-span-2 xl:col-span-3">
                        <label className="field-label">Card intensity</label>
                        <div className="seg mt-2 flex-wrap">
                          {(["relaxed", "steady", "aggressive", "maximum"] as const).map((k) => (
                            <button
                              key={k}
                              className="seg-item"
                              data-active={(earnPlan.data?.intensity ?? "relaxed") === k}
                              disabled={busy}
                              onClick={async () => {
                                setBusy(true);
                                try {
                                  await api.setAdIntensity(k);
                                  earnPlan.refresh();
                                  notifyDataChanged();
                                } catch (err) {
                                  setError(errorMessage(err));
                                } finally {
                                  setBusy(false);
                                }
                              }}
                            >
                              <span className="capitalize">{k}</span>
                            </button>
                          ))}
                        </div>
                        <p className="t-micro mt-2">
                          How often cards appear while the agent works. There is no off switch: ads are what make the agent free.
                        </p>
                      </div>
                      <Field label="Network">
                        <select
                          className="input"
                          value={ads?.network ?? "house"}
                          onChange={(e) => patchAds({ network: e.target.value as AdsSettings["network"] }, "Ad network")}
                        >
                          <option value="house">House — your own campaigns</option>
                          <option value="ethicalads">EthicalAds — real network revenue</option>
                          <option value="carbon">Carbon Ads — real network revenue</option>
                        </select>
                      </Field>
                      <Field label="EthicalAds publisher id">
                        <input
                          className="input"
                          defaultValue={ads?.ethicalAdsPublisherId ?? ""}
                          onBlur={(e) => e.target.value !== ads?.ethicalAdsPublisherId && patchAds({ ethicalAdsPublisherId: e.target.value }, "Publisher id")}
                          placeholder="your-publisher-id"
                        />
                      </Field>
                      <Field label="Carbon placement id">
                        <input
                          className="input"
                          defaultValue={ads?.carbonPlacementId ?? ""}
                          onBlur={(e) => e.target.value !== (ads?.carbonPlacementId ?? "") && patchAds({ carbonPlacementId: e.target.value }, "Carbon placement id")}
                          placeholder="CK…"
                        />
                      </Field>
                      <div className="sm:col-span-2 xl:col-span-3">
                        {/* A rejected publisher id used to be indistinguishable
                            from healthy delivery: serving simply fell back to
                            house campaigns and the screen still said "ads". */}
                        <Notice
                          tone={delivery.data?.delivery.networkStatus.reason === "ok" ? "success" : "info"}
                          title={
                            delivery.data?.delivery.network === "ethicalads"
                              ? `Network delivery — ${delivery.data.delivery.networkStatus.reason === "ok" ? "paid creative accepted" : delivery.data.delivery.networkStatus.reason.replace(/-/g, " ")}`
                              : "Network inventory is off"
                          }
                        >
                          <p>{delivery.data?.delivery.networkStatus.text ?? "No delivery report yet."}</p>
                          <p className="mt-2">
                            Network money needs an <strong>approved publisher account</strong> and a public page where the ad sits above the fold,
                            outside the reading flow — EthicalAds is invite-only, reviews the placement, and pays out at $50. Inline cards inside this
                            local desktop app do not qualify, so selling a campaign directly (Economy → Campaigns → Invoice advertiser) is the path
                            that pays you today.
                          </p>
                        </Notice>
                      </div>
                      <Field label="Fallback CPM (USD)">
                        <input
                          className="input num"
                          defaultValue={String(ads?.cpmUsd ?? 2)}
                          onBlur={(e) => patchAds({ cpmUsd: Number(e.target.value) || 2 }, "Fallback CPM")}
                        />
                      </Field>
                      <Field label="First ad after N tool steps">
                        <input
                          className="input num"
                          defaultValue={String(ads?.cadenceSteps ?? 3)}
                          onBlur={(e) => patchAds({ cadenceSteps: Number(e.target.value) || 3 }, "Cadence")}
                        />
                      </Field>
                      <Field label="Max ads per response">
                        <input
                          className="input num"
                          defaultValue={String(ads?.maxAdsPerResponse ?? 3)}
                          onBlur={(e) => patchAds({ maxAdsPerResponse: Number(e.target.value) || 3 }, "Ad cap")}
                        />
                      </Field>
                      <Field label="Click bonus (USD)">
                        <input
                          className="input num"
                          defaultValue={String(ads?.clickBonusUsd ?? 0.5)}
                          onBlur={(e) => patchAds({ clickBonusUsd: Number(e.target.value) || 0.5 }, "Click bonus")}
                        />
                      </Field>
                    </div>
                    <p className="t-micro mt-5">
                      Cadence tightens on its own when the balance is thin: at a balance under $1 the first card can appear a step earlier, and
                      under $0.25 it serves as often as the cap allows.
                    </p>
                  </Panel>

                  <Panel eyebrow="Advanced" title="Your own API" hint="The same deployment credential and the same ledger, for anything you point at this server.">
                    <div className="space-y-2.5">
                      {[
                        ["GET", "/v1/models", "OpenAI-compatible model list"],
                        ["POST", "/v1/chat/completions", "OpenAI-compatible completions (streaming supported)"],
                        ["POST", "/api/chat", "Agent endpoint with tool steps and inline ads (SSE)"],
                        ["GET", "/api/economy", "Ledger, funding status and delivery report"],
                        ["GET", "/api/bootstrap", "Zero-config readiness check"],
                      ].map(([method, path, note]) => (
                        <div key={path} className="flex flex-wrap items-center gap-3 rounded-[var(--r-md)] border border-[var(--border-1)] bg-[rgba(0,0,0,0.22)] px-3.5 py-2.5">
                          <span className="chip chip-muted h-[20px] px-2 text-[10px] uppercase tracking-[0.1em]">{method}</span>
                          <code className="mono text-[12.5px] text-[var(--text-1)]">{path}</code>
                          <span className="flex-1" />
                          <span className="t-micro">{note}</span>
                        </div>
                      ))}
                    </div>
                    <p className="t-micro mt-4">
                      Point any OpenAI SDK at <code className="mono">http://127.0.0.1:3777/v1</code>. If an API password is set, send it as{" "}
                      <code className="mono">Authorization: Bearer …</code>.
                    </p>
                  </Panel>
                </>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function Panel({ eyebrow, title, hint, children }: { eyebrow: string; title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section className="glass panel rise">
      <SectionHeading eyebrow={eyebrow} title={title} hint={hint} tight />
      {children}
    </section>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="field-label">{label}</label>
      {children}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-4 border-t border-[var(--border-1)] pt-3 first:border-0 first:pt-0">
      <span className="t-meta">{label}</span>
      <span className="num text-[13.5px] capitalize text-[var(--text-1)]">{value}</span>
    </div>
  );
}
