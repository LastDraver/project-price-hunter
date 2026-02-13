export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // CORS preflight
    if (request.method === "OPTIONS") return new Response(null, { headers: corsHeaders() });

    if (url.pathname === "/") {
      return new Response(
        "OK. Use /api/search?q=...&budget=4000&sizeMin=55&sizeMax=65&condition=any&targets=<url>|<url>",
        { headers: { "content-type": "text/plain; charset=utf-8" } }
      );
    }

    if (url.pathname === "/api/search") {
      const q = (url.searchParams.get("q") || "").trim();
      if (!q) return json({ error: "missing q" }, 400);

      const budget = numOrNull(url.searchParams.get("budget"));
      const sizeMin = numOrNull(url.searchParams.get("sizeMin"));
      const sizeMax = numOrNull(url.searchParams.get("sizeMax"));
      const condition = (url.searchParams.get("condition") || "any").trim(); // any|new|used|resealed

      // User-provided listing/search URLs for used marketplaces (OLX, etc.)
      // You control these URLs so scraping stays low-volume + predictable.
      const targetsRaw = (url.searchParams.get("targets") || "").trim();
      const targets = targetsRaw
        ? targetsRaw.split("|").map((s) => s.trim()).filter(Boolean).slice(0, 8)
        : [];

      const result = await runSearchPipeline(env, {
        q,
        budget,
        sizeMin,
        sizeMax,
        condition,
        targets,
      });

      return json(result, 200);
    }

    return new Response("Not found", { status: 404, headers: corsHeaders() });
  },
};

/* =========================
   Helpers
========================= */

function corsHeaders() {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type",
    "access-control-max-age": "86400",
  };
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...corsHeaders() },
  });
}

function numOrNull(v) {
  if (v == null || v === "") return null;
  const n = Number(String(v).replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

async function fetchWithTimeout(url, opts = {}, ms = 9000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: ac.signal });
  } finally {
    clearTimeout(t);
  }
}

function normalizeText(s) {
  return (s || "").replace(/\s+/g, " ").trim();
}

function looksBadCondition(text) {
  const t = (text || "").toLowerCase();
  const bad = [
    "nu porneste",
    "nu pornește",
    "spart",
    "crapat",
    "crăpat",
    "screen broken",
    "display broken",
    "ecran spart",
    "defect",
    "piese",
    "pentru piese",
  ];
  return bad.some((k) => t.includes(k));
}

function looksLikeAccessory(title) {
  const t = (title || "").toLowerCase();
  return [
    "husa",
    "husă",
    "case",
    "cover",
    "folie",
    "screen protector",
    "stand",
    "suport",
    "curea",
    "charger",
    "incarcator",
    "încărcător",
    "cablu",
    "remote",
    "telecomanda",
  ].some((k) => t.includes(k));
}

function clamp(v, a, b) {
  return Math.max(a, Math.min(b, v));
}

/* =========================
   Browser Rendering REST fallback (optional)
   - Uses /browser-rendering/content endpoint
   - Requires CF_ACCOUNT_ID + CF_BR_API_TOKEN
   Docs: /content endpoint, POST with {"url": "..."} and optional gotoOptions.waitUntil.  [oai_citation:2‡Cloudflare Docs](https://developers.cloudflare.com/browser-rendering/rest-api/content-endpoint/)
========================= */

