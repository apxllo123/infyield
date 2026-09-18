"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { ModelCard } from "@/components/cards";
import { EmptyState, ErrorState, Notice, SectionHeading, Skeleton } from "@/components/ui";
import { IconClose, IconCompass, IconPlus, IconSparkle, IconTrash } from "@/components/icons";
import { api, errorMessage, type UiModel } from "@/lib/client/api";
import type { ModelInfo, ProviderKind } from "@/lib/types";
import { notifyDataChanged, usePreferredModel, useResource } from "@/lib/client/store";
import { compactNumber, providerLabel } from "@/lib/client/format";

const PROVIDERS: { value: ProviderKind; label: string }[] = [
  { value: "openrouter", label: "OpenRouter (any model)" },
  { value: "openai", label: "OpenAI" },
  { value: "anthropic", label: "Anthropic" },
  { value: "google", label: "Google AI" },
  { value: "custom", label: "Custom (OpenAI-compatible URL)" },
];

export default function ExplorePage() {
  const router = useRouter();
  const models = useResource(() => api.models(), []);
  const custom = useResource(() => api.customModels(), []);
  const bootstrap = useResource(() => api.bootstrap(), []);
  const { modelId, choose } = usePreferredModel(models.data?.defaultModelId ?? null);

  const [adding, setAdding] = useState(false);
  const [filter, setFilter] = useState<"all" | "ready" | "unmetered">("all");
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState("");

  const [label, setLabel] = useState("");
  const [provider, setProvider] = useState<ProviderKind>("openrouter");
  const [upstream, setUpstream] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [priceIn, setPriceIn] = useState("1");
  const [priceOut, setPriceOut] = useState("2");

  useEffect(() => {
    if (!adding) setFormError("");
  }, [adding]);

  const list = useMemo(() => {
    const all = models.data?.models ?? [];
    if (filter === "ready") return all.filter((m) => m.available);
    if (filter === "unmetered") return all.filter((m) => m.unmetered);
    return all;
  }, [models.data, filter]);

  const refreshAll = () => {
    models.refresh();
    custom.refresh();
    bootstrap.refresh();
  };

  const submitModel = async () => {
    if (!label.trim() || !upstream.trim()) {
      setFormError("A display name and an upstream model id are required.");
      return;
    }
    setBusy(true);
    setFormError("");
    try {
      await api.addModel({
        label,
        provider,
        upstreamModel: upstream,
        baseUrl: baseUrl || undefined,
        priceIn: Number(priceIn) || 0,
        priceOut: Number(priceOut) || 0,
      });
      setLabel("");
      setUpstream("");
      setBaseUrl("");
      setAdding(false);
      refreshAll();
      notifyDataChanged();
    } catch (e) {
      setFormError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const removeModel = async (id: string) => {
    setBusy(true);
    try {
      await api.removeModel(id);
      refreshAll();
    } catch (e) {
      setFormError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-8">
      <SectionHeading
        eyebrow="Catalog"
        title="Explore models"
        hint="Every entry is served on the deployment's own credential and metered to the same ledger the ads credit. Add any OpenRouter id or a direct provider model — it joins the picker for everyone."
        action={
          <>
            <div className="seg hidden md:inline-flex">
              {(["all", "ready", "unmetered"] as const).map((f) => (
                <button key={f} className="seg-item capitalize" data-active={filter === f} onClick={() => setFilter(f)}>
                  {f === "ready" ? "Ready now" : f}
                </button>
              ))}
            </div>
            <button className="btn btn-primary btn-sm" onClick={() => setAdding((a) => !a)}>
              {adding ? <IconClose size={14} /> : <IconPlus size={14} />}
              {adding ? "Close" : "Add model"}
            </button>
          </>
        }
      />

      {bootstrap.data && !bootstrap.data.hasAnyKey && (
        <Notice
          tone="warn"
          title="Models are listed but nothing is servable yet"
          action={
            <Link href="/connections" className="btn btn-ghost btn-sm">
              View status
            </Link>
          }
        >
          This deployment has no provider credential, so nothing below can run. The credential is a server-side setting — the
          inline ads fund the usage once it is in place.
        </Notice>
      )}

      {/* -------------------------- add model --------------------------- */}
      {adding && (
        <div className="glass panel rise">
          <SectionHeading eyebrow="Bring your own" title="Add a model" hint="Any OpenRouter id (e.g. meta-llama/llama-4-maverick) or a direct provider model with its own base URL." tight />
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            <div>
              <label className="field-label">Display name</label>
              <input className="input" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Llama 4 Maverick" />
            </div>
            <div>
              <label className="field-label">Provider</label>
              <select className="input" value={provider} onChange={(e) => setProvider(e.target.value as ProviderKind)}>
                {PROVIDERS.map((p) => (
                  <option key={p.value} value={p.value}>
                    {p.label}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="field-label">Upstream model id</label>
              <input className="input" value={upstream} onChange={(e) => setUpstream(e.target.value)} placeholder="meta-llama/llama-4-maverick" />
            </div>
            <div>
              <label className="field-label">Base URL (custom only)</label>
              <input className="input" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://api.deepseek.com/v1" />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="field-label">In $/1M</label>
                <input className="input num" value={priceIn} onChange={(e) => setPriceIn(e.target.value)} />
              </div>
              <div>
                <label className="field-label">Out $/1M</label>
                <input className="input num" value={priceOut} onChange={(e) => setPriceOut(e.target.value)} />
              </div>
            </div>
          </div>
          <div className="mt-5 flex flex-wrap items-center gap-3">
            <button className="btn btn-accent btn-sm" onClick={submitModel} disabled={busy}>
              Add to catalog
            </button>
            <span className="t-micro">
              Prices are what the ledger meters against — set them to the provider&apos;s real rates, or 0 for a free endpoint.
            </span>
          </div>
          {formError && (
            <div className="mt-4">
              <Notice tone="danger" title="Couldn’t add that model">
                {formError}
              </Notice>
            </div>
          )}
        </div>
      )}

      {/* ---------------------------- grid ------------------------------ */}
      {models.error ? (
        <ErrorState body={models.error} onRetry={models.refresh} retrying={models.loading} />
      ) : models.loading && !models.data ? (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="glass panel">
              <Skeleton className="h-9 w-9 rounded-[var(--r-xs)]" />
              <Skeleton className="mt-4 h-4 w-2/3" />
              <Skeleton className="mt-3 h-3 w-1/3" />
              <Skeleton className="mt-4 h-3" />
              <Skeleton className="mt-2 h-3 w-4/5" />
            </div>
          ))}
        </div>
      ) : list.length ? (
        <div className="stagger grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {list.map((m: UiModel) => (
            <ModelCard
              key={m.id}
              model={m}
              width="full"
              active={m.id === modelId}
              onUse={() => {
                choose(m.id);
                router.push("/chat");
              }}
            />
          ))}
        </div>
      ) : (
        <EmptyState
          icon={<IconCompass size={18} />}
          title="Nothing matches that filter"
          body="Switch back to All to see the full catalog."
          action={
            <button className="btn btn-glass btn-sm" onClick={() => setFilter("all")}>
              Show all models
            </button>
          }
        />
      )}

      {/* ------------------------ custom models ------------------------- */}
      <section>
        <SectionHeading
          eyebrow="Operator"
          title="Models added here"
          hint="Your additions on top of the built-in catalog. Removing one takes it out of the picker everywhere."
        />
        {custom.loading && !custom.data ? (
          <div className="glass panel">
            <Skeleton className="h-4 w-40" />
            <Skeleton className="mt-4 h-3" />
            <Skeleton className="mt-2 h-3 w-2/3" />
          </div>
        ) : (custom.data?.models ?? []).length ? (
          <div className="glass panel p-2">
            {(custom.data?.models ?? []).map((m: ModelInfo) => (
              <div key={m.id} className="flex items-center gap-4 rounded-[var(--r-md)] px-4 py-3 transition-colors hover:bg-[rgba(255,255,255,0.035)]">
                <span className="grid h-8 w-8 shrink-0 place-items-center rounded-[var(--r-xs)] border border-[var(--border-1)] text-[var(--text-3)]">
                  <IconSparkle size={15} />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[13.5px] text-[var(--text-1)]">{m.label}</div>
                  <div className="t-micro mt-0.5 truncate">
                    {providerLabel(m.upstream.provider)} · {m.upstream.model} · {compactNumber(m.contextWindow)} ctx · ${m.priceIn.toFixed(2)}/${m.priceOut.toFixed(2)}
                  </div>
                </div>
                <button className="btn btn-quiet btn-sm btn-danger shrink-0" onClick={() => removeModel(m.id)} disabled={busy}>
                  <IconTrash size={14} />
                  Remove
                </button>
              </div>
            ))}
          </div>
        ) : (
          <EmptyState
            icon={<IconSparkle size={18} />}
            title="No custom models yet"
            body="The built-in catalog is always available. Anything you add here is metered and ad-funded exactly the same way."
            action={
              <button className="btn btn-glass btn-sm" onClick={() => setAdding(true)}>
                Add a model
              </button>
            }
            compact
          />
        )}
      </section>
    </div>
  );
}
