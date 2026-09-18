"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import HeroVisual from "@/components/HeroVisual";
import { ConversationCard, FileTile, ModelCard, Rail, ViewAllLink } from "@/components/cards";
import { ErrorState, EmptyState, Notice, SectionHeading, Stat, CardSkeleton } from "@/components/ui";
import { IconArrowRight, IconChat, IconFolder, IconPlug } from "@/components/icons";
import { api } from "@/lib/client/api";
import { setActiveChatId, useChats, useMotionPref, usePoll, usePreferredModel, useResource } from "@/lib/client/store";

export default function HomePage() {
  const router = useRouter();
  const boot = useResource(() => api.bootstrap(), []);
  const models = useResource(() => api.models(), []);
  const workspace = useResource(() => api.workspace(), []);
  const { chats, ready } = useChats();
  const { modelId, choose } = usePreferredModel(models.data?.defaultModelId ?? null);
  useMotionPref();

  // The OpenRouter callback lands back on the origin root with ?connect=…
  const [connectNotice, setConnectNotice] = useState<{ tone: "success" | "danger"; title: string; body: string } | null>(null);
  const [awaitingApproval, setAwaitingApproval] = useState(false);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const status = params.get("connect");
    if (!status) return;
    if (status === "ok") {
      setConnectNotice({
        tone: "success",
        title: "OpenRouter connected",
        body: "The key is pooled server-side — every model in the catalog is live, supported by the inline ads.",
      });
      boot.refresh();
      models.refresh();
    } else {
      setConnectNotice({
        tone: "danger",
        title: "Connection didn’t complete",
        body: params.get("reason") || "OpenRouter didn’t return an authorization code. You can try again from Connections.",
      });
    }
    window.history.replaceState({}, "", window.location.pathname);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // If someone approves in the browser tab while this page is open, pick it up.
  usePoll(() => {
    boot.refresh();
    models.refresh();
  }, awaitingApproval);

  const recentChats = useMemo(() => [...chats].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 8), [chats]);
  const modelLabelById = useMemo(() => {
    const map = new Map<string, string>();
    for (const m of models.data?.models ?? []) map.set(m.id, m.label);
    return map;
  }, [models.data]);
  const catalog = useMemo(() => {
    const list = [...(models.data?.models ?? [])];
    return list.sort((a, b) => Number(b.available) - Number(a.available) || Number(b.unmetered) - Number(a.unmetered)).slice(0, 8);
  }, [models.data]);
  const files = (workspace.data?.entries ?? []).slice(0, 10);
  const funding = boot.data?.funding;
  const connected = !!boot.data?.hasAnyKey;

  const openChat = (id: string) => {
    setActiveChatId(id);
    router.push("/chat");
  };

  const todayLabel = funding?.mode === "sponsored" ? "Sponsored" : funding?.mode === "byok" ? "Your keys" : "Not funded";

  return (
    <div className="space-y-16">
      {connectNotice && (
        <Notice
          tone={connectNotice.tone}
          title={connectNotice.title}
          action={
            <Link href="/connections" className="btn btn-glass btn-sm">
              Open Connections
            </Link>
          }
        >
          {connectNotice.body}
        </Notice>
      )}

      {/* ============================ hero ============================ */}
      <section className="grid items-center gap-10 lg:grid-cols-[1.04fr_0.96fr] lg:gap-14">
        <div className="rise">
          <div className="eyebrow">Ad-funded coding agent</div>
          <h1 className="t-display mt-4">
            Your codebase,
            <br />
            with an agent that
            <br className="hidden sm:block" /> pays for itself.
          </h1>
          {/*
            The claim has to match whose card is being charged. With a house key
            the ads really do pay for the calls; with the user's own key their
            provider bills them, and the ads only build the ledger. Saying
            "no API keys on your side" to someone who just connected one is the
            kind of thing that makes the whole product read as fake.
          */}
          <p className="t-body mt-6 max-w-[52ch]">
            Infyield reads, edits and runs your project like a normal coding agent. The difference is the economics:{" "}
            {funding?.mode === "sponsored"
              ? "inline text ads support the included models, so there are no tokens to buy and no API keys on your side."
              : funding?.mode === "byok"
                ? "you connected your own provider key, so each call bills your account directly. The inline ads stay on regardless."
                : "connect a provider key and the whole catalog goes live. Inline text ads are what keep it free."}
          </p>

          <div className="mt-8 flex flex-wrap items-center gap-2.5">
            <Link href="/chat" className="btn btn-primary btn-lg">
              Start a conversation
              <IconArrowRight size={15} />
            </Link>
            <Link href="/explore" className="btn btn-glass btn-lg">
              Explore models
            </Link>
          </div>

          {/* Live state — every chip is real */}
          <div className="mt-8 flex flex-wrap items-center gap-2">
            <span className={`chip ${funding?.mode === "sponsored" ? "chip-mint" : funding?.mode === "byok" ? "" : "chip-amber"}`}>
              <span className={funding?.mode === "unfunded" ? "dot-idle" : "dot-live"} />
              {todayLabel}
            </span>
            {boot.data && (
              <span className="chip num" title={`${boot.data.servableCount} of ${boot.data.totalModels} models have a key. Reserve-tier models additionally need earned balance before they will run.`}>
                {boot.data.servableCount}/{boot.data.totalModels} models keyed
              </span>
            )}
            {/*
              No earnings or spend chip. Freebuff's spec removes the credits
              readout from every surface and states the rule in one line —
              "ads are required in Free mode" — so the economics are not
              something the interface reports while you work.
            */}
          </div>
        </div>

        <div className="rise hidden lg:block" style={{ animationDelay: "0.1s" }}>
          <HeroVisual />
        </div>
      </section>

      {boot.error && (
        <ErrorState
          title="Can’t reach the Infyield server"
          body={boot.error}
          onRetry={boot.refresh}
          retrying={boot.loading}
        />
      )}

      {boot.data && !connected && (
        <Notice
          tone="warn"
          title="One step to go live"
          action={
            <>
              <button
                className="btn btn-accent btn-sm"
                onClick={async () => {
                  const r = await api.connectAuthorize().catch(() => null);
                  if (r?.url) {
                    window.open(r.url, "_blank", "noopener,noreferrer");
                    setAwaitingApproval(true);
                  }
                }}
              >
                <IconPlug size={14} />
                Connect OpenRouter
              </button>
              <Link href="/connections" className="btn btn-glass btn-sm">
                Other options
              </Link>
            </>
          }
        >
          {awaitingApproval
            ? "Approve access in the browser tab that just opened — Infyield stores the credential server-side and this page updates on its own."
            : "Infyield needs its own provider credential to call a model. Authorise one OpenRouter account and the whole catalog unlocks — funded by the ads served while the agent works, not by anyone's personal key."}
        </Notice>
      )}

      {funding && funding.adPressure > 0 && funding.mode !== "unfunded" && (
        <Notice tone="info" title="Ads are serving harder right now">
          Ad revenue behind the models is thin, so cadence is tightened to refill it — up to {funding.adBudgetPerResponse} sponsored card
          {funding.adBudgetPerResponse === 1 ? "" : "s"} per reply, then it relaxes again.
        </Notice>
      )}

      {/* ========================= Continue =========================== */}
      <section className="section-tight">
        <SectionHeading
          eyebrow="Continue"
          title="Recent conversations"
          hint="Everything the agent has done on this machine, stored locally."
          action={<ViewAllLink href="/library" label="Open library" />}
        />
        {!ready ? (
          <Rail ariaLabel="Loading conversations">
            <CardSkeleton />
            <CardSkeleton />
            <CardSkeleton />
          </Rail>
        ) : recentChats.length ? (
          <Rail ariaLabel="Recent conversations">
            {recentChats.map((c) => (
              <ConversationCard key={c.id} chat={c} modelLabel={modelLabelById.get(c.modelId)} onOpen={() => openChat(c.id)} />
            ))}
          </Rail>
        ) : (
          <EmptyState
            icon={<IconChat size={18} />}
            title="No conversations yet"
            body="Start one and it lands here — with every file the agent touched and every sponsored card it served."
            action={
              <Link href="/chat" className="btn btn-glass btn-sm">
                Start chatting
              </Link>
            }
            compact
          />
        )}
      </section>

      {/* ========================== Models ============================ */}
      <section className="section-tight">
        <SectionHeading
          eyebrow="Catalog"
          title="Models ready to run"
          hint="One credential serves the whole catalog; each call is metered to the same ledger the ads credit."
          action={<ViewAllLink href="/explore" label="Explore all" />}
        />
        {models.loading && !models.data ? (
          <Rail ariaLabel="Loading models">
            <CardSkeleton />
            <CardSkeleton />
            <CardSkeleton />
          </Rail>
        ) : models.error ? (
          <ErrorState body={models.error} onRetry={models.refresh} retrying={models.loading} />
        ) : (
          <Rail ariaLabel="Model catalog">
            {catalog.map((m) => (
              <ModelCard
                key={m.id}
                model={m}
                active={m.id === modelId}
                onUse={() => {
                  choose(m.id);
                  router.push("/chat");
                }}
              />
            ))}
          </Rail>
        )}
      </section>

      {/*
        A "Where the money stands" section used to sit here: available balance,
        collectible revenue, AI spend, impressions/clicks, a ledger feed and a
        funding breakdown. That is the credits dashboard Freebuff's spec removes
        from every surface, so it is gone from the product's front page. The
        books still exist in full at /economy.
      */}

      {/* ======================== Workspace =========================== */}
      <section className="section-tight">
        <SectionHeading
          eyebrow="Workspace"
          title="What the agent can reach"
          hint={workspace.data?.root ? `Read and write access: ${workspace.data.root}` : "The folder the agent reads, edits and runs commands in."}
          action={<ViewAllLink href="/settings" label="Change folder" />}
        />
        {workspace.loading && !workspace.data ? (
          <Rail ariaLabel="Loading workspace">
            <CardSkeleton width="w-[212px]" height="h-[122px]" />
            <CardSkeleton width="w-[212px]" height="h-[122px]" />
            <CardSkeleton width="w-[212px]" height="h-[122px]" />
          </Rail>
        ) : files.length ? (
          <Rail ariaLabel="Workspace entries">
            {files.map((f) => (
              <FileTile key={f.name} entry={f} />
            ))}
          </Rail>
        ) : (
          <EmptyState
            icon={<IconFolder size={18} />}
            title={workspace.data?.exists ? "Nothing in that folder yet" : "No workspace folder yet"}
            body={workspace.data?.error || "Point Infyield at a project folder and its files appear here."}
            action={
              <Link href="/settings" className="btn btn-glass btn-sm">
                Set workspace root
              </Link>
            }
            compact
          />
        )}
        <p className="t-micro mt-3">Files are shown for reference — ask the agent to change them, and every step it takes is listed in the conversation.</p>
      </section>
    </div>
  );
}

function Line({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-4 border-t border-[var(--border-1)] pt-3 first:border-0 first:pt-0">
      <dt className="t-meta">{label}</dt>
      <dd className="num text-[13.5px] text-[var(--text-1)]">{value}</dd>
    </div>
  );
}