async function brFetchRenderedHtml(env, pageUrl) {
  if (!env.CF_ACCOUNT_ID || !env.CF_BR_API_TOKEN) return null;

  const endpoint = `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/browser-rendering/content`;
  const body = {
    url: pageUrl,
    gotoOptions: { waitUntil: "networkidle0" },
    // small speedups
    rejectResourceTypes: ["image", "font"],
    userAgent: "Mozilla/5.0 (compatible; price-hunter/1.0; +https://example.invalid)",
  };

  const resp = await fetchWithTimeout(
    endpoint,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${env.CF_BR_API_TOKEN}`,
      },
      body: JSON.stringify(body),
    },
    25000
  );

  if (!resp.ok) return null;

  // Cloudflare REST returns a JSON envelope; handle both common shapes
  const data = await resp.json().catch(() => null);
  const html =
    data?.result?.content ||
    data?.result?.html ||
    data?.content ||
    data?.html ||
    null;

  return typeof html === "string" && html.length > 50 ? html : null;
}

/* =========================
   Pipeline
========================= */

async function runSearchPipeline(env, input) {
  const startedAt = new Date().toISOString();

  // 1) Gemini intent extraction from user query + constraints
  const intent = await geminiIntent(env, input);

  // 2) Collect candidates from sources (low volume)
  const [pricy, reselecto, targetListings] = await Promise.all([
    searchPricy(intent.search_query || input.q).catch((e) => ({ error: String(e?.message || e), items: [] })),
    searchReselecto(intent.search_query || input.q).catch((e) => ({ error: String(e?.message || e), items: [] })),
    searchFromUserTargets(env, input.targets).catch((e) => ({ error: String(e?.message || e), items: [] })),
  ]);

  // 3) Basic filtering
  let candidates = [
    ...(pricy.items || []).map((x) => ({ ...x, source: "pricy" })),
    ...(reselecto.items || []).map((x) => ({ ...x, source: "reselecto" })),
    ...(targetListings.items || []).map((x) => ({ ...x, source: "target" })),
  ];

  candidates = candidates
    .filter((c) => c?.link && (c.title || c.snippet || c.rawText))
    .filter((c) => {
      // If user wants device, drop obvious accessories
      if (intent?.category && intent.category !== "accessory") {
        if (looksLikeAccessory(c.title)) return false;
      }
      return true;
    })
    .filter((c) => {
      // Hard reject “broken/not working” style listings
      const blob = `${c.title || ""} ${c.snippet || ""} ${c.rawText || ""}`;
      return !looksBadCondition(blob);
    });

  // 4) Enrich used/resale candidates: extract condition, defects, negotiable, warranty from text
  //    (Gemini runs on top N only to control cost)
  const topForExtraction = candidates.slice(0, 12);
  const extracted = await geminiExtractListingFacts(env, topForExtraction, intent);

  // merge extraction back
  const byLink = new Map(extracted.map((x) => [x.link, x]));
  candidates = candidates.map((c) => ({ ...c, ...(byLink.get(c.link) || {}) }));

  // 5) Score closeness/value with Gemini + deterministic constraints
  const scored = await geminiScoreCandidates(env, candidates.slice(0, 20), intent);

  // 6) Budget/size constraint pass
  const finalRanked = (scored.items || [])
    .map((it) => ({
      ...it,
      hardFit: hardFitScore(it, intent),
    }))
    .sort((a, b) => {
      // primary: overall score, secondary: value score, tertiary: price
      if ((b.overallScore || 0) !== (a.overallScore || 0)) return (b.overallScore || 0) - (a.overallScore || 0);
      if ((b.valueScore || 0) !== (a.valueScore || 0)) return (b.valueScore || 0) - (a.valueScore || 0);
      return (a.priceRON || 1e18) - (b.priceRON || 1e18);
    })
    .slice(0, 10);

  // 7) Reviews: Google CSE query per top models, then Gemini summarizes pros/cons
  const reviewPack = await fetchReviewsForTop(env, finalRanked, intent);

  // 8) Final Gemini answer: differences + pros/cons + “best for money”
  const recommendation = await geminiFinalRecommendation(env, {
    input,
    intent,
    candidates: finalRanked,
    reviews: reviewPack,
  });

  return {
    startedAt,
    input,
    intent,
    sources: {
      pricy: { ok: !pricy.error, count: pricy.items?.length || 0, error: pricy.error || null },
      reselecto: { ok: !reselecto.error, count: reselecto.items?.length || 0, error: reselecto.error || null },
      targets: { ok: !targetListings.error, count: targetListings.items?.length || 0, error: targetListings.error || null },
    },
    top: finalRanked,
    reviews: reviewPack,
    recommendation,
    build: "price-hunter-v3",
  };
}

function hardFitScore(it, intent) {
  let s = 0;

  // budget
  if (intent?.budget_lei != null && it.priceRON != null) {
    if (it.priceRON <= intent.budget_lei) s += 20;
    else s -= clamp((it.priceRON - intent.budget_lei) / 50, 0, 30);
  }

  // size
  if (intent?.size_min != null && it.sizeInch != null) {
    if (it.sizeInch >= intent.size_min) s += 5;
    else s -= 10;
  }
  if (intent?.size_max != null && it.sizeInch != null) {
    if (it.sizeInch <= intent.size_max) s += 5;
    else s -= 10;
  }

  // oled requirement
  if ((intent?.must_have || []).some((x) => String(x).toLowerCase().includes("oled"))) {
    const t = `${it.title || ""} ${it.canonical || ""}`.toLowerCase();
    if (t.includes("oled")) s += 10;
    else s -= 15;
  }

  // condition preference
  if (intent?.condition_ok && it.condition) {
    if (intent.condition_ok.includes(it.condition)) s += 5;
  }

  // defects
  if (it.defects?.length) s -= clamp(it.defects.length * 5, 0, 20);

  return s;
}

/* =========================
   Source: Pricy
========================= */

async function searchPricy(q) {
  const queryUrl = `https://www.pricy.ro/productsv2/magazin-storel.ro/generic-color-verde?q=${encodeURIComponent(q)}`;
  const resp = await fetchWithTimeout(queryUrl, {
    headers: { "user-agent": "Mozilla/5.0", "accept-language": "ro-RO,ro;q=0.9" },
  });

  if (!resp.ok) return { error: `pricy_http_${resp.status}`, queryUrl, items: [] };
  const html = await resp.text();

  const items = [];
  const re = /href="([^"]+)"[\s\S]{0,500}?(\d[\d.\s]{2,})\s*lei/gi;

  let m;
  while ((m = re.exec(html)) && items.length < 120) {
    const hrefRaw = m[1] || "";
    const priceRON = parseInt(m[2].replace(/\s+/g, "").replace(/\./g, ""), 10);
    if (!Number.isFinite(priceRON) || priceRON <= 0) continue;

    const link = hrefRaw.startsWith("http") ? hrefRaw : new URL(hrefRaw, "https://www.pricy.ro").toString();

    const u = safeUrl(link);
    if (!u) continue;
    if (!["pricy.ro", "www.pricy.ro"].includes(u.hostname)) continue;

    // keep only product pages
    if (!u.pathname.includes("/ProductUrlId/")) continue;

    const title = titleFromPricyPath(u.pathname);

    items.push({
      title: title || null,
      link: u.toString(),
      priceRON,
    });
  }

  // dedupe
  const best = new Map();
  for (const it of items) {
    const prev = best.get(it.link);
    if (!prev || it.priceRON < prev.priceRON) best.set(it.link, it);
  }

  return {
    queryUrl,
    items: [...best.values()].sort((a, b) => a.priceRON - b.priceRON).slice(0, 10),
  };
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
  const idx = parts.findIndex((p) => p === "ProductUrlId");
  if (idx === -1) return null;
  const slug = parts[idx + 2] || "";
  if (!slug) return null;
  return decodeURIComponent(slug).replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim();
}

