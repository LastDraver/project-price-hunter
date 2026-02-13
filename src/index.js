// src/index.js
// Cloudflare Worker + Durable Object
// Endpoints:
//   GET  /api/search?q=...&budget=4000&sizeMin=55&sizeMax=65&condition=any
//   GET  /api/health
//
// Fully automatic crawling:
//   - Pricy (price comparison)
//   - Reselecto (resealed/used retailer)
//   - OLX best-effort via Google CSE discovery (site:olx.ro), then fetch top listing pages
// Reviews:
//   - Google CSE (Reddit + pro sites) for top candidates
// Gemini:
//   - intent extraction
//   - listing facts (defects/negotiable/condition/size)
//   - scoring + differences + pros/cons
//   - final recommendation
//
// REQUIRED env vars (Worker -> Settings -> Variables):
//   GEMINI_API_KEY (Secret)
//   GOOGLE_CSE_API_KEY (Secret)   // Google Custom Search JSON API key
//   GOOGLE_CSE_CX (Text/Secret)   // Programmable Search Engine CX
//
// Durable Object binding name must be DB and class_name DB in wrangler.toml/dashboard.

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // CORS preflight
    if (request.method === "OPTIONS") return new Response(null, { headers: corsHeaders() });

    if (url.pathname === "/") {
      return htmlResponse(INDEX_HTML, 200);
    }

    if (url.pathname === "/api/health") {
      return json(
        {
          ok: true,
          hasGemini: Boolean(env.GEMINI_API_KEY),
          hasGoogleCSE: Boolean(env.GOOGLE_CSE_API_KEY && env.GOOGLE_CSE_CX),
          ts: new Date().toISOString(),
        },
        200
      );
    }

    if (url.pathname === "/api/search") {
      const q = (url.searchParams.get("q") || "").trim();
      if (!q) return json({ error: "missing q" }, 400);

      const budget = numOrNull(url.searchParams.get("budget"));
      const sizeMin = numOrNull(url.searchParams.get("sizeMin"));
      const sizeMax = numOrNull(url.searchParams.get("sizeMax"));
      const condition = (url.searchParams.get("condition") || "any").trim().toLowerCase(); // any|new|used|resealed

      const input = {
        q,
        budget,
        sizeMin,
        sizeMax,
        condition,
      };

      const result = await runSearchWithCache(env, input);
      return json(result, 200);
    }

    return new Response("Not found", { status: 404, headers: corsHeaders() });
  },
};

/* =========================
   HTML UI (served from Worker)
========================= */

