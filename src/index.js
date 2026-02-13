export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "access-control-allow-origin": "*",
          "access-control-allow-methods": "GET,POST,OPTIONS",
          "access-control-allow-headers": "content-type",
          "access-control-max-age": "86400",
        },
      });
    }

    if (url.pathname === "/") {
      return new Response(
        "OK. Use /cheapest (JSON), /run (manual), /api/search?q=... (search).",
        { headers: { "content-type": "text/plain; charset=utf-8" } }
      );
    }

    if (url.pathname === "/run") {
      await runJob(env);
      return new Response("ran", { status: 200 });
    }

    if (url.pathname === "/cheapest") {
      const id = env.DB.idFromName("main");
      const stub = env.DB.get(id);
      const data = await stub.fetch("https://do.local/get").then((r) => r.json());
      return new Response(JSON.stringify(data, null, 2), {
        headers: {
          "content-type": "application/json; charset=utf-8",
          "access-control-allow-origin": "*",
        },
      });
    }

    if (url.pathname === "/api/search") {
      const q = url.searchParams.get("q")?.trim();
      if (!q) {
        return new Response(JSON.stringify({ error: "missing q" }, null, 2), {
          status: 400,
          headers: {
            "content-type": "application/json; charset=utf-8",
            "access-control-allow-origin": "*",
          },
        });
      }

      const result = await searchAll(env, q);
      return new Response(JSON.stringify(result, null, 2), {
        headers: {
          "content-type": "application/json; charset=utf-8",
          "access-control-allow-origin": "*",
        },
      });
    }

    return new Response("Not found", { status: 404 });
  },

  async scheduled(controller, env, ctx) {
    ctx.waitUntil(runJob(env));
  },
};
/* -----------------------------
   PART A: Your existing scraper
   ----------------------------- */