/* =========================
   Source: Reselecto (heuristic)
   - Uses normal fetch; if empty and BR configured, tries Browser Rendering /content.
========================= */

async function searchReselecto(q) {
  // Basic search URL. If site changes, swap with category + query.
  const queryUrl = `https://www.reselecto.ro/?s=${encodeURIComponent(q)}&post_type=product`;

  let html = null;

  // Try plain fetch
  const r1 = await fetchWithTimeout(queryUrl, {
    headers: { "user-agent": "Mozilla/5.0", "accept-language": "ro-RO,ro;q=0.9" },
  });
  if (r1.ok) html = await r1.text();

  // If plain fetch yields too little, try Browser Rendering (optional)
  if (!html || html.length < 2000) {
    // Caller env passed in later; this function is called without env, so do nothing here.
    // We keep it plain. If you want BR for reselecto, move env into this function signature.
  }

  if (!html) return { error: "reselecto_fetch_failed", queryUrl, items: [] };

  // Heuristic WooCommerce product tiles:
  // - product link
  // - product title (often in <h2 class="woocommerce-loop-product__title">)
  // - price in lei
  const items = [];
  const tileRe = /<a[^>]+href="([^"]+)"[^>]*>[\s\S]{0,800}?<h2[^>]*>([\s\S]*?)<\/h2>[\s\S]{0,800}?(\d[\d.\s]{2,})\s*lei/gi;

  let m;
  while ((m = tileRe.exec(html)) && items.length < 15) {
    const link = m[1];
    const title = stripHtml(m[2]);
    const priceRON = parseInt(m[3].replace(/\s+/g, "").replace(/\./g, ""), 10);
    if (!link || !Number.isFinite(priceRON)) continue;

    items.push({
      title: normalizeText(title),
      link: link.startsWith("http") ? link : new URL(link, "https://www.reselecto.ro").toString(),
      priceRON,
      rawText: null,
    });
  }

  return { queryUrl, items };
}

function stripHtml(s) {
  return String(s || "").replace(/<[^>]+>/g, " ");
}