const INDEX_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>Price Hunter</title>
  <style>
    body{font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Arial,sans-serif;margin:16px}
    .row{display:flex;gap:8px;flex-wrap:wrap}
    input,select,button{font-size:16px;padding:10px;border:1px solid #ddd;border-radius:8px}
    button{cursor:pointer}
    pre{white-space:pre-wrap;word-break:break-word;background:#fafafa;border:1px solid #eee;padding:12px;border-radius:10px}
    .small{font-size:13px;color:#666}
  </style>
</head>
<body>
  <h2>Price Hunter</h2>
  <div class="row">
    <input id="q" style="flex:1;min-width:240px" placeholder="e.g., OLED TV 55-65 under 4000 lei" />
    <input id="budget" type="number" placeholder="Budget (lei)" style="width:160px" />
    <input id="min" type="number" placeholder="Min inch" style="width:120px" />
    <input id="max" type="number" placeholder="Max inch" style="width:120px" />
    <select id="cond" style="width:150px">
      <option value="any">Any</option>
      <option value="new">New</option>
      <option value="resealed">Resealed</option>
      <option value="used">Used</option>
    </select>
    <button id="go">Search</button>
  </div>
  <p class="small">Sources: Pricy, Reselecto, OLX (best-effort via Google discovery), plus reviews via Google CSE. Gemini ranks and explains differences.</p>
  <pre id="out">Ready.</pre>

<script>
const out = document.getElementById('out');
const qEl = document.getElementById('q');
const bEl = document.getElementById('budget');
const minEl = document.getElementById('min');
const maxEl = document.getElementById('max');
const cEl = document.getElementById('cond');
const go = document.getElementById('go');

async function run() {
  const q = qEl.value.trim();
  if (!q) { out.textContent = "Enter a query."; return; }

  const params = new URLSearchParams();
  params.set("q", q);
  if (bEl.value) params.set("budget", bEl.value);
  if (minEl.value) params.set("sizeMin", minEl.value);
  if (maxEl.value) params.set("sizeMax", maxEl.value);
  if (cEl.value) params.set("condition", cEl.value);

  out.textContent = "Searching…";
  go.disabled = true;

  try {
    const r = await fetch("/api/search?" + params.toString());
    const txt = await r.text();
    if (!r.ok) {
      out.textContent = "API error " + r.status + "\\n" + txt;
      return;
    }
    out.textContent = txt;
  } catch (e) {
    out.textContent = "Network error: " + (e?.message || String(e));
  } finally {
    go.disabled = false;
  }
}

go.addEventListener("click", run);
qEl.addEventListener("keydown", (e) => { if (e.key === "Enter") run(); });
</script>
</body>
</html>`;

/* =========================
   Core: caching + pipeline
========================= */

async function runSearchWithCache(env, input) {
  const intent = await geminiIntent(env, input);

  const cacheKey = stableKeyFromObj({
    q: intent?.search_query || input.q,
    budget: intent?.budget_lei ?? input.budget ?? null,
    sizeMin: intent?.size_min ?? input.sizeMin ?? null,
    sizeMax: intent?.size_max ?? input.sizeMax ?? null,
    category: intent?.category ?? null,
    condition_ok: intent?.condition_ok ?? null,
  });

  // cache TTL: 20 minutes
  const cached = await cacheGet(env, cacheKey);
  if (cached?.ts && Date.now() - cached.ts < 20 * 60 * 1000) {
    return { ...cached.result, cache: { hit: true, key: cacheKey, ageSec: Math.floor((Date.now() - cached.ts) / 1000) } };
  }

  const result = await runSearchPipeline(env, input, intent);

  await cachePut(env, cacheKey, { ts: Date.now(), result });

  return { ...result, cache: { hit: false, key: cacheKey } };
}

async function runSearchPipeline(env, input, intent) {
  const startedAt = new Date().toISOString();
  const debug = { startedAt, input, steps: [] };

  const searchQuery = intent?.search_query || input.q;

  // 1) Crawl: Pricy + Reselecto
  const [pricy, reselecto] = await Promise.all([
    searchPricy(searchQuery).catch((e) => ({ error: String(e?.message || e), items: [] })),
    searchReselecto(searchQuery).catch((e) => ({ error: String(e?.message || e), items: [] })),
  ]);

  debug.steps.push({ name: "pricy", ok: !pricy.error, count: pricy.items?.length || 0, error: pricy.error || null });
  debug.steps.push({ name: "reselecto", ok: !reselecto.error, count: reselecto.items?.length || 0, error: reselecto.error || null });

  // 2) Discover OLX listings via Google CSE (best-effort)
  const olxDiscovery = await discoverOlxListings(env, intent, input).catch((e) => ({ error: String(e?.message || e), items: [] }));
  debug.steps.push({ name: "olx_discovery", ok: !olxDiscovery.error, count: olxDiscovery.items?.length || 0, error: olxDiscovery.error || null });

  // 3) Fetch listing pages for used candidates (OLX) to extract descriptions (limited)
  const olxDetails = await fetchListingDetails(env, olxDiscovery.items || []).catch((e) => ({ error: String(e?.message || e), items: [] }));
  debug.steps.push({ name: "olx_details", ok: !olxDetails.error, count: olxDetails.items?.length || 0, error: olxDetails.error || null });

  // 4) Merge candidates
  let candidates = [
    ...(pricy.items || []).map((x) => ({ ...x, source: "pricy" })),
    ...(reselecto.items || []).map((x) => ({ ...x, source: "reselecto" })),
    ...(olxDetails.items || []).map((x) => ({ ...x, source: "olx" })),
  ];

  // Basic filters
  candidates = candidates
    .filter((c) => c?.link && (c.title || c.rawText || c.snippet))
    .filter((c) => {
      // Drop obvious accessories if user wants a main device
      if (intent?.category && intent.category !== "accessory") {
        if (looksLikeAccessory(c.title)) return false;
      }
      return true;
    })
    .filter((c) => !looksBadCondition(`${c.title || ""} ${c.rawText || ""} ${c.snippet || ""}`));

  // Apply Gemini exclusions if provided
  if (intent?.must_exclude?.length) {
    const ex = intent.must_exclude.map((x) => String(x).toLowerCase());
    candidates = candidates.filter((c) => {
      const t = `${c.title || ""} ${c.rawText || ""}`.toLowerCase();
      return !ex.some((k) => t.includes(k));
    });
  }

  // 5) Extract listing facts for top N (defects, negotiable, condition, size)
  const topForFacts = candidates.slice(0, 12);
  const facts = await geminiExtractListingFacts(env, topForFacts, intent);
  const factsByLink = new Map((facts || []).map((x) => [x.link, x]));
  candidates = candidates.map((c) => ({ ...c, ...(factsByLink.get(c.link) || {}) }));

  // 6) Score + differences + pros/cons
  const scored = await geminiScoreCandidates(env, candidates.slice(0, 20), intent);
  const ranked = (scored?.items || [])
    .map((it) => ({ ...it, hardFit: hardFitScore(it, intent) }))
    .sort((a, b) => {
      const ao = (b.overallScore || 0) - (a.overallScore || 0);
      if (ao) return ao;
      const av = (b.valueScore || 0) - (a.valueScore || 0);
      if (av) return av;
      return (a.priceRON || 1e18) - (b.priceRON || 1e18);
    })
    .slice(0, 10);

  // 7) Reviews via Google CSE for top 3
  const reviews = await fetchReviewsForTop(env, ranked, intent);

  // 8) Final recommendation text
  const recommendation = await geminiFinalRecommendation(env, {
    input,
    intent,
    ranked,
    reviews,
  });

  return {
    q: input.q,
    intent,
    top: ranked,
    reviews,
    recommendation,
    sources: {
      pricy: { ok: !pricy.error, count: pricy.items?.length || 0, error: pricy.error || null, queryUrl: pricy.queryUrl || null },
      reselecto: { ok: !reselecto.error, count: reselecto.items?.length || 0, error: reselecto.error || null, queryUrl: reselecto.queryUrl || null },
      olx: { ok: !olxDetails.error, count: olxDetails.items?.length || 0, error: olxDetails.error || null },
    },
    debug,
    ts: new Date().toISOString(),
    build: "price-hunter-auto-v1",
  };
}

/* =========================
   Hard-fit scoring (deterministic)
========================= */

function hardFitScore(it, intent) {
  let s = 0;

  if (intent?.budget_lei != null && it.priceRON != null) {
    if (it.priceRON <= intent.budget_lei) s += 20;
    else s -= clamp((it.priceRON - intent.budget_lei) / 50, 0, 35);
  }

  if (intent?.size_min != null && it.sizeInch != null) {
    if (it.sizeInch >= intent.size_min) s += 5;
    else s -= 10;
  }
  if (intent?.size_max != null && it.sizeInch != null) {
    if (it.sizeInch <= intent.size_max) s += 5;
    else s -= 10;
  }

  if ((intent?.must_have || []).some((x) => String(x).toLowerCase().includes("oled"))) {
    const t = `${it.title || ""} ${it.canonical || ""}`.toLowerCase();
    if (t.includes("oled")) s += 10;
    else s -= 15;
  }

  if (it.defects?.length) s -= clamp(it.defects.length * 5, 0, 25);

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
    if (!u.pathname.includes("/ProductUrlId/")) continue;

    const title = titleFromPricyPath(u.pathname);

    items.push({ title: title || null, link: u.toString(), priceRON });
  }

  const best = new Map();
  for (const it of items) {
    const prev = best.get(it.link);
    if (!prev || it.priceRON < prev.priceRON) best.set(it.link, it);
  }

  return { queryUrl, items: [...best.values()].sort((a, b) => a.priceRON - b.priceRON).slice(0, 10) };
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
========================= */

async function searchReselecto(q) {
  const queryUrl = `https://www.reselecto.ro/?s=${encodeURIComponent(q)}&post_type=product`;

  const resp = await fetchWithTimeout(queryUrl, {
    headers: { "user-agent": "Mozilla/5.0", "accept-language": "ro-RO,ro;q=0.9" },
  });

  if (!resp.ok) return { error: `reselecto_http_${resp.status}`, queryUrl, items: [] };

  const html = await resp.text();

  const items = [];
  // WooCommerce-ish tile: link + title + lei price
  const tileRe =
    /<a[^>]+href="([^"]+)"[^>]*>[\s\S]{0,800}?<h2[^>]*>([\s\S]*?)<\/h2>[\s\S]{0,1200}?(\d[\d.\s]{2,})\s*lei/gi;

  let m;
  while ((m = tileRe.exec(html)) && items.length < 20) {
    const link = m[1];
    const title = normalizeText(stripHtml(m[2]));
    const priceRON = parseInt(m[3].replace(/\s+/g, "").replace(/\./g, ""), 10);
    if (!link || !title || !Number.isFinite(priceRON)) continue;

    items.push({
      title,
      link: link.startsWith("http") ? link : new URL(link, "https://www.reselecto.ro").toString(),
      priceRON,
      rawText: null,
    });
  }

  return { queryUrl, items };
}