async function runJob(env) {
  const targets = [
    {
      store: "altex",
      url: "https://altex.ro/televizor-oled-evo-smart-lg-65g53ls-ultra-hd-4k-hdr-164cm/cpd/UHDOLED65G53LS/",
    },
    {
      store: "emag",
      url: "https://www.emag.ro/televizor-lg-oled-evo-65g53ls-164-cm-smart-4k-ultra-hd-100-hz-clasa-e-model-2025-oled65g53ls/pd/DSMLL73BM/",
    },
    {
      store: "mediagalaxy",
      url: "https://mediagalaxy.ro/televizor-oled-evo-smart-lg-65g53ls-ultra-hd-4k-hdr-164cm/cpd/UHDOLED65G53LS/",
    },
  ];

  const offers = [];
  const debug = { tried: 0, ok: 0, failed: 0, errors: [] };

  for (const t of targets) {
    debug.tried++;
    try {
      const resp = await fetch(t.url, {
        headers: {
          "user-agent": "Mozilla/5.0 price-hunter/1.0",
          "accept-language": "ro-RO,ro;q=0.9,en;q=0.8",
        },
      });

      if (!resp.ok) {
        debug.failed++;
        debug.errors.push({ store: t.store, reason: "http_" + resp.status });
        continue;
      }

      const html = await resp.text();

      const jsonLd = extractJsonLd(html);
      let offer = pickOfferFromJsonLd(jsonLd);

      if (!offer?.price) offer = pickPriceFromMeta(html) || offer;
      if (!offer?.price) offer = pickPriceFromPatterns(html) || offer;

      if (!offer?.price) {
        debug.failed++;
        debug.errors.push({ store: t.store, reason: "no_price_found" });
        continue;
      }

      debug.ok++;

      const title = offer.title || offer.name || "";
      const priceRON = toNumberRON(offer.price);

      const base = {
        store: t.store,
        url: t.url,
        title: title || null,
        priceRON,
        currency: offer.currency || "RON",
        ts: new Date().toISOString(),
        build: "gemini-safe-v2",
      };

      // Gemini enrichment (must not block saving the offer)
      try {
        const ck = stableKeyFromTitle(title);

        let norm = await getCachedNorm(env, ck);
        if (!norm) {
          norm = await geminiNormalizeTitle(env, title);
          if (norm) await putCachedNorm(env, ck, norm);
        }

        base.canonical = norm?.canonical_name ?? null;
        base.productKey = norm?.product_key ?? null;
        base.brand = norm?.brand ?? null;
        base.modelFamily = norm?.model_family ?? null;
        base.modelCode = norm?.model_code ?? null;
        base.sizeInch = norm?.size_inch ?? null;
      } catch (e) {
        base.geminiError = String(e?.message || e);
      }

      offers.push(base);
    } catch (e) {
      debug.failed++;
      debug.errors.push({ store: t.store, reason: String(e?.message || e) });
    }
  }

  offers.sort((a, b) => a.priceRON - b.priceRON);

  const payload = {
    offers,
    updatedAt: new Date().toISOString(),
    debug,
  };

  const id = env.DB.idFromName("main");
  const stub = env.DB.get(id);

  await stub.fetch("https://do.local/put", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
}

function extractJsonLd(html) {
  const out = [];
  const re =
    /<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi;
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
  for (const obj of arr) {
    const list = Array.isArray(obj) ? obj : [obj];
    for (const node of list) {
      const type = node?.["@type"];
      const isProduct =
        type === "Product" || (Array.isArray(type) && type.includes("Product"));
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

function pickPriceFromMeta(html) {
  const m = html.match(
    /property="(?:og:price:amount|product:price:amount)"\s+content="([\d.]+)"/i
  );
  if (m) return { title: null, price: m[1], currency: "RON" };
  return null;
}

function pickPriceFromPatterns(html) {
  const m = html.match(/"price"\s*:\s*"?(?<p>\d+(?:[.,]\d+)?)"?/i);
  if (m?.groups?.p) {
    const p = m.groups.p.replace(",", ".");
    return { title: null, price: p, currency: "RON" };
  }
  return null;
}

function toNumberRON(p) {
  if (p == null) return NaN;
  const s = String(p).trim().replace(",", ".");
  const n = Number(s);
  return Number.isFinite(n) ? n : NaN;
}

/* --------------------------------
   PART B: Search API (/api/search)
   - pricy.ro (scrape)
   - mobilissimo RSS (read)
   - coupons (promo-codes.ro basic)
   - gemini summary (optional)
   -------------------------------- */

async function searchAll(env, q) {
  const debug = { q, steps: [], errors: [] };

  const [pricy, mobilissimo] = await Promise.all([
    searchPricy(q).catch((e) => ({ error: String(e?.message || e), items: [] })),
    fetchMobilissimoRss(q).catch((e) => ({ error: String(e?.message || e), items: [] })),
  ]);

  debug.steps.push({
    name: "pricy",
    ok: !pricy.error,
    count: pricy.items?.length ?? 0,
    error: pricy.error ?? null,
  });

  debug.steps.push({
    name: "mobilissimo_rss",
    ok: !mobilissimo.error,
    count: mobilissimo.items?.length ?? 0,
    error: mobilissimo.error ?? null,
  });

  // derive domains from pricy item links
  const domains = new Set();
  for (const it of pricy.items || []) {
    try {
      domains.add(new URL(it.link).hostname.replace(/^www\./, ""));
    } catch {}
  }

  // coupons (very basic: site search on promo-codes.ro)
  const coupons = [];
  for (const d of [...domains].slice(0, 5)) {
    coupons.push(await fetchCouponsPromoCodes(d));
  }

  // Gemini summary (optional)
  const summary = await geminiSummarize(env, { q, pricy, mobilissimo, coupons });

  return {
    q,
    pricy,
    mobilissimo,
    coupons,
    summary,
    ts: new Date().toISOString(),
    debug,
  };
}

// --- Pricy scraper (heuristic; may need tuning)
// --- Pricy scraper (improved: only real product links + better titles)
async function searchPricy(q) {
  const queryUrl = `https://www.pricy.ro/productsv2/magazin-storel.ro/generic-color-verde?q=${encodeURIComponent(
    q
  )}`;

  const resp = await fetch(queryUrl, {
    headers: {
      "user-agent": "Mozilla/5.0",
      "accept-language": "ro-RO,ro;q=0.9",
    },
  });

  if (!resp.ok) return { error: `pricy_http_${resp.status}`, queryUrl, items: [] };

  const html = await resp.text();

  const items = [];
  const re = /href="([^"]+)"[\s\S]{0,500}?(\d[\d.\s]{2,})\s*lei/gi;

  let m;
  while ((m = re.exec(html)) && items.length < 80) {
    const hrefRaw = m[1] || "";
    const priceRON = parseInt(m[2].replace(/\s+/g, "").replace(/\./g, ""), 10);
    if (!Number.isFinite(priceRON) || priceRON <= 0) continue;

    // Normalize absolute link
    const link = hrefRaw.startsWith("http")
      ? hrefRaw
      : new URL(hrefRaw, "https://www.pricy.ro").toString();

    // Keep ONLY product pages (Pricy uses /ProductUrlId/<id>/<slug>)
    // This removes min-price/max-price links and other navigation pages.
    const u = safeUrl(link);
    if (!u) continue;
    if (u.hostname !== "www.pricy.ro" && u.hostname !== "pricy.ro") continue;

    const isProduct = u.pathname.includes("/ProductUrlId/");
    if (!isProduct) continue;

    // Extract title from URL slug (last path segment after id)
    // Example: /ProductUrlId/12345/lg-oled-65g53ls
    const title = titleFromPricyPath(u.pathname);

    items.push({ title, link: u.toString(), priceRON });
  }

  // Deduplicate by link, keep cheapest
  const bestByLink = new Map();
  for (const it of items) {
    const prev = bestByLink.get(it.link);
    if (!prev || it.priceRON < prev.priceRON) bestByLink.set(it.link, it);
  }

  const out = [...bestByLink.values()]
    .sort((a, b) => a.priceRON - b.priceRON)
    .slice(0, 10);

  return { queryUrl, items: out };
}

function safeUrl(s) {
  try {
    return new URL(s);
  } catch {
    return null;
  }
}

function titleFromPricyPath(pathname) {
  const parts = (pathname || "").split("/").filter(Boolean);
  // find "ProductUrlId" index
  const idx = parts.findIndex((p) => p === "ProductUrlId");
  if (idx === -1) return null;

  // expected: ["ProductUrlId", "<id>", "<slug...>"]
  const slug = parts[idx + 2] || "";
  if (!slug) return null;

  return decodeURIComponent(slug)
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
  // Deduplicate by link, keep cheapest
  const bestByLink = new Map();
  for (const it of items) {
    const prev = bestByLink.get(it.link);
    if (!prev || it.priceRON < prev.priceRON) bestByLink.set(it.link, it);
  }

  const out = [...bestByLink.values()].sort((a, b) => a.priceRON - b.priceRON).slice(0, 10);
  return { queryUrl, items: out };
}

// --- Mobilissimo RSS (filter by q)
async function fetchMobilissimoRss(q) {
  const feed = "http://feeds.feedburner.com/telefoane-mobilissimo";
  const resp = await fetch(feed);
  if (!resp.ok) return { error: `rss_http_${resp.status}`, items: [] };

  const xml = await resp.text();
  const rawItems = [...xml.matchAll(/<item>[\s\S]*?<\/item>/g)].slice(0, 40);

  const items = rawItems
    .map((x) => {
      const b = x[0];
      const title =
        (b.match(/<title><!\[CDATA\[([\s\S]*?)\]\]><\/title>/) ||
          b.match(/<title>([\s\S]*?)<\/title>/))?.[1]?.trim() || null;
      const link = b.match(/<link>([\s\S]*?)<\/link>/)?.[1]?.trim() || null;
      const pubDate = b.match(/<pubDate>([\s\S]*?)<\/pubDate>/)?.[1]?.trim() || null;
      return { title, link, pubDate };
    })
    .filter((x) => {
      if (!q) return true;
      return (x.title || "").toLowerCase().includes(q.toLowerCase());
    })
    .slice(0, 10);

  return { items };
}

// --- Coupons (basic; may need tuning to promo-codes.ro structure)
async function fetchCouponsPromoCodes(domain) {
  const searchUrl = `https://promo-codes.ro/?s=${encodeURIComponent(domain)}`;

  const resp = await fetch(searchUrl, {
    headers: { "user-agent": "Mozilla/5.0", "accept-language": "ro-RO,ro;q=0.9" },
  });

  if (!resp.ok) return { domain, items: [], error: `coupon_http_${resp.status}`, searchUrl };

  const html = await resp.text();

  // Heuristic: detect coupon-like codes (A-Z0-9 4..14)
  const items = [];
  const codeRe = /\b([A-Z0-9]{4,14})\b/g;
  let m;
  while ((m = codeRe.exec(html)) && items.length < 8) {
    const code = m[1];
    // avoid capturing common noise tokens
    if (["HTTP", "HTML", "COOKIE", "LOGIN", "ORDER"].includes(code)) continue;
    items.push({ title: "Coupon", code, note: "source: promo-codes.ro" });
  }

  return { domain, items, searchUrl };
}

// --- Gemini summary for search results
async function geminiSummarize(env, payload) {
  if (!env.GEMINI_API_KEY) return null;

  const endpoint =
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent";

  const prompt =
`You are a price assistant for Romania.
Given JSON results, produce:
1) Cheapest 3 offers (price + link)
2) Any relevant Mobilissimo items (max 3)
3) Coupons by domain
Keep it concise.
JSON:
${JSON.stringify(payload)}`;

  const body = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0.2 },
  };

  const resp = await fetch(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-goog-api-key": env.GEMINI_API_KEY,
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) return null;

  const data = await resp.json();
  return data?.candidates?.[0]?.content?.parts?.map((p) => p.text).join("") ?? null;
}