/* =========================
   User targets (OLX / any marketplace)
   - You provide the URL(s) via targets=... to avoid crawling.
   - Fetch page HTML, pull top listing blocks heuristically.
   - If empty and BR configured, try Browser Rendering /content.
========================= */

async function searchFromUserTargets(env, targets) {
  const items = [];
  const debug = [];

  for (const t of (targets || []).slice(0, 8)) {
    try {
      let html = null;

      const r1 = await fetchWithTimeout(t, {
        headers: { "user-agent": "Mozilla/5.0", "accept-language": "ro-RO,ro;q=0.9" },
      });

      if (r1.ok) html = await r1.text();

      // if looks like SPA/blocked and Browser Rendering is available
      if ((!html || html.length < 1200) && env.CF_ACCOUNT_ID && env.CF_BR_API_TOKEN) {
        const rendered = await brFetchRenderedHtml(env, t);
        if (rendered) html = rendered;
      }

      if (!html) {
        debug.push({ url: t, ok: false, reason: "no_html" });
        continue;
      }

      // generic listing extraction:
      // try to find anchors + nearby price in lei
      const re = /<a[^>]+href="([^"]+)"[^>]*>([\s\S]{0,200}?)<\/a>[\s\S]{0,500}?(\d[\d.\s]{2,})\s*lei/gi;
      let m;
      let local = 0;

      while ((m = re.exec(html)) && local < 10) {
        const href = m[1];
        const title = normalizeText(stripHtml(m[2]));
        const priceRON = parseInt(m[3].replace(/\s+/g, "").replace(/\./g, ""), 10);

        if (!href || !title || !Number.isFinite(priceRON)) continue;

        const link = href.startsWith("http") ? href : new URL(href, t).toString();

        // Skip nav links
        if (title.length < 12) continue;

        items.push({
          title,
          link,
          priceRON,
          rawText: null,
          snippet: null,
        });

        local++;
      }

      debug.push({ url: t, ok: true, extracted: local });
    } catch (e) {
      debug.push({ url: t, ok: false, reason: String(e?.message || e) });
    }
  }

  // dedupe
  const best = new Map();
  for (const it of items) {
    const prev = best.get(it.link);
    if (!prev || (it.priceRON || 1e18) < (prev.priceRON || 1e18)) best.set(it.link, it);
  }

  return { debug, items: [...best.values()].sort((a, b) => (a.priceRON || 1e18) - (b.priceRON || 1e18)).slice(0, 12) };
}

/* =========================
   Reviews: Google Custom Search JSON API
========================= */

async function googleCseSearch(env, query, num = 5) {
  if (!env.GOOGLE_CSE_API_KEY || !env.GOOGLE_CSE_CX) return { error: "missing_google_cse_env", items: [] };

  const api = `https://www.googleapis.com/customsearch/v1?key=${encodeURIComponent(
    env.GOOGLE_CSE_API_KEY
  )}&cx=${encodeURIComponent(env.GOOGLE_CSE_CX)}&q=${encodeURIComponent(query)}&num=${clamp(num, 1, 10)}&gl=ro&hl=ro`;

  const resp = await fetchWithTimeout(api, {}, 9000);
  if (!resp.ok) return { error: `google_http_${resp.status}`, items: [] };

  const data = await resp.json();
  const items = (data.items || []).map((it) => ({
    title: it.title || null,
    link: it.link || null,
    snippet: it.snippet || null,
  }));

  return { items };
}

async function fetchReviewsForTop(env, ranked, intent) {
  const top = (ranked || []).slice(0, 3);

  const out = [];
  for (const it of top) {
    const model = it.modelCode || it.productKey || it.canonical || it.title || "";
    const base = normalizeText(model).slice(0, 120);

    const queries = [
      `${base} review`,
      `${base} site:rtings.com`,
      `${base} site:reddit.com ${intent?.category || "review"}`,
      `${base} site:avsforum.com`,
    ];

    const links = [];
    for (const q of queries.slice(0, 3)) {
      const res = await googleCseSearch(env, q, 5);
      for (const li of res.items || []) {
        if (li.link) links.push(li);
      }
    }

    // dedupe links
    const seen = new Set();
    const uniq = [];
    for (const l of links) {
      if (!l.link || seen.has(l.link)) continue;
      seen.add(l.link);
      uniq.push(l);
      if (uniq.length >= 12) break;
    }

    out.push({ link: it.link, model: base, sources: uniq });
  }

  return out;
}

/* =========================
   Gemini calls
========================= */