/* =========================
   OLX discovery via Google CSE + page fetch
========================= */

async function discoverOlxListings(env, intent, input) {
  // If no Google CSE, skip
  if (!env.GOOGLE_CSE_API_KEY || !env.GOOGLE_CSE_CX) return { error: "missing_google_cse_env", items: [] };

  const base = intent?.search_query || input.q;

  // Build a focused discovery query:
  // - include "site:olx.ro"
  // - include budget/size hints where available
  // - for TVs, include oled and inch range words
  let q = `site:olx.ro ${base}`;
  if (intent?.category === "tv") {
    q += " televizor";
    if ((intent?.must_have || []).some((x) => String(x).toLowerCase().includes("oled"))) q += " oled";
    if (intent?.size_min != null || intent?.size_max != null) q += " inch";
  }
  if (intent?.budget_lei != null) q += ` ${Math.floor(intent.budget_lei)} lei`;

  const res = await googleCseSearch(env, q, 8);
  if (res.error) return { error: res.error, items: [] };

  // Keep only olx.ro listing URLs (best effort)
  const items = [];
  for (const it of res.items || []) {
    if (!it.link) continue;
    try {
      const u = new URL(it.link);
      if (!u.hostname.endsWith("olx.ro")) continue;
      // Keep likely listing pages (not category root). OLX often contains /d/oferta/...
      if (!u.pathname.includes("/d/")) continue;
      items.push({
        title: it.title || null,
        link: it.link,
        snippet: it.snippet || null,
      });
    } catch {}
  }

  return { items: items.slice(0, 6) };
}

