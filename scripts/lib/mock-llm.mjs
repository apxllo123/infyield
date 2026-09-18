/**
 * A mock OpenAI-compatible inference provider.
 *
 * What it proves and what it does not: it proves the *plumbing* — that a request
 * reaches an upstream, that the response streams back, that a provider-reported
 * cost reaches the ledger, and that the price ceiling and fallback policy travel
 * with the request. It proves nothing about a real model, so every instance
 * pointed at it reports `mode: simulated` and its figures are labelled as such.
 *
 * The reported cost is settable, which is the point: the suite can make the
 * provider charge something the catalog price table would *not* predict, and
 * then assert the ledger booked the provider's number rather than the estimate.
 *
 * Control surface (all JSON):
 *   POST /__mock/usage  { promptTokens, completionTokens, costUsd, omitCost }
 *   POST /__mock/fail   { status, body, count }  — the next `count` inference
 *                            requests fail (default 1). `count` exists because
 *                            an outage is not a single failed attempt: the
 *                            OpenAI SDK retries 5xx on its own, so a one-shot
 *                            failure is absorbed by a retry and never reaches
 *                            the caller. A real outage fails every attempt, and
 *                            only that is what the failure path should be
 *                            tested against.
 *   POST /__mock/reset
 *   GET  /__mock/log                            — every inference request seen
 */
import http from "node:http";

export function createMockLlm({ port = 0, content = "Mock reply from the simulated provider." } = {}) {
  let promptTokens = 1_200;
  let completionTokens = 320;
  let costUsd = 0.0042;
  // When true the usage chunk omits `cost`, so the server has to fall back to
  // the catalog calculation — which is how the suite tests the cost *method*.
  let omitCost = false;
  let failure = null;
  /** Every inference request, including the `provider` block the server sent. */
  const log = [];

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      const json = (status, body, headers = {}) => {
        res.writeHead(status, { "content-type": "application/json", ...headers });
        res.end(JSON.stringify(body));
      };

      if (url.pathname === "/__mock/usage") {
        const b = raw ? JSON.parse(raw) : {};
        if (typeof b.promptTokens === "number") promptTokens = b.promptTokens;
        if (typeof b.completionTokens === "number") completionTokens = b.completionTokens;
        if (typeof b.costUsd === "number") costUsd = b.costUsd;
        if (typeof b.omitCost === "boolean") omitCost = b.omitCost;
        return json(200, { ok: true, promptTokens, completionTokens, costUsd, omitCost });
      }
      if (url.pathname === "/__mock/fail") {
        const b = raw ? JSON.parse(raw) : {};
        failure = {
          status: Number(b.status) || 500,
          body: b.body ?? { error: { message: "Simulated upstream failure" } },
          remaining: Number.isFinite(Number(b.count)) && Number(b.count) > 0 ? Number(b.count) : 1,
        };
        return json(200, { ok: true, failure });
      }
      if (url.pathname === "/__mock/reset") {
        failure = null;
        log.length = 0;
        return json(200, { ok: true });
      }
      if (url.pathname === "/__mock/log") return json(200, { requests: log, failure });

      // ---------------- the inference endpoint ----------------
      let body = {};
      try {
        body = raw ? JSON.parse(raw) : {};
      } catch {
        return json(400, { error: { message: "invalid json" } });
      }
      log.push({
        path: url.pathname,
        model: body.model ?? null,
        stream: !!body.stream,
        hasTools: Array.isArray(body.tools) && body.tools.length > 0,
        toolNames: (body.tools ?? []).map((t) => t?.function?.name).filter(Boolean),
        // The block that carries the price ceiling and fallback policy. Asserting
        // on this is how the suite proves the economics travel with the request.
        provider: body.provider ?? null,
        authorization: req.headers.authorization ? "present" : "absent",
        // Recorded because omitting it is not cosmetic: without a cap an
        // aggregator sizes its affordability check against the model's maximum
        // output and refuses calls the account could serve. Asserting on this is
        // how the suite keeps that from silently regressing.
        maxTokens: body.max_tokens ?? null,
      });

      if (failure) {
        const f = failure;
        f.remaining -= 1;
        if (f.remaining <= 0) failure = null; // spent, so the next request is clean
        res.writeHead(f.status, { "content-type": "application/json" });
        return res.end(JSON.stringify(f.body));
      }

      const id = `chatcmpl-mock-${log.length}`;
      const created = Math.floor(Date.now() / 1000);
      const model = body.model ?? "mock";

      if (!body.stream) {
        return json(200, {
          id,
          object: "chat.completion",
          created,
          model,
          choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
          usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens, ...(omitCost ? {} : { cost: costUsd }) },
        });
      }

      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
      send({
        id,
        object: "chat.completion.chunk",
        created,
        model,
        choices: [{ index: 0, delta: { role: "assistant", content: content.slice(0, 24) }, finish_reason: null }],
      });
      send({
        id,
        object: "chat.completion.chunk",
        created,
        model,
        choices: [{ index: 0, delta: { content: content.slice(24) }, finish_reason: null }],
      });
      send({
        id,
        object: "chat.completion.chunk",
        created,
        model,
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        usage: {
          prompt_tokens: promptTokens,
          completion_tokens: completionTokens,
          ...(omitCost ? {} : { cost: costUsd }),
        },
      });
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });

  return {
    async start() {
      await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
      return server.address().port;
    },
    async stop() {
      await new Promise((resolve) => server.close(resolve));
    },
    /** The value the provider will next report as its real charge. */
    setCost(usd) {
      costUsd = usd;
    },
    get requests() {
      return log;
    },
  };
}
