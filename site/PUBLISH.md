# Publishing this site + applying to Carbon / EthicalAds

The site is three files (`index.html`, `writeup.html`, `style.css`), the icon,
and two UI screenshots in `img/`. No build step — GitHub Pages serves it as-is.

## 1. Publish to GitHub Pages (10 minutes)

```bash
# from the repo root
git checkout -b site            # or commit straight to main, your call
git add site/
git commit -m "Add GitHub Pages site for publisher applications"

# Option A — easiest: serve /site from main
git push origin site
# then on GitHub: repo → Settings → Pages →
#   Source: "Deploy from a branch", Branch: site, Folder: / (root)
#   → Save. Site goes live at https://apxllo123.github.io/infyield/ in ~1 min.

# Option B — serve /site from main with a path prefix
# (only if you'd rather keep everything on one branch):
#   move the three files + icon into /docs and select branch main, folder /docs
```

If you own a custom domain you can point it at Pages later
(Settings → Pages → Custom domain); the networks don't require it, but a
domain looks marginally more credible than `github.io` — either is fine to
apply with.

### Before you hit publish — three personalization touches

1. **GitHub link.** `index.html` links to `https://github.com/apxllo123/infyield`
   in two places (hero button + Links card). If the repo is private or named
   differently, fix both. If the repo is private, either make it public (best
   for the application — reviewers may click through) or change the button to
   link to the write-up instead and delete the "Source on GitHub" mention in
   the Links card.
2. **Write-up byline.** `writeup.html` says "by the Infyield maintainer" —
   put your name/handle there if you want.
3. **The repo must actually exist publicly if you link it.** Don't link a 404.

## 2. Apply to Carbon (carbonads.net)

Go to **carbonads.net/join**. The form asks:

| Field | What to put |
|---|---|
| Website URL | `https://apxllo123.github.io/infyield/` (or your custom domain) |
| Monthly traffic | Be honest — the "Less than 10,000" bracket exists. A brand-new site is fine; they approve on content quality and placement, not raw numbers. |
| Category / description | "Developer tools — open-source, ad-funded local AI coding agent for macOS. Site explains the product and the economics; the ad placement is above the fold on the home page." |
| Payment details | Standard W-9 / tax flow on approval. |

Review time: **5–7 business days**. A human checks that the placement is
visible above the fold on the submitted URL — that's what the `ad-slot` block
on `index.html` is for. Don't bury it, don't move it below the write-up link.

On approval you get a **placement id**. Paste it into Infyield:
**Settings → Earn → network: Carbon → placement id**, then save.
The app's server (`src/lib/networks.ts`) fetches
`srv.buysellads.com/ads/<id>?json` over HTTP/2, serves creatives with their
icon, and clicks go through their `statlink` — no extra code needed.

**Also keep the ad live on the site itself** (swap the placeholder div for
Carbon's snippet) — their placement policy expects the approved zone to exist
on the approved URL, and serving the placement *primarily* inside a desktop
app is a gray zone. Keep the site real and visible.

## 3. Apply to EthicalAds (ethicalads.io)

EthicalAds is **invite/review-based**: use the contact/publisher form on
ethicalads.io/publishers, or a warm intro (they're active on Hacker News and
in the Read-the-Docs ecosystem). Pitch it like this:

> Infyield is an open-source, ad-funded AI coding agent for macOS
> (Apache-2.0). The site explains the product and its honest-ledger ad
> economics; inventory is developer-focused and the placement is above the
> fold. Interested in joining the publisher network.

What to know before applying:

- Payout: roughly **$2.50 CPM**, paid at a **$50 minimum**.
- They review the actual site: content + a real placement (same `ad-slot`
  spot works).
- Their display policy leans on public-site inventory — same caveat as
  Carbon: keep the zone live on the site, don't let the desktop app be its
  only home.
- Publisher id goes into **Settings → Earn → network: EthicalAds →
  publisher id**. Impressions book as *pending* in Infyield until their
  statement reconciles; that's by design.

## 4. After approval — checklist

- [ ] Swap the placeholder `<div class="ad-slot">` in `index.html` for the
      network's embed snippet; commit and push.
- [ ] Paste the placement/publisher id into Settings → Earn in the app.
- [ ] Load the app once, watch `/api/health`: the network row should show
      the credential as active (not `NOT_CONFIGURED`, not `DEGRADED`).
- [ ] Serve a card in chat — it should now carry the advertiser's real link
      and book **pending** revenue instead of house placeholder.
- [ ] Keep the GitHub Pages site up. A dead approved site is the fastest way
      to lose the placement.

## 4b. Stripe payment pages (for advertiser checkout)

`payment-thanks.html` and `payment-cancelled.html` are the destinations Stripe
checkout sends advertisers to after they pay (or back out of) an invoice. Once
the site is live, their URLs — e.g.
`https://apxllo123.github.io/infyield/payment-thanks.html` — go into
**Settings → Payments → success URL / cancel URL** in the app, alongside the
Stripe restricted key (`rk_live_…`, created in Stripe → API keys → Restricted
keys with Checkout Session write + read scopes). The app then creates a
checkout session per invoice for the exact outstanding balance, and
**Check for payments** on Economy → Invoices reconciles paid sessions
directly from Stripe's API — no webhooks needed (a local app can't receive
them).

## 5. If you'd rather skip the networks entirely

The app's first-party path needs no website and no approval: Admin →
**Campaigns** → create a campaign with a real advertiser's headline/URL and
CPM, attach their invoice, mark it paid. Their impressions book as
**collectible** revenue immediately, which is what unlocks premium models.
One real advertiser at any CPM beats waiting in an approval queue.