async function fetchListingDetails(env, discovered) {
  const items = [];
  for (const it of (discovered || []).slice(0, 6)) {
    try {
      const resp = await fetchWithTimeout(it.link, {
        headers: { "user-agent": "Mozilla/5.0", "accept-language": "ro-RO,ro;q=0.9" },
      });

      if (!resp.ok) continue;

      const html = await resp.text();

      // Heuristic extract:
      // - title: <title> or og:title
      // - description: meta description + some text near "Descriere"
      // - price: look for "lei" nearby
      const title = extractMeta(html, "og:title") || extractTitleTag(html) || it.title || null;
      const desc = extractMeta(html, "description") || "";
      const bodyText = normalizeText(stripHtml(grabTextChunk(html, ["Descriere", "descriere", "Description"], 4000)));

      const rawText = normalizeText(`${desc} ${bodyText}`.slice(0, 3500));
      const priceRON = extractPriceRON(html);

      items.push({
        title: title ? normalizeText(title) : null,
        link: it.link,
        priceRON,
        snippet: it.snippet || null,
        rawText: rawText || null,
      });
    } catch {}
  }

  // Deduplicate by link
  const byLink = new Map();
  for (const x of items) byLink.set(x.link, x);
  return { items: [...byLink.values()] };
}

/* =========================
   Reviews via Google CSE
========================= */

async function fetchReviewsForTop(env, ranked, intent) {
  if (!env.GOOGLE_CSE_API_KEY || !env.GOOGLE_CSE_CX) return { error: "missing_google_cse_env", items: [] };

  const top = (ranked || []).slice(0, 3);
  const out = [];

  for (const it of top) {
    const model = normalizeText(it.modelCode || it.productKey || it.canonical || it.title || "").slice(0, 120);
    if (!model) continue;

    const queries =
      intent?.category === "tv"
        ? [
            `${model} review`,
            `${model} rtings`,
            `${model} site:reddit.com r/OLED OR r/4kTV`,
            `${model} site:avsforum.com`,
            `${model} hdtvtest`,
          ]
        : [
            `${model} review`,
            `${model} site:reddit.com`,
            `${model} benchmark OR forum`,
          ];

    const sources = [];
    const seen = new Set();

    for (const q of queries.slice(0, 4)) {
      const res = await googleCseSearch(env, q, 5);
      for (const s of res.items || []) {
        if (!s.link || seen.has(s.link)) continue;
        seen.add(s.link);
        sources.push(s);
        if (sources.length >= 12) break;
      }
      if (sources.length >= 12) break;
    }

    out.push({ candidateLink: it.link, model, sources });
  }

  return { items: out };
}

