"use client";

import Link from "next/link";
import { ErrorState, Mark, Notice, SectionHeading, Skeleton, Stat } from "@/components/ui";
import { IconCheck, IconClose, IconLock, IconRefresh, IconSparkle, IconWallet, IconBolt } from "@/components/icons";
import { api } from "@/lib/client/api";
import { useResource } from "@/lib/client/store";
import { timeAgo, usd } from "@/lib/client/format";

/**
 * How Infyield is funded.
 *
 * This page used to be an onboarding flow: connect your OpenRouter account, or
 * paste a provider key. That was the wrong product. Infyield provides the AI and
 * pays the provider; the person using it pays nothing and needs no account. So
 * the page now reports the deployment's own state — which credential Infyield
 * holds, what funds the calls, and whether the ad pipeline is actually earning —
 * and offers no way to hand the app your own key, because there is no code path
 * that would use one.
 */
export default function ConnectionsPage() {
  const bootstrap = useResource(() => api.bootstrap(), []);
  const data = bootstrap.data;

  if (bootstrap.error) {
    return (
      <div className="space-y-10">
        <SectionHeading eyebrow="Funding" title="How Infyield is paid for" />
        <ErrorState
          title="Couldn't read the funding state"
          body="The server did not answer for its own provider and ad status."
          onRetry={bootstrap.refresh}
          retrying={bootstrap.loading}
        />
      </div>
    );
  }

  if (!data) {
    return (
      <div className="space-y-10">
        <SectionHeading eyebrow="Funding" title="How Infyield is paid for" />
        <div className="glass panel space-y-4">
          <Skeleton className="h-5 w-64" />
          <Skeleton className="h-3 w-48" />
          <Skeleton className="h-3 w-40" />
        </div>
      </div>
    );
  }

  const { mode, funding, fundingSnapshot: snap, providers, earn } = data;
  const configured = providers.filter((p) => p.configured);
  const missing = providers.filter((p) => !p.configured && p.envVars.length > 0);

  return (
    <div className="space-y-10">
      <SectionHeading
        eyebrow="Funding"
        title="How Infyield is paid for"
        hint="Infyield holds its own provider credential and pays the model bill. You are not asked for a key, and there is nowhere on this page to give one."
      />

      {mode.notice && (
        <Notice tone="warn" title={mode.simulated ? "Simulated run" : "Test mode"}>
          {mode.notice}
        </Notice>
      )}

      {/* ---------------------- provider credentials ---------------------- */}
      <section className="glass-strong panel sheen relative overflow-hidden">
        <div
          className="pointer-events-none absolute -right-24 -top-24 h-64 w-64 rounded-full"
          style={{
            background: "radial-gradient(circle at 50% 50%, rgba(53,224,161,0.18), transparent 70%)",
            filter: "blur(30px)",
          }}
        />
        <div className="relative flex flex-wrap items-start justify-between gap-6">
          <div className="flex items-start gap-4">
            <span className="grid h-12 w-12 shrink-0 place-items-center rounded-[var(--r-sm)] border border-[var(--border-2)] bg-[linear-gradient(160deg,rgba(255,255,255,0.14),rgba(255,255,255,0.03))]">
              <Mark size={26} />
            </span>
            <div>
              <div className="flex items-center gap-2.5">
                <h2 className="t-h2">Infyield&apos;s provider</h2>
                {configured.length > 0 ? (
                  <span className="chip chip-mint">
                    <IconCheck size={12} />
                    Connected
                  </span>
                ) : (
                  <span className="chip chip-amber">Not configured</span>
                )}
              </div>
              <p className="t-meta mt-2 max-w-[64ch]">
                {configured.length > 0
                  ? `Infyield pays for model calls from ${configured.map((p) => labelFor(p.provider)).join(", ")}. The credential lives in the server environment and never reaches this page, the browser, or the conversation.`
                  : "Infyield has no provider credential, so it cannot call a model. Nothing a user does can change that — it is a deployment setting."}
              </p>
            </div>
          </div>
          <button className="btn btn-glass btn-sm" onClick={bootstrap.refresh} disabled={bootstrap.loading}>
            <IconRefresh size={13} className={bootstrap.loading ? "animate-spin" : ""} />
            Refresh
          </button>
        </div>

        <div className="relative mt-7 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <Stat
            label="Models Infyield can serve"
            value={`${data.servableCount} of ${data.totalModels}`}
            tone={data.servableCount > 0 ? "mint" : undefined}
            hint={
              data.servableCount > 0
                ? "Every one of these runs on Infyield's account"
                : "No credential, so no model can run"
            }
          />
          <Stat
            label="Credential source"
            value={configured.length ? (configured[0].source === "env-file" ? "provisioning file" : "environment") : "—"}
            hint={configured.length ? "Server-side only" : "Nothing is set"}
          />
          <Stat
            label="Collectible ad revenue"
            value={usd(snap.confirmedRevenueUsd)}
            tone={snap.confirmedRevenueUsd > 0 ? "mint" : undefined}
            hint="Revenue somebody is on the hook to pay"
          />
          <Stat
            label="Provider budget"
            value={usd(snap.providerBudgetUsd, 2)}
            tone={snap.providerBudgetUsd > 0 ? "mint" : "amber"}
            hint={`Above the ${usd(snap.reserveUsd, 2)} reserve`}
          />
        </div>

        {configured.length === 0 && missing.length > 0 && (
          <div className="relative mt-7">
            <Notice tone="danger" title="AI provider is not configured">
              Set{" "}
              {missing.map((p, i) => (
                <span key={p.provider}>
                  {i > 0 ? " or " : ""}
                  <code className="mono">{p.envVars.join(" or ")}</code>
                </span>
              ))}{" "}
              in the environment the app runs in — or write it to{" "}
              <code className="mono">provider.env</code> in the app&apos;s data directory. Until then every model
              request is refused rather than failing somewhere upstream.
            </Notice>
          </div>
        )}

        <div className="relative mt-6 grid gap-2">
          {providers.map((p) => (
            <div
              key={p.provider}
              className="flex flex-wrap items-center gap-3 rounded-[var(--r-sm)] border border-[var(--border-1)] px-4 py-2.5"
            >
              <span className="text-[13.5px] text-[var(--text-1)]">{labelFor(p.provider)}</span>
              {p.configured ? (
                <span className="chip chip-mint">
                  <IconCheck size={12} />
                  {p.source === "env-file" ? "from provisioning file" : "from environment"}
                </span>
              ) : (
                <span className="chip chip-muted">
                  <IconClose size={12} />
                  no credential
                </span>
              )}
              {!p.configured && p.envVars.length > 0 && (
                <span className="t-micro">
                  set <code className="mono">{p.envVars.join(" or ")}</code>
                </span>
              )}
            </div>
          ))}
        </div>
      </section>

      {/* --------------------------- the funding -------------------------- */}
      <section>
        <SectionHeading
          eyebrow="Ad funding"
          title="What pays for the calls"
          hint="Advertising credits revenue; model calls debit spend. Every figure below comes from recorded events, never from an estimate of what might be earned."
        />

        <div className="glass panel">
          <div className="grid gap-5 sm:grid-cols-2 xl:grid-cols-4">
            <div>
              <div className="eyebrow">Pending revenue</div>
              <div className="num mt-1.5 text-[22px] text-[var(--text-1)]">{usd(snap.pendingRevenueUsd)}</div>
              <div className="t-micro mt-1">
                Network impressions the network has not settled. Never spendable.
              </div>
            </div>
            <div>
              <div className="eyebrow">Confirmed revenue</div>
              <div className="num mt-1.5 text-[22px] text-[var(--mint)]">{usd(snap.confirmedRevenueUsd)}</div>
              <div className="t-micro mt-1.5">Somebody is on the hook for this.</div>
            </div>
            <div>
              <div className="eyebrow">House inventory</div>
              <div className="num mt-1.5 text-[22px] text-[var(--text-3)]">{usd(snap.houseRevenueUsd)}</div>
              <div className="t-micro mt-1.5">
                Booked for delivery reporting only — no advertiser, so not money.
              </div>
            </div>
            <div>
              <div className="eyebrow">Provider spend</div>
              <div className="num mt-1.5 text-[22px] text-[var(--text-1)]">{usd(snap.spendUsd)}</div>
              <div className="t-micro mt-1.5">{usd(snap.spendTodayUsd)} of it today, from the ledger.</div>
            </div>
          </div>

          <div className="mt-6 border-t border-[var(--border-1)] pt-5">
            <div className="grid gap-5 sm:grid-cols-3">
              <div>
                <div className="eyebrow">Available operating</div>
                <div className="num mt-1.5 text-[19px] text-[var(--text-1)]">{usd(snap.availableOperatingUsd)}</div>
                <div className="t-micro mt-1">Collectible revenue minus spend and payouts.</div>
              </div>
              <div>
                <div className="eyebrow">Reserve</div>
                <div className="num mt-1.5 text-[19px] text-[var(--text-1)]">{usd(snap.reserveUsd, 2)}</div>
                <div className="t-micro mt-1">A floor that is never spent through.</div>
              </div>
              <div>
                <div className="eyebrow">Net</div>
                <div className="num mt-1.5 text-[19px] text-[var(--text-1)]">
                  {usd(snap.confirmedRevenueUsd - snap.spendUsd)}
                </div>
                <div className="t-micro mt-1">Confirmed revenue minus provider spend.</div>
              </div>
            </div>
          </div>

          <div className="mt-6 flex flex-wrap items-center gap-3 border-t border-[var(--border-1)] pt-5">
            <span className={`chip ${snap.health === "healthy" ? "chip-mint" : "chip-amber"}`}>
              <IconBolt size={12} />
              Funding {snap.health}
            </span>
            <span className="t-meta">{snap.reason}</span>
          </div>

          <div className="t-micro mt-5 space-y-1">
            <p>
              <strong className="text-[var(--text-3)]">Admission policy:</strong> a turn is only started when its
              predicted cost fits inside {usd(snap.policy.maxRequestCostUsd, 2)} per request and{" "}
              {usd(snap.policy.dailySpendCapUsd, 2)} per day, above the reserve. When revenue is thin the request is
              deferred with a reason instead of being allowed to overdraw.{" "}
              <Link
                href="/settings"
                className="text-[var(--text-3)] underline underline-offset-2 hover:text-[var(--text-1)]"
              >
                Settings
              </Link>{" "}
              shows the knobs.
            </p>
            {earn.placeholderUsd > 0 && (
              <p>
                <strong className="text-[var(--text-3)]">Note:</strong> {usd(earn.placeholderUsd)} of the booked
                revenue is house inventory with no advertiser behind it. It is recorded so delivery is measurable and
                it is excluded from every spendable figure — spending it would mean spending money nobody paid.
              </p>
            )}
          </div>
        </div>
      </section>

      {/* ---------------------------- the ads ----------------------------- */}
      <section>
        <SectionHeading
          eyebrow="Ad pipeline"
          title="Where the money comes from"
          hint="Ads appear between agent turns. An impression only becomes revenue after the provider that would pay for it accepts the event."
        />
        <div className="glass panel">
          <div className="flex flex-wrap items-center gap-3">
            <span className="grid h-9 w-9 place-items-center rounded-[var(--r-sm)] border border-[var(--border-1)] text-[var(--text-3)]">
              <IconWallet size={16} />
            </span>
            <div>
              <div className="text-[13.5px] text-[var(--text-1)]">Ad network and direct inventory</div>
              <div className="t-micro">
                {earn.backedCampaigns > 0
                  ? `${earn.backedCampaigns} campaign${earn.backedCampaigns === 1 ? "" : "s"} with a paying advertiser behind them.`
                  : "No campaign has a paying advertiser yet, so nothing served currently becomes collectible revenue."}
              </div>
            </div>
          </div>
          <div className="t-micro mt-5 space-y-1">
            <p>
              To turn delivery into money, either sell a campaign to a real advertiser — mark it advertiser-backed and
              issue the invoice on{" "}
              <Link
                href="/economy"
                className="text-[var(--text-3)] underline underline-offset-2 hover:text-[var(--text-1)]"
              >
                Economy → Campaigns
              </Link>{" "}
              — or connect an approved ad-network publisher account, which pays on its own schedule and needs a
              placement the network has approved.
            </p>
            <p>
              Both of those are outside the app: they need an advertiser or a network account that does not exist yet.
              Until one does, the ledger holds no collectible revenue and paid model requests are deferred rather than
              billed to anybody.
            </p>
          </div>
        </div>
      </section>

      <section>
        <SectionHeading eyebrow="Your own API" title="The same engine, over HTTP" />
        <div className="glass panel">
          <div className="t-meta space-y-2">
            <p>
              <code className="mono">POST /v1/chat/completions</code> and <code className="mono">GET /v1/models</code>{" "}
              are OpenAI-compatible and spend the same account. They are gated by the same funding policy, so a program
              cannot spend past what the ads earned either.
            </p>
            <p className="flex items-center gap-2">
              <IconLock size={13} className="text-[var(--text-3)]" />
              <span>
                Set a bearer password on{" "}
                <Link
                  href="/settings"
                  className="text-[var(--text-3)] underline underline-offset-2 hover:text-[var(--text-1)]"
                >
                  Settings
                </Link>{" "}
                to lock this surface down. No provider credential is ever sent to a client.
              </span>
            </p>
            <p className="flex items-center gap-2">
              <IconSparkle size={13} className="text-[var(--text-3)]" />
              <span>
                Last checked {timeAgo(Date.now()) === "now" ? "just now" : timeAgo(Date.now())}.{" "}
                <button className="underline underline-offset-2 hover:text-[var(--text-1)]" onClick={bootstrap.refresh}>
                  Re-check
                </button>
              </span>
            </p>
          </div>
        </div>
      </section>
    </div>
  );
}

function labelFor(provider: string): string {
  switch (provider) {
    case "openrouter":
      return "OpenRouter";
    case "openai":
      return "OpenAI";
    case "anthropic":
      return "Anthropic";
    case "google":
      return "Google AI";
    default:
      return provider;
  }
}
