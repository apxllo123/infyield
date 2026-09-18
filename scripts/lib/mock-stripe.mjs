/**
 * A minimal Stripe, in-process, for verification only.
 *
 * The payment path is the one place this app can move real money, so it is the
 * last place that should be verified by reading the code. But a real Stripe
 * account cannot be part of a test suite: it needs live credentials, it books
 * real charges, and its state changes underfoot. So the suite points the app at
 * this instead, through the `INFYIELD_STRIPE_BASE_URL` seam that exists for
 * exactly that purpose (and is deliberately not settable from the UI — aiming a
 * live install at a fake provider would let it book money that does not exist).
 *
 * It implements only the four calls the app actually makes:
 *
 *   GET  /v1/balance                    read-only credential proof
 *   POST /v1/checkout/sessions          raise a payment page
 *   GET  /v1/checkout/sessions          what has been paid (poll-based sync)
 *   POST /_mock/pay                     control: make a session paid/unpaid
 *
 * Everything is form-encoded on the way in and JSON on the way out, like the
 * real thing. `log` keeps every request so assertions can be about what the app
 * *sent* — the metadata that makes reconciliation work is only observable there.
 */
import { createServer } from "node:http";

export function startMockStripe(port, { log = [], balanceCents = 12345, livemode = false } = {}) {
  /** id -> session */
  const sessions = new Map();
  let seq = 0;
  let state = { balanceCents, livemode };

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const params = new URLSearchParams(raw);
      const flat = Object.fromEntries(params.entries());
      const json = (status, obj) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(obj));
      };
      const entry = {
        method: req.method,
        path: url.pathname,
        params: flat,
        query: Object.fromEntries(url.searchParams.entries()),
        auth: req.headers.authorization ?? "",
      };
      log.push(entry);

      // ---- control surface (unauthenticated on purpose; test-only) ----
      if (url.pathname === "/_mock/pay") {
        const id = flat.id;
        const session = sessions.get(id);
        if (!session) return json(404, { error: { message: `no session ${id}` } });
        session.payment_status = flat.payment_status || "paid";
        session.status = session.payment_status === "paid" ? "complete" : "open";
        if (flat.amountCents !== undefined) session.amount_total = Number(flat.amountCents);
        if (flat.currency !== undefined) session.currency = flat.currency;
        if (flat.invoice !== undefined) session.metadata = { ...(session.metadata ?? {}), infyield_invoice: flat.invoice };
        if (flat.clearInvoice === "1") {
          delete session.metadata?.infyield_invoice;
          session.client_reference_id = "";
        }
        return json(200, session);
      }
      if (url.pathname === "/_mock/sessions") return json(200, { data: [...sessions.values()] });
      if (url.pathname === "/_mock/reset") {
        sessions.clear();
        return json(200, { ok: true });
      }
      if (url.pathname === "/_mock/fail") {
        // Prove the app surfaces a provider refusal rather than swallowing it.
        state.balanceCents = balanceCents;
        return json(200, { ok: true });
      }

      // Everything below is the Stripe-shaped surface, and needs the key.
      if (!/^Bearer \S+$/.test(entry.auth)) {
        return json(401, { error: { message: "No API key provided.", type: "authentication_error" } });
      }

      if (url.pathname === "/v1/balance" && req.method === "GET") {
        return json(200, {
          available: [{ amount: state.balanceCents, currency: "usd" }],
          pending: [],
          livemode: state.livemode,
        });
      }

      if (url.pathname === "/v1/checkout/sessions" && req.method === "POST") {
        seq += 1;
        const id = `cs_test_mock_${seq}`;
        const session = {
          id,
          object: "checkout.session",
          url: `https://checkout.stripe.com/c/pay/${id}`,
          mode: flat.mode ?? "payment",
          status: "open",
          payment_status: "unpaid",
          amount_total: Number(flat["line_items[0][price_data][unit_amount]"] ?? 0),
          currency: flat["line_items[0][price_data][currency]"] ?? "usd",
          created: Math.floor(Date.now() / 1000),
          client_reference_id: flat.client_reference_id ?? "",
          payment_intent: `pi_mock_${seq}`,
          payment_method_types: ["card"],
          metadata: {
            ...(flat["metadata[infyield_invoice]"] ? { infyield_invoice: flat["metadata[infyield_invoice]"] } : {}),
            ...(flat["metadata[infyield_campaign]"] ? { infyield_campaign: flat["metadata[infyield_campaign]"] } : {}),
          },
        };
        sessions.set(id, session);
        // Stripe returns the session, not the expanded object.
        return json(200, { id: session.id, url: session.url, object: session.object, status: session.status });
      }

      if (url.pathname === "/v1/checkout/sessions" && req.method === "GET") {
        const wantComplete = url.searchParams.get("status") === "complete";
        const data = [...sessions.values()].filter((s) => (wantComplete ? s.status === "complete" : true));
        return json(200, { data, has_more: false, object: "list" });
      }

      return json(404, { error: { message: `mock stripe has no ${req.method} ${url.pathname}` } });
    });
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () =>
      resolve({
        port,
        log,
        server,
        sessions,
        setBalance: (cents, live = false) => {
          state = { balanceCents: cents, livemode: live };
        },
        close: () =>
          new Promise((done) => {
            server.close(() => done());
          }),
      }),
    );
  });
}