async function googleCseSearch(env, query, num = 6) {
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

/* =========================
   Gemini calls
========================= */

async function geminiIntent(env, input) {
  const fallback = {
    category: "other",
    budget_lei: input.budget ?? null,
    size_min: input.sizeMin ?? null,
    size_max: input.sizeMax ?? null,
    condition_ok: input.condition === "new" ? ["new"] : input.condition === "used" ? ["used"] : input.condition === "resealed" ? ["resealed"] : ["new", "resealed", "used"],
    must_have: [],
    must_exclude: ["nu porneste", "ecran spart", "pentru piese", "defect"],
    search_query: input.q,
    expanded_queries: [],
  };

  if (!env.GEMINI_API_KEY) return fallback;

  const prompt = `Return ONLY JSON:
{
  "category": "tv|laptop|phone|audio|accessory|other",
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
Constraints: budget=${input.budget ?? null}, sizeMin=${input.sizeMin ?? null}, sizeMax=${input.sizeMax ?? null}, condition=${input.condition}

Rules:
- If query implies TV and OLED, set category="tv" and include "oled" in must_have.
- If user wants 55-65 inch, set size_min/size_max.
- must_exclude should include broken/non-working phrases.
- search_query should be a compact query suitable for Romanian price search.
`;

  const data = await geminiCallJson(env, prompt, 0);
  return data || fallback;
}

async function geminiExtractListingFacts(env, items, intent) {
  if (!env.GEMINI_API_KEY) return [];

  const prompt = `Return ONLY JSON:
{ "items": [ { "link": "...", "condition": "new|used|resealed|unknown", "negotiable": true|false|unknown, "defects": ["..."], "sizeInch": number|null, "notes": "..." } ] }

User intent:
${JSON.stringify(intent)}

Items:
${JSON.stringify(
    (items || []).map((x) => ({
      title: x.title,
      link: x.link,
      priceRON: x.priceRON,
      snippet: x.snippet,
      rawText: x.rawText,
      source: x.source,
    }))
  )}
`;
  const res = await geminiCallJson(env, prompt, 0);
  return res?.items || [];
}

async function geminiScoreCandidates(env, items, intent) {
  if (!env.GEMINI_API_KEY) {
    // deterministic fallback: cheap sort
    const out = (items || [])
      .map((x) => ({
        link: x.link,
        title: x.title || null,
        priceRON: x.priceRON ?? null,
        overallScore: 50,
        valueScore: x.priceRON != null && intent?.budget_lei != null ? clamp(100 - Math.abs(x.priceRON - intent.budget_lei) / 50, 0, 100) : 50,
        differences: [],
        pros: [],
        cons: [],
        modelCode: null,
        sizeInch: x.sizeInch ?? null,
        panelType: guessPanelType(x.title),
        condition: x.condition ?? "unknown",
        negotiable: x.negotiable ?? "unknown",
        defects: x.defects ?? [],
      }))
      .sort((a, b) => (a.priceRON || 1e18) - (b.priceRON || 1e18))
      .slice(0, 10);
    return { items: out };
  }

  const prompt = `Return ONLY JSON:
{
  "items": [
    {
      "link": "...",
      "title": "...",
      "priceRON": number|null,
      "overallScore": number,
      "valueScore": number,
      "differences": ["..."],
      "pros": ["..."],
      "cons": ["..."],
      "modelCode": "string|null",
      "productKey": "string|null",
      "canonical": "string|null",
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
  if (!env.GEMINI_API_KEY) return null;

  const prompt = `You are a Romanian "best value for money" assistant.
From JSON, produce:
- Best pick under budget
- Best overall value (may be slightly over budget if justified)
- Best used/resealed deal (if present)
For each: rationale, key differences vs request, risks/defects, negotiable yes/no/unknown.
Then a short buying checklist (questions to ask seller; what photos/tests to request).
Keep it compact but specific.

JSON:
${JSON.stringify(payload)}
`;
  return await geminiCallText(env, prompt, 0.2);
}

async function geminiCallJson(env, prompt, temperature = 0) {
  const endpoint = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent";
  const body = { contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature, responseMimeType: "application/json" } };

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

  const data = await resp.json().catch(() => null);
  const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text).join("") ?? "";
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function geminiCallText(env, prompt, temperature = 0.2) {
  const endpoint = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent";
  const body = { contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature } };

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

  const data = await resp.json().catch(() => null);
  return data?.candidates?.[0]?.content?.parts?.map((p) => p.text).join("") ?? null;
}

/* =========================
   Durable Object cache (DB)
========================= */

async function cacheGet(env, key) {
  const id = env.DB.idFromName("main");
  const stub = env.DB.get(id);
  return stub.fetch("https://do.local/cache-get?k=" + encodeURIComponent(key)).then((r) => r.json());
}

async function cachePut(env, key, value) {
  const id = env.DB.idFromName("main");
  const stub = env.DB.get(id);
  return stub.fetch("https://do.local/cache-put", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ key, value }),
  });
}

/* =========================
   Parsing helpers
========================= */

function extractMeta(html, nameOrProp) {
  const re = new RegExp(`<meta[^>]+(?:name|property)="${escapeRe(nameOrProp)}"[^>]+content="([^"]*)"`, "i");
  const m = html.match(re);
  return m ? decodeHtml(m[1]) : null;
}