async function geminiCallJson(env, prompt, temperature = 0) {
  if (!env.GEMINI_API_KEY) return null;

  const endpoint =
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent";

  const body = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { temperature, responseMimeType: "application/json" },
  };

  const resp = await fetchWithTimeout(
    endpoint,
    {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY },
      body: JSON.stringify(body),
    },
    12000
  );

  if (!resp.ok) return null;

  const data = await resp.json();
  const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text).join("") ?? "";
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function geminiCallText(env, prompt, temperature = 0.2) {
  if (!env.GEMINI_API_KEY) return null;

  const endpoint =
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent";

  const body = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { temperature },
  };

  const resp = await fetchWithTimeout(
    endpoint,
    {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY },
      body: JSON.stringify(body),
    },
    12000
  );

  if (!resp.ok) return null;

  const data = await resp.json();
  return data?.candidates?.[0]?.content?.parts?.map((p) => p.text).join("") ?? null;
}

async function geminiIntent(env, input) {
  const prompt = `
Return ONLY JSON:
{
  "category": "tv|laptop|phone|audio|other",
  "budget_lei": number|null,
  "size_min": number|null,
  "size_max": number|null,
  "condition_ok": ["new","resealed","used"],
  "must_have": ["..."],
  "must_exclude": ["..."],
  "search_query": "string",
  "expanded_queries": ["...", "...", "..."]
}

User query: ${input.q}
Constraints:
- budget: ${input.budget ?? null}
- sizeMin: ${input.sizeMin ?? null}
- sizeMax: ${input.sizeMax ?? null}
- condition: ${input.condition}

Interpretation rules:
- If query mentions OLED, include "oled" in must_have.
- If user allows resealed/used, include them in condition_ok.
- must_exclude should include broken/non-working indications.
- search_query should be the best short query for price search in Romania.
`;

  const data = await geminiCallJson(env, prompt, 0);
  // deterministic fallback
  return (
    data || {
      category: "other",
      budget_lei: input.budget ?? null,
      size_min: input.sizeMin ?? null,
      size_max: input.sizeMax ?? null,
      condition_ok: ["new", "resealed", "used"],
      must_have: [],
      must_exclude: ["nu porneste", "ecran spart", "pentru piese"],
      search_query: input.q,
      expanded_queries: [],
    }
  );
}

async function geminiExtractListingFacts(env, items, intent) {
  const prompt = `
You receive marketplace results. Extract defects/negotiable/condition and size if present.
Return ONLY JSON: { "items": [ { "link": "...", "condition": "new|used|resealed|unknown", "negotiable": true|false|unknown, "defects": ["..."], "sizeInch": number|null, "notes": "..." } ] }

Context: user wants category=${intent?.category}, must_have=${JSON.stringify(intent?.must_have || [])}, must_exclude=${JSON.stringify(intent?.must_exclude || [])}

Items:
${JSON.stringify(
    (items || []).map((x) => ({
      title: x.title,
      link: x.link,
      priceRON: x.priceRON,
      snippet: x.snippet,
      rawText: x.rawText,
    }))
  )}
`;

  const res = await geminiCallJson(env, prompt, 0);
  return res?.items || [];
}

async function geminiScoreCandidates(env, items, intent) {
  const prompt = `
Return ONLY JSON:
{
  "items": [
    {
      "link": "...",
      "title": "...",
      "priceRON": number|null,
      "overallScore": number,        // 0-100 closeness to request
      "valueScore": number,          // 0-100 price/performance for budget
      "differences": ["..."],        // differences vs requested constraints
      "pros": ["..."],
      "cons": ["..."],
      "modelCode": "string|null",
      "sizeInch": number|null,
      "panelType": "oled|qled|lcd|unknown",
      "condition": "new|used|resealed|unknown",
      "negotiable": true|false|unknown,
      "defects": ["..."]
    }
  ]
}

User intent:
${JSON.stringify(intent)}

Candidates:
${JSON.stringify(items)}
`;

  const res = await geminiCallJson(env, prompt, 0);
  return res || { items: [] };
}

async function geminiFinalRecommendation(env, payload) {
  const prompt = `
You are a Romanian "best value for money" assistant.
Given the JSON, produce:
- Best pick under budget
- Best overall value (may be slightly above budget)
- Best used/resealed deal (if present)
For each: short rationale + key differences vs request + risks/defects + whether negotiable.
Then a final "buying checklist" (what to ask seller, what photos to request).

JSON:
${JSON.stringify(payload)}
`;
  return await geminiCallText(env, prompt, 0.2);
}

/* =========================
   END
========================= */