/* --------------------------------
   Gemini normalization cache (DO)
   -------------------------------- */

function stableKeyFromTitle(title) {
  return (title || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[^a-z0-9" ]/g, "")
    .trim()
    .slice(0, 180);
}

async function getCachedNorm(env, cacheKey) {
  const id = env.DB.idFromName("main");
  const stub = env.DB.get(id);
  return stub
    .fetch("https://do.local/norm-get?k=" + encodeURIComponent(cacheKey))
    .then((r) => r.json());
}

async function putCachedNorm(env, cacheKey, value) {
  const id = env.DB.idFromName("main");
  const stub = env.DB.get(id);
  return stub.fetch("https://do.local/norm-put", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ key: cacheKey, value }),
  });
}

async function geminiNormalizeTitle(env, title) {
  if (!env.GEMINI_API_KEY || !title) return null;

  const endpoint =
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent";

  const prompt = `Extract product identity from this Romanian e-commerce title.
Return ONLY JSON with keys:
brand, model_family, model_code, size_inch, canonical_name, product_key.
Title: ${title}`;

  const body = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: 0,
      responseMimeType: "application/json",
    },
  };

  const resp = await fetch(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-goog-api-key": env.GEMINI_API_KEY,
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) return null;

  const data = await resp.json();
  const text =
    data?.candidates?.[0]?.content?.parts?.map((p) => p.text).join("") ?? "";
  if (!text) return null;

  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/* -----------------------------
   Durable Object storage
   ----------------------------- */

export class DB {
  constructor(state, env) {
    this.state = state;
  }

  async fetch(request) {
    const url = new URL(request.url);

    // normalization cache
    if (url.pathname === "/norm-get") {
      const key = url.searchParams.get("k");
      const v = key ? await this.state.storage.get("norm:" + key) : null;
      return new Response(JSON.stringify(v || null), {
        headers: { "content-type": "application/json; charset=utf-8" },
      });
    }

    if (url.pathname === "/norm-put") {
      const { key, value } = await request.json();
      if (key) await this.state.storage.put("norm:" + key, value);
      return new Response("ok");
    }

    // cheapest payload storage
    if (url.pathname === "/put") {
      const body = await request.json();
      await this.state.storage.put("data", body);
      return new Response("ok");
    }

    if (url.pathname === "/get") {
      const data =
        (await this.state.storage.get("data")) || { offers: [], updatedAt: null };
      return new Response(JSON.stringify(data), {
        headers: { "content-type": "application/json; charset=utf-8" },
      });
    }

    return new Response("not found", { status: 404 });
  }
}