function extractTitleTag(html) {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return m ? decodeHtml(stripHtml(m[1])) : null;
}

function extractPriceRON(html) {
  // loose: first occurrence of 1234 lei / 1.234 lei / 1 234 lei
  const m = html.match(/(\d[\d.\s]{2,})\s*lei/i);
  if (!m) return null;
  const n = parseInt(m[1].replace(/\s+/g, "").replace(/\./g, ""), 10);
  return Number.isFinite(n) ? n : null;
}

function grabTextChunk(html, needles, maxLen) {
  const lower = html.toLowerCase();
  let idx = -1;
  for (const n of needles) {
    const i = lower.indexOf(String(n).toLowerCase());
    if (i !== -1) {
      idx = i;
      break;
    }
  }
  if (idx === -1) return "";
  const slice = html.slice(idx, idx + (maxLen || 3000));
  return slice;
}

function stripHtml(s) {
  return String(s || "").replace(/<[^>]+>/g, " ");
}

function decodeHtml(s) {
  return String(s || "")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
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
    "ecran spart",
    "display broken",
    "screen broken",
    "pentru piese",
    "piese",
    "defect",
    "burn-in sever",
    "ars",
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

function guessPanelType(title) {
  const t = (title || "").toLowerCase();
  if (t.includes("oled")) return "oled";
  if (t.includes("qled")) return "qled";
  if (t.includes("mini led") || t.includes("miniled")) return "lcd";
  return "unknown";
}

function clamp(v, a, b) {
  return Math.max(a, Math.min(b, v));
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

function safeUrl(s) {
  try {
    return new URL(s);
  } catch {
    return null;
  }
}

function corsHeaders() {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type",
    "access-control-max-age": "86400",
  };
}

function htmlResponse(html, status = 200) {
  return new Response(html, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      ...corsHeaders(),
    },
  });
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...corsHeaders(),
    },
  });
}

function stableKeyFromObj(obj) {
  // stable stringify with sorted keys
  const s = stableStringify(obj);
  // simple hash (not crypto)
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return "k:" + (h >>> 0).toString(16);
}

function stableStringify(x) {
  if (x === null || typeof x !== "object") return JSON.stringify(x);
  if (Array.isArray(x)) return "[" + x.map(stableStringify).join(",") + "]";
  const keys = Object.keys(x).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + stableStringify(x[k])).join(",") + "}";
}

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/* =========================
   Durable Object: DB
========================= */

export class DB {
  constructor(state, env) {
    this.state = state;
  }

  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === "/cache-get") {
      const key = url.searchParams.get("k");
      const v = key ? await this.state.storage.get("cache:" + key) : null;
      return new Response(JSON.stringify(v || null), {
        headers: { "content-type": "application/json; charset=utf-8" },
      });
    }

    if (url.pathname === "/cache-put") {
      const { key, value } = await request.json();
      if (key) await this.state.storage.put("cache:" + key, value);
      return new Response("ok");
    }

    return new Response("not found", { status: 404 });
  }
}