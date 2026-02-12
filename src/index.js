export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/") {
      return new Response(
        "OK. Use /cheapest (JSON) or /run (manual).",
        { headers: { "content-type": "text/plain; charset=utf-8" } }
      );
    }

    // Manual run from phone (useful for testing)
    if (url.pathname === "/run") {
      await runJob(env);
      return new Response("ran", { status: 200 });
    }

    // View cheapest list
    if (url.pathname === "/cheapest") {
      const id = env.DB.idFromName("main");
      const stub = env.DB.get(id);
      const data = await stub.fetch("https://do.local/get").then(r => r.json());
      return new Response(JSON.stringify(data, null, 2), {
        headers: { "content-type": "application/json; charset=utf-8" },
      });
    }

    return new Response("Not found", { status: 404 });
  },

  async scheduled(controller, env, ctx) {
    ctx.waitUntil(runJob(env));
  },
};

async function runJob(env) {
  // Put a SMALL allowlist here. Start with 5–20 URLs max.
  // Tip: choose product pages that contain JSON-LD Product/Offer.
  const targets = [
  { store: "altex", url: "https://altex.ro/televizor-oled-evo-smart-lg-65g53ls-ultra-hd-4k-hdr-164cm/cpd/UHDOLED65G53LS/" },
  { store: "emag", url: "https://www.emag.ro/televizor-lg-oled-evo-65g53ls-164-cm-smart-4k-ultra-hd-100-hz-clasa-e-model-2025-oled65g53ls/pd/DSMLL73BM/" },
  { store: "mediagalaxy", url: "https://mediagalaxy.ro/televizor-oled-evo-smart-lg-65g53ls-ultra-hd-4k-hdr-164cm/cpd/UHDOLED65G53LS/" },

  // replace with your filtered OLX search URL (after you set 65" filter in Safari)
  // { store: "olx", url: "PASTE_OLX_FILTERED_SEARCH_URL" },
];

  const offers = [];
  for (const t of targets) {
    try {
      const html = await fetch(t.url, {
        headers: {
          "user-agent": "Mozilla/5.0 price-hunter/1.0",
          "accept-language": "ro-RO,ro;q=0.9,en;q=0.8",
        },
      }).then(r => r.text());

      const jsonLd = extractJsonLd(html);
      const offer = pickOfferFromJsonLd(jsonLd);

      if (offer?.price != null) {
        offers.push({
          store: t.store,
          url: t.url,
          title: offer.title ?? null,
          priceRON: Number(offer.price),
          currency: offer.currency ?? "RON",
          ts: new Date().toISOString(),
        });
      }
    } catch (e) {
      // ignore target errors; don't fail the whole run
    }
  }

  offers.sort((a, b) => a.priceRON - b.priceRON);

  const payload = {
    offers,
    updatedAt: new Date().toISOString(),
  };

  const id = env.DB.idFromName("main");
  const stub = env.DB.get(id);
  await stub.fetch("https://do.local/put", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });

  // Optional: call Gemini here later for matching/normalization
  // but do NOT do it until extraction works and you have stable data.
}

function extractJsonLd(html) {
  const out = [];
  const re = /<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) {
    const raw = m[1].trim();
    try {
      out.push(JSON.parse(raw));
    } catch {}
  }
  return out;
}

function pickOfferFromJsonLd(arr) {
  // Loose heuristic: find Product -> offers -> price
  for (const obj of arr) {
    const list = Array.isArray(obj) ? obj : [obj];
    for (const node of list) {
      const type = node?.["@type"];
      const isProduct = type === "Product" || (Array.isArray(type) && type.includes("Product"));
      if (!isProduct) continue;

      const name = node?.name;
      const offers = node?.offers;
      const offer = Array.isArray(offers) ? offers[0] : offers;

      const price = offer?.price ?? offer?.lowPrice;
      const currency = offer?.priceCurrency;

      if (price != null) return { title: name, price, currency };
    }
  }
  return null;
}

// Durable Object for storage
export class DB {
  constructor(state, env) {
    this.state = state;
  }
  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === "/put") {
      const body = await request.json();
      await this.state.storage.put("data", body);
      return new Response("ok");
    }

    if (url.pathname === "/get") {
      const data = (await this.state.storage.get("data")) || { offers: [], updatedAt: null };
      return new Response(JSON.stringify(data), {
        headers: { "content-type": "application/json; charset=utf-8" },
      });
    }

    return new Response("not found", { status: 404 });
  }
}
