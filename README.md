# Infyield — the free, ad-funded coding agent

A self-hosted, Freebuff-style AI coding agent. Users never see tokens, credits,
or API keys: the agent is free to use, and **inline text ads shown while the
agent works fund the upstream model spend** — the same model as
[Freebuff](https://github.com/CodebuffAI/freebuff) (Apache-2.0), whose ads
architecture this project intentionally mirrors (see `NOTICE`).

## How it works

```
user ──chat──> Next.js app (this repo)
               │
               ├─ Agent loop ── streams from upstream models with ONE SHARED CREDENTIAL
               │        │        (users never hold keys; the server spends its own)
               │        └─ inline "Ad" cards appear between tool steps
               │             └─ impressions/clicks credit the ledger (USD)
               │
               ├─ Own API: /v1/chat/completions + /v1/models
               │        (OpenAI-compatible; password optional)
               │
               └─ Admin console: models, campaigns, economy, settings
```

The economics: `ad revenue − API cost = net`. When net ≥ 0, usage is fully
self-funded. Every impression credits `CPM / 1000` and every click credits
`CPC` from that ad's campaign, while each model call debits its estimated
token cost against the model's `priceIn`/`priceOut` and the specific pool key
that served it (driving automatic least-spend rotation and monthly caps).

## Quick start

```bash
npm install
npm run dev        # http://localhost:3777
```

1. Give the server **one OpenRouter credential** — it alone unlocks the whole
   catalog (that's how the operator setup stays zero-config per chat, like
   Freebuff). Either export `OPENROUTER_API_KEY`/`INFYIELD_OPENROUTER_KEY`
   before starting, or use one-click connect in Settings. Direct provider
   credentials are optional and take priority when present.
2. Chat. While the agent works, inline ad cards appear between tool steps;
   impressions and clicks credit the economy ledger automatically.
3. Want models beyond the catalog? **Admin → Models** adds any OpenRouter id
   or direct provider model — funded by the same ads.

For production: `npm run build && npm start`, then set an **admin password**
and an **API password** in Admin → Settings (both are open by default for
local use only).

## macOS .app

A real native app (Electron shell around the production server — no terminal,
no dev mode):

```bash
./scripts/build-app.sh
open "release/Infyield-darwin-arm64/Infyield.app"
```

- **Everything is embedded in the one process.** The Next server is
  `require`d by Electron's main process — it is not spawned by a child
  process, so there is no second Dock tile (no stray "exec" icon) and nothing
  runs outside the bundle except Electron's own GPU/renderer helpers.
- The app picks the first free port from 3777 upward, so it never dies from a
  busy port, and ad/authorize links open in the real browser.
- Custom icon (`infyield-icon.jpg` → full-bleed `infyield-icon.icns`),
  single-instance lock.
- Runtime data lives in `~/Library/Application Support/Infyield/data`
  (`INFYIELD_DATA_DIR`), so the bundle stays read-only; data from the
  pre-rename AgentFuel install is migrated on first launch.
- The embedded server picks its port once at launch (first free from 3777
  upward). There is no retry after that: if the chosen port is later taken, the
  server stays down until relaunch.
- Install system-wide: `cp -R release/Infyield-darwin-arm64/Infyield.app /Applications/`

## How the ads actually pay you (operator playbook)

Two layers, both wired in:

### 1. Your own first-party network (built in, works offline)
- Admin → **Campaigns**: create campaigns with headline, one-line copy,
  destination URL, targeting keywords, CPM/CPC.
- The agent serves them contextually (matches keywords in recent conversation,
  top-3 lottery rotation, budget-aware) and the UI renders them exactly like
  the Freebuff CLI card: bold title, `Ad` disclosure, domain `↗` label.
- Impressions/clicks are server-acknowledged with idempotent event ids and
  credited to the ledger in USD. Real advertisers pay you directly under your
  own insertion order; the campaign rows are your delivery + reporting.

### 2. A real ad network (real money, no sales calls)
- Settings → Earn → network, then paste the credential:
  **EthicalAds** — publisher id (`ethicalAdsPublisherId`).
  [EthicalAds](https://www.ethicalads.io) pays CPM for developer-focused text
  ads; impressions book as *pending* until their statement reconciles.
  **Carbon** — placement id (`carbonPlacementId`), served via BuySellAds
  (`srv.buysellads.com/ads/<id>?json`); the fetch itself is the impression
  (serve-counted), clicks go through `statlink`, and creatives carry an icon.
- Both are implemented in `src/lib/networks.ts`. EthicalAds' decision API:
  `GET server.ethicalads.io/api/v1/decision/?publisher=…&ad_types=text-v1&
  format=json&keywords=…` returns a text creative with `copy` (headline/cta/
  content), `view_url` (the impression pixel) and `link` (the paid redirect —
  the field is `link`, not `click_url`; only `campaign_type: "paid"` creatives
  are accepted). We fire the pixel server-side on impression, route clicks
  through our tracked endpoint to the network's redirect, and fall back to
  house campaigns on any failure (no fill, offline, bad publisher id) so a
  slot is never blank. Whatever the network answered is recorded and shown in
  Settings and `/api/health` — a rejected id reads DEGRADED, never healthy.
- Reality check: at a $2–4 CPM, 1,000 agent responses with 3 ads each ≈
  $6–12/mo per active user — enough to cover a light user's tokens; heavy
  users or expensive models need volume, higher-CPU placements (the
  landing/"waiting room" slot like Freebuff's), or clicks (CPC $0.40–0.80).

### Where the money is actually accounted (Admin → Economy / Payouts)

Revenue is booked in two buckets, because that is how ad money really arrives:

| Bucket | Filled by | Can fund API spend? | Can be paid out? |
| --- | --- | --- | --- |
| **Confirmed** | first-party campaigns (advertisers pay you directly) + reconciled network revenue | yes | yes |
| **Pending** | network creatives the moment they render, at their eCPM | yes (it pays the model bill you already owe) | only after reconciliation |

- The flow is: ad renders → pending (network) or confirmed (direct) → you
  reconcile the network's statement (`Confirm $X pending`) → the money becomes
  confirmed → `Record payout` moves it to your labelled account. The ledger
  keeps every step, payouts can never exceed confirmed revenue, and nothing is
  double-counted.
- **Budget-adaptive cadence**: when the confirmed balance drops under $1 the
  ad scheduler tightens (first ad after 1–2 tool steps, tighter spacing, up to
  3 per response) and relaxes again when flush. Ads work harder exactly when
  they are needed.
- **Metered at the provider's own price, not ours.** Every model call debits the
  ledger, and when the provider states what it actually charged we use that
  figure. OpenRouter does: we ask for its usage accounting
  (`usage: {include: true}`) and prefer the reported `cost` over our price-table
  estimate, which on a real call overstated the charge by **25.7%**
  ($0.002940 estimated vs $0.00233794 charged upstream). Providers that report
  nothing fall back to the estimate (`estimateCostUsd`).

### The advertiser path: making booked revenue *collectible*

Booked revenue and revenue somebody will actually pay are two different things,
and only the second may buy model calls. A campaign becomes **backed** when a
paying advertiser is on record for it *and* an invoice has been issued:

```
impression served  → ledger books it            (booked / unbilled)
"Invoice advertiser" → AdvertiserAccount on the campaign + INV-YYYY-NNNN
                   → the same dollars become COLLECTIBLE
                   → the reserve tier can now spend them
"Unbilled"         → back to booked-only, the gate closes again
```

Economy → Campaigns raises the invoice for what the campaign **actually
delivered** (summed from the ledger, not a number anyone types), prints the
reference, terms and status, and shows the three figures side by side:
`Collectible` / `Unbilled` / `Booked total`. Marking an invoice `paid` records
the fact without changing a cent of the arithmetic.

> Placeholder inventory cannot sneak through: `src/lib/funds.ts` sums every
> ledger entry attributed to a backed campaign, so seeding demo campaigns can
> never unlock a real model. The gate reads that figure, not the ledger balance.

### Prove it yourself

```bash
npm test                                  # runs all four suites below, in order
node scripts/verify-ad-funding.mjs        # the product claim: no credential → refuse;
                                          # credential → ads fund paid models. 67 checks.
node scripts/verify-advertiser-path.mjs   # advertiser path, skills, thinking, attachments,
                                          # run_tests, who pays, settlement/overdue. 95 checks.
node scripts/verify-network-ads.mjs       # ad-network transport (live) + money safety. 26 checks.
node scripts/verify-funding-loop.mjs      # the ads ⇄ spend loop, end to end. 9 checks.
```

197 checks, and every suite exits non-zero on failure.

Every suite boots its **own** packaged server on its own port with a scratch data
dir, so none of them can write to a running install; set `INFYIELD_ALLOW_LIVE=1`
to point one at an existing instance on purpose.

All four now configure the instance the way the product is meant to be
configured — `OPENROUTER_API_KEY` in the process environment, which is the
deployment's own credential — and none of them registers a key of its own. That
is deliberate: "the caller supplies nothing" is a property worth asserting, so
`verify-funding-loop.mjs` fails if any client-supplied key appears, and
`verify-advertiser-path.mjs` section G proves the stronger version of the same
claim: the surface that used to accept a caller-supplied key is gone, no request
can add a credential, and the one in force is still the environment's.

The **ad-funded** suite is the one that tests the product claim itself, as two
configuration states rather than two code paths: an instance with **no**
provider credential must refuse every model call, name the exact missing
variable, and still serve ads; an instance with one must fund a priced model turn
out of advertising. It checks the price ceiling sent upstream, that fallbacks
only happen when the model's policy allows them, that an outage surfaces as an
error rather than a successful turn (and is retried the way the OpenAI SDK
retries it before being given up on), and that a reserve floor defers a request
instead of overdrawing.

The funding loop drives a real agent turn (with tool steps, so inline ad slots
open) against a running server, fires the impression and click endpoints twice
each to prove idempotency, then asserts the ledger against arithmetic — expected
spend from fixed token usage, credited revenue, and the balance identity.

The advertiser-path script covers the things that decide whether the app can
actually earn and what a turn does while it works: a locked reserve model
refusing with an actionable 402, a campaign being invoiced for exactly what it
delivered, the revenue flipping from unbilled to collectible, the reserve tier
unlocking, a read-only skill being served (and enforced) without any write tool,
reasoning effort reaching the upstream only on models that accept it, uploaded
files arriving as image/text parts, and `run_tests` detecting the project's own
command. Both stand a local OpenAI-compatible upstream in for OpenRouter so they
cost nothing and need no key; everything else is the app's own code path.

> Honest caveat: an out-of-the-box install serves *seeded house campaigns*
> (placeholder advertisers at `example.com`), so impressions credit the ledger
> without real money changing hands — and, because nothing is invoiced, they are
> excluded from what the reserve tier may spend. Real revenue needs a real
> advertiser (Economy → Campaigns → Invoice advertiser) or a live network
> publisher id — that is when the same numbers become collectible.

### Invoiced ≠ collected: settling an invoice

Booking revenue is one thing; getting paid is another. `paid` used to be a label
someone could set, which is worth nothing about whether the money arrived, so an
invoice is now **settled by its receipts** (`InvoicePayment`):

| State | Means | How it is reached |
| --- | --- | --- |
| `unpaid` | issued, inside its terms | default on issue |
| `partial` | money received, balance outstanding | a payment smaller than the balance |
| `overdue` | balance outstanding past `issuedAt + terms` | the due date passed (>=1 whole day) |
| `paid` | balance zero | payments adding up to the total |

- **Settlement is derived, never asserted.** `status`/`paidAt` are written *from*
the payments — `src/lib/ads.ts` `invoiceSettlement()` — so the flag cannot
disagree with the money.
- **Overpayments are refused**, naming the outstanding balance: a payment larger
than what is owed is almost always a typo, and accepting it would make the
receipt trail lie.
- **Receipts carry a date, method and reference**, so a receipt can be reconciled
against a bank statement; removing one walks the balance back up.
- **Due dates are day-granular.** Comparing raw timestamps made a prepaid invoice
read "not overdue" in the response that created it and "overdue" in the very next
request; an invoice is late once a whole day has passed.
- **Backdating is allowed, postdating is not** (`issuedAt` on the invoice form),
because entering an invoice days after it went out is normal and the due date has
to follow the real issue date.
- **Marking paid with no detail still works**, but records a receipt labelled
`marked paid` and reports `unbacked: true` — the balance is settled, the invoice
is never called late, and the chip reads `paid (unverified)` rather than
pretending a bank payment was verified.

Economy → Campaigns keeps a **receivables strip** (Invoiced / Collected /
Outstanding / Overdue) with the identity `invoiced = collected + outstanding`
pinned by the suite. Those are deliberately *not* the reserve tier's numbers:
the gate counts delivered impressions, because a typed-in invoiced total must
never be able to unlock spending on its own. Invoicing above what the ads accrued
is real money owed to you — it just is not spendable here until impressions back
it.

**Payments never touch the ledger.** The revenue was credited when the ads were
served; a payment settles a receivable, and double-counting it would invent money.
The suite asserts this (`recording a payment does not move the ledger`).

### Getting paid: a payment link, read back automatically

The rest of the economy is bookkeeping. This is the only part that can move money,
and it does it by handing the advertiser to a payment provider — the app never holds
funds, never sees a card number, and has no privileged view of your account.

**Settings → Payments** wires up how invoices get collected:

| Provider | What it does |
| --- | --- |
| `none` | nothing configured — invoices are settled by hand |
| `link` | a static payment URL (Stripe Payment Link, PayPal.me, Wise…) you already have |
| `stripe` | the app creates a **Checkout Session per invoice** for the exact outstanding balance, and reads paid sessions back from the API |

On an invoice, **Create payment link** raises a real payment page and hands you the
URL (with *Copy invoice email*, so the ask for money is one paste from the ledger that
earned it). With Stripe, pressing **Check for payments** asks what has been paid and
records the new transactions by itself — the receipt is not typed in.

Five things make that safe to run on a timer, and each is pinned by the suite:

1. **A local desktop app cannot receive webhooks.** Stripe pushes payment events to
a *public* HTTPS endpoint; a server bound to `127.0.0.1` has none. So reconciliation
is **pull-based** — the app asks. That is a property of running locally, not a
missing route (see the header of `src/lib/payments.ts`).
2. **Polling sees the same transaction repeatedly**, so every provider payment
carries its `externalId` (the Checkout Session id) and reconciliation refuses any
transaction already recorded *anywhere*, not merely on the invoice it targets.
3. **A mismatch is reported, never guessed at.** More money than the balance owes,
a foreign currency, or no invoice reference at all produces `needsAttention` with the
reason — and leaves the invoice exactly as it was. Correcting the reference lets the
same transaction through, which is what proves the check was the only obstacle.
4. **Raising a link needs a balance and a URL that can be trusted** — https only, and
Stripe needs a success URL, because the app is local and cannot host a public one.
5. **Settlement still follows the money.** A read-back receipt lands as
a `source: "stripe"` payment and the invoice settles itself; a static link's payment
must be recorded by hand, and the app says so rather than pretending it checked.

Three details worth knowing:

- **A restricted key (`rk_…`) is the right thing to paste**, and the app says so when
you paste a full `sk_…`: it only ever creates a Checkout Session and lists them. A
`pk_…` publishable key is refused by name instead of failing later with a confusing
401. The key is stored server-side and never returned by `/api/payments` *or*
`/api/settings`; both are asserted.
- **`INFYIELD_STRIPE_BASE_URL`** points the Stripe client at a different base — the
seam `scripts/lib/mock-stripe.mjs` uses. It is environment-only on purpose: no
request can aim a live install at a fake provider, because that would let it book
money that does not exist.
- **Removing a receipt frees the transaction.** The receipt *is* the idempotency
key, so deleting one and syncing again re-records it — the correct, self-healing
behaviour, and asserted rather than assumed.

### Zero-config key acquisition (no tokens, no per-chat setup)

- **Sponsored mode (Freebuff's model)**: the operator's credential lives
  server-side and is read directly by the credential layer. Set
  `INFYIELD_OPENROUTER_KEY` (or the conventional `OPENROUTER_API_KEY`) — also
  `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY` — and every user then
  chats with no setup, and the ads offset that bill. There is no key pool: a
  credential is the deployment's, and nothing a request sends can become one.
- **One-click connect (no key to own)**: Settings → **Connect OpenRouter** runs
  OpenRouter's documented OAuth+PKCE flow (`src/lib/connect.ts`): we send the
  browser to `openrouter.ai/auth` with a `code_challenge`, OpenRouter redirects
  back to `/api/connect/openrouter/callback?code=…`, and the server exchanges
  that code for a real credential at `/api/v1/auth/keys` and writes it to the
  server-side provisioning file. The UI polls `/api/bootstrap`, so the app lights
  up green on its own. "Use a code instead" covers the headless variant (no
  callback). The redirect is bound to the browser that started it: a `state`
  nonce is sent with the authorize URL and required back, and an `HttpOnly`
  cookie scoped to the connect path carries a second, independent secret that
  never appears in a URL — so a forged query string is refused even if the
  provider drops `state`. Both halves, and the rule that a flow is spent by its
  first callback attempt whatever the outcome, live in `completeOpenRouterRedirect`.
  PKCE still stands behind them (the code is only redeemable with our verifier),
  and the callback is reachable only from this machine — or from
  `INFYIELD_PUBLIC_ORIGIN`, which a proxied deployment sets to its own public
  address.
- A fresh install therefore needs **nothing** per chat: `runAutoSetup()` seeds
  ad inventory, reports what is missing, and only asks for a connection when no
  credential exists — and then it is one click, not a key paste.

#### Whose card is charged

There is one answer now, and it is not stored per key: the credential the server
holds from the environment (or from the OpenRouter connect flow) is the one that
pays, and it is the deployment's. That is why the ad-revenue gate applies to it —
and why it is no longer possible to connect an account and have the app report it
as "Sponsored": a request cannot supply a credential, so it cannot change who
pays. The reserve-tier gate therefore reads earned ad revenue, not a key's role.

Earlier builds kept a pool of keys with a `house`/`personal` role per key. It is
gone: nothing read it, and storing provider secrets for no functional gain is a
liability rather than a feature.

**So, plainly:** ads earn the ledger, and collected revenue is what funds the
credential the deployment holds. There is no `byok` mode and no `personal` key to
switch it back on — the app serves from one credential, which is the deployment's,
and `scripts/verify-advertiser-path.mjs` section G pins that down.

### The Freebuff mechanics this copies (Apache-2.0)

Read from their own `freebuff/SPEC.md` and ad modules, not inferred. The parts
that matter are architectural, and three of them are easy to get wrong.

**1. The free client is the paid client with the money stripped out.** Their
spec reuses the whole `cli/` package and builds with `FREEBUFF_MODE=true`, a
compile-time flag so the bundler dead-code-eliminates every paid branch. What
that removes (§4, §5) is not just the *billing* but the entire *dashboard*:
`/subscribe` and `/usage` are deleted commands — not disabled, removed — and
`UsageBanner`, `OutOfCreditsBanner`, `SubscriptionLimitBanner` and the credits
indicator in `MessageFooter` all render `null`.

**2. There is no user-side money at all.** This is the finding that matters
most, and it is explicit in §12: *"Ad impressions in FREE mode already don't
grant credits."* Free-mode agent+model combinations cost 0 credits server-side.
So an impression does not credit the person using the app — it never did. Ads
fund **Codebuff**, and the user's side of the bargain is simply that a
restricted set of models is free. There is no receivable, invoice, payout or
balance anywhere in their tree; their `packages/` are `agent-runtime`,
`code-map` and `llm-providers`, and no payment SDK appears in the repo.

**3. Ads are not a setting.** §7: ads are always enabled and cannot be
disabled, `/ads:enable` and `/ads:disable` are removed as commands, and the
only user-visible string is **"Ads are required in Free mode."** Their e2e test
asserts the output does *not* contain `+N credits`, `Hide ads`, or `/ads:enable`.

What Infyield takes from that:

- Normalized `AdResponse` shape (`adText/title/cta/url/clickUrl/impUrl`),
  provider-agnostic so several networks can share one card.
- Contextual targeting from sanitized message history (no file contents sent
  to advertisers).
- Impression ack with idempotent client event ids (`x-event-id` header), and a
  separate click path, because a render is not a click.
- Ads **always on**; they pay the deployment, never a user balance.
- Cadence driven by the agent's own state — completed tool steps, time since
  the last ad, whether one is already pending — not a timer. Enforced server
  side, because a client is not trusted with a frequency limit.
- Credentials live on the server, so a fresh install needs no per-chat setup.

### Where Infyield deliberately differs

Freebuff's free tier is a *subset* of a paid product, funded by a company's ad
revenue. Infyield is self-hosted and has nobody to bill, so it adds the layer
Freebuff does not need: a ledger that separates **pending** from **confirmed**
revenue, and a model router that sends a hard price ceiling and a completion cap
upstream so an aggregator cannot route a request somewhere more expensive than
the catalog priced.

What it deliberately does **not** copy from an earlier version of itself is a
gate that refused priced models until ad revenue existed. That rule made a fresh
install unusable — connect a real credential, confirm the key works against the
provider, and every request still refused — which is a cliff between "connected"
and "usable". Freebuff's server grants a model call at zero credits because
*their* provider account pays; the equivalent here is the deployment's own
credential, so ad revenue's job is to **cover** the bill, not to authorise each
call in advance. What still refuses: no credential, the emergency stop, the daily
and per-session caps, the per-request ceiling, and the **reserve tier**, which
stays earned from ad revenue.

So the ledger is a *measurement* as well as a record, and `funding.health` reads
`healthy` when ads cover the bill, `at-risk` when spend is running ahead of
revenue, and `blocked` only when nothing can pay or an operator brake is on.

What that buys: the coverage measurement, the ceiling, the completion cap, the
idempotent impression and the pending/confirmed split are all verified — 207
checks across five suites, all passing (`### Prove it yourself`). What it cannot
buy is an advertiser.

## Your own API (what you asked for: "make our own api")

Point any OpenAI-compatible client at this server:

```bash
curl http://localhost:3777/v1/models
curl http://localhost:3777/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"glm-5.3-flash","messages":[{"role":"user","content":"hi"}],"stream":true}'
```

- Clients authenticate with the single **API password** if you set one —
  there are no per-user tokens to run out of.
- The server translates the catalog id to the real upstream model and pays for
  it with the deployment's own credential, subject to the funding policy; usage
  is metered into the economy ledger per call.
- The chat UI itself uses `/api/chat` (SSE), which additionally streams tool
  steps and inline ads.

## What's in the box

- **Agent loop** (`src/lib/agent.ts`): multi-step tool use, per-step spend
  accounting, inline ad scheduling, 24-step guard.
- **Workspace tools** (`src/lib/tools.ts`): read/write/edit/list/search,
  `run_command` (per-call timeout, exit status reported) and **`run_tests`**,
  which detects the project's own command — npm/pnpm/yarn/bun `test`, else
  `typecheck`, else `tsc --noEmit`, pytest, `cargo test`, `go test ./...` — and
  says which it chose. Everything is path-contained to the workspace root.
- **Skills** (`src/lib/skills.ts`): eight built-in ways of working (build,
  debug, test-and-fix, review, explain, refactor, ship, performance). A skill
  carries both instructions *and* a tool allowlist, so **read-only skills have no
  write or run tools at all** — the allowlist is filtered before the request is
  sent and enforced again at execution, not merely requested in the prompt.
- **Attachments**: files attached in the composer are uploaded once to the data
directory (`/api/uploads`), and the transcript keeps only ids and metadata; the
  server inlines them per request — images as data-URL parts (OpenAI-compatible
  and Anthropic both), text files as fenced blocks with a manifest.
- **Thinking intensity**: Off / Low / Medium / High per conversation, sent as
  OpenRouter's `reasoning.effort` (or OpenAI's `reasoning_effort`) and withheld
  from models that would reject it — the control disables itself and says why.
- **Context meter**: the composer footer carries the model, thinking level,
  skills, attach, elapsed turn time and a ring that fills against the model's
  real context window (provider-reported tokens, labelled as an estimate only
  before the first metered call).
- **Credentials** (`src/lib/credentials.ts`): the deployment's own provider
  credential, read server-side from the environment or a `0600` provisioning
  file, never returned and never accepted from a request; missing means the
  request is refused, not faked.
- **Ads engine** (`src/lib/ads.ts`): campaigns, targeting, serve/ack, seeding.
- **Economy** (`src/lib/economy.ts`): USD ledger (ad revenue vs API spend).
- **UI**: a floating glass capsule for navigation (no sidebar), a command
  palette (⌘K), chat with `Worked · N steps`, markdown, inline AdCards, and a
  model picker carrying the Freebuff-style names incl. `unmetered` badges.

## The money is hidden, and that is deliberate

Infyield's visible surface is the agent. There is no balance, no spend figure, no
credits, no invoice queue in the navigation or on the home page — because
[Freebuff](https://github.com/CodebuffAI/freebuff) deliberately has none either.
Its `freebuff/SPEC.md` builds the whole product with a compile-time flag that
strips "paid features, subscription logic, **credits display**, and mode
switching": `UsageBanner`, `OutOfCreditsBanner`, `SubscriptionLimitBanner` and the
credits indicator in `MessageFooter` all render `null`, and `/usage`, `/credits`
and `/subscribe` are removed outright. Its ads behaviour is three lines — ads are
**always enabled**, cannot be disabled, and the only user-visible string is *"Ads
are required in Free mode."* Section 12 goes further: ad impressions in FREE mode
**don't grant credits at all**. There is no invoice, receivable or payout anywhere
in that tree; its `packages/` is only `agent-runtime`, `code-map` and
`llm-providers`.

So the rule this app follows is Freebuff's: **text ads are what make it free, and
the user does not watch the economics.**

| Visible | Hidden but working |
| --- | --- |
| Home, Chat, Explore, Library, Connections, Settings | Economy (the books, campaigns, payouts, receivables) |
| Inline sponsored cards between tool steps | Billing and Payments in Settings |
| The model picker, skills, thinking, attachments, the context ring | Payment links, provider config, settlement |
| Settings → Advanced → **Card intensity** (the one ad control) | The reserve-tier ladder and its gate |

The hidden half is not deleted. `/economy` is still a working route holding the
full ledger, campaigns, invoicing, settlement and payouts, and the ledger + ad
serving + funding all run exactly as before — the agent is still paid for. Add
`{ id: "economy" }` back to `ACTIONS` in `src/components/TopNav.tsx` and the two
entries back to `SECTIONS` in `src/app/settings/page.tsx` to restore it.

Two consequences worth being explicit about:

- **Ads cannot be turned off.** Freebuff deletes `/ads:enable` and `/ads:disable`
  and hardcodes `getAdsEnabled() === true`. Here the equivalent is that the only
  ad control left is *how hard the cards work* (relaxed → maximum), in
  Settings → Advanced, next to the cadence knobs. That panel says so: *"There is
  no off switch: ads are what make the agent free."*
- **A locked reserve model explains itself but does not quote a figure.** The
  picker says it needs ad revenue banked behind a connected key, and the model
  simply declines to start rather than being silently downgraded — but it will not
  tell you a balance, because the interface has nowhere to put one.

The honest exception: **per-key spend and its monthly cap stay on Connections.**
A runaway key is an operational problem, and removing the number would have
removed the safeguard with it.

## Interface

Seven routes, one design language: **Home** (cinematic hero + real card rails),
**Chat** (transcript, live step timeline, composer footer with model, thinking,
skills, attach, elapsed time and the context ring), **Explore** (model catalog +
add-your-own), **Library** (conversations and workspace files), **Connections**
(the deployment's credential and what funds it), **Economy** (balance, trend,
ledger, campaigns + invoicing, payouts), **Settings**.

- **Design system**: `src/app/globals.css` holds every token and composable
  class — ink/surface/border/text ramps, the radius set (`--r-xs` … `--r-2xl`),
  spacing, motion, and `.glass` / `.sheen` / `.seg` / `.chip` / `.btn-*` /
  `.t-*` / `.card-hover` / `.atmo-*`. Pages compose those rather than inventing
  local glass, shadows or radii, which is what keeps all seven routes visibly
  part of the same product.
- **Atmosphere**: each page floats on layered CSS only — drifting colour fields,
  a radially-masked grid, grain, scrim and vignette (`Atmosphere.tsx`). No image
  assets ship; the hero artifact (`HeroVisual.tsx`) is CSS + one inline SVG.
- **App icon**: `infyield-icon.svg` is the source of truth and
  `./scripts/build-icon.sh` rasterises it to `infyield-icon.icns` at all ten
  macOS sizes (on the Apple icon grid, so it sits correctly next to system
  icons). The glyph is the product's own four-point sparkle, so the Dock, the
  nav brand and the in-app icons share one identity. The app also reserves the
  native macOS title-bar band, so the traffic lights never overlap the nav.
- **Motion**: transitions and reveals respect `prefers-reduced-motion`, and
  Settings → Appearance has a **Calm** switch that keeps the layout identical
  while removing movement.
- **No fake UI**: every visible control either performs a real request or states
  that it is not configured yet. Balances, connection state and usage all come
  from the live ledger, never from placeholders.
- **Retired**: the old `Sidebar.tsx` and `AdminConsole.tsx` are gone — their
  functions moved to Explore (models), Connections (keys, OpenRouter) and
  Economy (campaigns, payouts, reconciliation).

## The reserve tier (heavy models, earned not given)

The catalog has two levels. The everyday models cost a fraction of a cent per
turn. The **reserve tier** — GPT Astra Pro, Claude Fable 5.1, Claude Opus 4.1,
o3 Pro, GPT-5 Pro, GPT-5.5 Pro and o1 Pro — are real OpenRouter ids at real list
prices (taken from OpenRouter's live `/api/v1/models`, not guessed), and one
representative multi-step turn on the top of that list costs more than hundreds
of ad impressions earn.

So they are **gated on earned revenue** rather than freely selectable. Each
declares `requiresBalanceUsd`; below it the router refuses with the shortfall
and the number of impressions needed to close it (HTTP 402 on both `/api/chat`
and `/v1/chat/completions`). They unlock as collectible revenue climbs — and
only that way, because there is no second credential that could pay instead.

**Economy → Earn** is the one place revenue is deliberately built up:

- set the balance you are saving towards (with `$4 / $12 / $40` presets matching
the tier thresholds), and watch the bar fill against the figure that actually
unlocks models;
- set **card intensity** — Relaxed → Maximum — one control that drives both cadence
and the per-reply cap, so earning faster is a single choice;
- see what each reserve model costs per turn and how many impressions unlock it.

### Collectible vs placeholder revenue (important)

Seeded first-party campaigns credit the ledger but have no advertiser behind
them, so that money will never arrive. Gating real spend on it would mean paying
a provider invoice out of revenue that does not exist.

The Earn panel therefore separates **collectible** revenue (a reconciled network,
or a campaign with a named advertiser and an issued/paid invoice) from
**placeholder** revenue, and the reserve gate is checked against *spendable* =
collectible − spend − payouts. Both halves are computed in `src/lib/funds.ts` by
summing **every** ledger entry attributed to a backed campaign — `getState()`
truncates its entry list to 50 for display, and a figure that stops growing once
a busy day pushes entries off the tail would under-report what an advertiser owes.

On a fresh install every reserve model is locked for exactly this reason, and the
panel says so rather than pretending otherwise: it names the unbilled campaigns
and points at Economy → Campaigns to invoice one. That is the whole path —
serving impressions books revenue, invoicing an advertiser makes it collectible,
and collectible revenue is the only money allowed to buy reserve-tier models.

### Honest economics

At a $2 CPM an impression earns $0.002, so ~2,000 impressions bank the $4 an
Astra Pro turn costs to unlock, and a single o1 Pro turn costs ~$25 — roughly
12,500 impressions. Ads comfortably fund the everyday catalog; the top of the
reserve tier needs sustained volume or higher-CPM advertisers. Actual spend is
always booked at the provider's own reported usage, never at these estimates.

There is no BYOK escape hatch from that arithmetic, and that is the point: the
user supplies no credential, so the only money that can pay a provider is money
the ads earned. If the reserve tier is out of reach, the honest answer is
"sell a better ad", not "connect your own key" — connecting one was the model
this build removed (see *Where Infyield deliberately differs*).

### What is verified, and what is blocked

Worth stating plainly, because the two are easy to confuse:

| | status |
| --- | --- |
| Server-owned credential, fail-closed without one | **verified** |
| A connected credential landing where the router reads it (hot reload, revocable) | **verified** |
| A **real paid model turn** on a real OpenRouter credential | **verified** — real request, real cost booked |
| Ad lifecycle, dedupe, pending → confirmed | **verified** |
| Real ad network reached (transport + field contract) | **verified** against EthicalAds |
| Money actually earned | **blocked** — needs an approved publisher id or a sold campaign |
| Ad revenue covering the bill | **blocked** — nothing collected yet, so `health` reads `at-risk` |

A publisher id is invite-only and requires the ad to sit above the fold on a
public page, which a local desktop app cannot satisfy. So the highest line that
can honestly be claimed without an account is the ones above: the machine calls
real models, books their real cost, and measures the gap the ads have to close —
and the revenue is not yet real. Every suite prints which side of that line it is
on, and the server reports `mode: simulated` whenever a mock is in the path.

## Routing & fallbacks (Freebuff-style)

Every catalog entry declares a chain: `upstream` + optional `fallbacks`. The
server resolves the chain from the credentials the *deployment* holds — one
OpenRouter credential serves the whole catalog, since OpenRouter routes on to
the direct providers — and serves from the first hop with a credential.
Fallbacks are only reachable when the model's own policy allows them, each hop
is announced in the transcript, and a request carries a hard price ceiling in
USD per million tokens so the aggregator cannot route it somewhere more
expensive than the ledger was funded for. A failed hop is retried the way the
OpenAI SDK retries it, and then reported as an error — never as a turn that
succeeded.

Ads also serve **budget-adaptively**: when the ledger balance dips below
$0.25 cadence tightens (down to every tool step), so the system actively
refills its own funding when it needs money, and relaxes when flush.

## Data & state

Everything persists as JSON in `.data/` (gitignored), written owner-only
(`0600`, because `settings.json` holds the Stripe secret key and the access
passwords): `economy.json`, `campaigns.json`, `settings.json`, `usage.json`, the
impression map and event idempotency, and — outside it, in the data directory —
`provider.env` with the deployment's credential. `economy.json` also carries a
monotonic `nextEntryId`, which is where ledger entry ids come from now; a file
written before that field existed is read as-is, falling back to one more than
the highest id it holds, so nothing needs migrating. Concurrent writers to one
file are serialized in-process by `withFileLock` — that lock is per process, not
per data directory, so swap `src/lib/store.ts` for Postgres/Redis to scale out
and keep impression/event state server-side and shared across instances.

## Attribution

Architecture and ad-card design intentionally follow
[CodebuffAI/freebuff](https://github.com/CodebuffAI/freebuff), studied from
its public Apache-2.0 sources. This project is an independent implementation
(Next.js app, original code) and carries the Apache-2.0 `LICENSE` and `NOTICE`
from the reference project as required by the license.
