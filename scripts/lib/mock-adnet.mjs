/**
 * A mock ad network.
 *
 * Implements the real decision/pixel contract documented in `src/lib/networks.ts`
 * — `link` (not `click_url`), `view_url`, `copy.headline`, `campaign_type: "paid"`
 * — so the code under test is the production code path, reached through an
 * overridable base URL that is environment-only.
 *
 * It exists to exercise the parts of the revenue lifecycle that need an external
 * party to behave in a particular way:
 *
 *   `campaign_type: "house"` → the network returned a creative it will not pay
 *                              for; the server must refuse it rather than book
 *                              revenue against it.
 *   `view_url` failing       → the network never recorded the impression, so no
 *                              revenue may be booked for it.
 *   `paid` + working pixel   → revenue books as PENDING, which is what the
 *                              network's own terms produce until it settles.
 *
 * Every figure it produces is simulated, and the server reports itself as
 * `mode: simulated` while pointed here.
 */
import http from "node:http";

export function createMockAdNet({ port = 0 } = {}) {
  let campaignType = "paid";
  let viewOk = true;
  let fill = true;
  const seen = { decision: 0, view: 0, click: 0, viewTime: 0 };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const json = (body) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    const pixel = () => {
      res.writeHead(viewOk ? 200 : 500, { "content-type": "image/gif" });
      res.end(Buffer.from("GIF89a"));
    };

    if (url.pathname.startsWith("/__mock/")) {
      const action = url.pathname.slice("/__mock/".length);
      const q = url.searchParams;
      if (action === "campaign-type") campaignType = q.get("value") ?? "paid";
      else if (action === "view") viewOk = q.get("ok") !== "0";
      else if (action === "fill") fill = q.get("ok") !== "0";
      else if (action === "reset") {
        campaignType = "paid";
        viewOk = true;
        fill = true;
        seen.decision = seen.view = seen.click = seen.viewTime = 0;
      }
      return json({ ok: true, campaignType, viewOk, fill, seen });
    }

    if (url.pathname.includes("/decision/")) {
      seen.decision += 1;
      if (!fill) {
        res.writeHead(204);
        return res.end();
      }
      return json({
        id: `mocknet-${seen.decision}`,
        copy: {
          headline: "Ship your database like your code",
          cta: "Try it free",
          content: "Branch, preview and roll back a Postgres database the same way you branch code.",
        },
        link: `http://127.0.0.1:${server.address().port}/proxy/click/mocknet-${seen.decision}/`,
        link_domain: "mock-database.example",
        view_url: `http://127.0.0.1:${server.address().port}/proxy/view/mocknet-${seen.decision}/`,
        view_time_url: `http://127.0.0.1:${server.address().port}/proxy/viewtime/mocknet-${seen.decision}/`,
        nonce: "mock-nonce",
        display_type: "text-v1",
        campaign_type: campaignType,
      });
    }
    if (url.pathname.includes("/proxy/view/")) {
      seen.view += 1;
      return pixel();
    }
    if (url.pathname.includes("/proxy/viewtime/")) {
      seen.viewTime += 1;
      return pixel();
    }
    if (url.pathname.includes("/proxy/click/")) {
      seen.click += 1;
      res.writeHead(302, { location: "https://mock-database.example/" });
      return res.end();
    }
    res.writeHead(404);
    res.end();
  });

  return {
    async start() {
      await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
      return server.address().port;
    },
    async stop() {
      await new Promise((resolve) => server.close(resolve));
    },
    decisionUrl() {
      return `http://127.0.0.1:${server.address().port}/api/v1/decision/`;
    },
    get seen() {
      return { ...seen };
    },
  };
}
