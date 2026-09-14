/*
 * Cloudflare Worker — CORS proxy for Yahoo Finance quotes.
 *
 * Why this exists: browsers can't call query1.finance.yahoo.com directly
 * (no Access-Control-Allow-Origin header), and free public CORS proxies
 * rate-limit a busy origin within minutes. This Worker is the small piece of
 * infrastructure that makes the dashboard genuinely live on every refresh.
 *
 * It is NOT an open proxy. It only ever calls Yahoo's chart endpoint, only
 * for the six tickers this dashboard uses, and it returns a compact quote
 * object rather than passing arbitrary upstream bytes through. Responses are
 * cached at the edge for CACHE_SECONDS so a burst of refreshes hits Yahoo
 * once, which is what keeps us from getting rate-limited in turn.
 *
 * Deploy: see README.md ("Preços live via Cloudflare Worker").
 *
 * API:  GET /?symbols=XLK,XLE,EWZ,XLY,GLD,^GSPC
 * ->    { "generated_at_utc": "...", "quotes": { "XLK": { price, open,
 *         high, low, previousClose, volume, date, time, marketState }, ... } }
 */

const ALLOWED_SYMBOLS = new Set(["XLK", "XLE", "EWZ", "XLY", "GLD", "^GSPC"]);
const CACHE_SECONDS = 60;
const UPSTREAM_TIMEOUT_MS = 8000;

function corsHeaders() {
  return {
    // Public market data for a fixed ticker list, no credentials involved —
    // a wildcard origin is safe here and keeps local development working.
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Max-Age": "86400",
  };
}

function jsonResponse(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": `public, max-age=${CACHE_SECONDS}`,
      ...corsHeaders(),
      ...extraHeaders,
    },
  });
}

async function fetchQuote(symbol) {
  const url =
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}` +
    `?range=1d&interval=5m`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { "User-Agent": "Mozilla/5.0", Accept: "application/json" },
      // Let Cloudflare serve repeated refreshes from its own cache.
      cf: { cacheTtl: CACHE_SECONDS, cacheEverything: true },
    });
    if (!res.ok) return [symbol, { error: `upstream ${res.status}` }];

    const result = (await res.json())?.chart?.result?.[0];
    if (!result) return [symbol, { error: "empty upstream payload" }];

    const meta = result.meta || {};
    const opens = (result.indicators?.quote?.[0]?.open || []).filter(o => o != null);
    const price = meta.regularMarketPrice ?? null;
    const seconds = meta.regularMarketTime ?? null;
    // The trading date this price belongs to, so the page knows whether to
    // replace the last daily bar or append a new one.
    const date = seconds ? new Date(seconds * 1000).toISOString().slice(0, 10) : null;

    return [symbol, {
      price,
      open: opens.length ? opens[0] : null,
      high: meta.regularMarketDayHigh ?? null,
      low: meta.regularMarketDayLow ?? null,
      previousClose: meta.chartPreviousClose ?? meta.previousClose ?? null,
      volume: meta.regularMarketVolume ?? null,
      marketState: meta.marketState ?? null,
      date,
      time: seconds ? new Date(seconds * 1000).toISOString() : null,
    }];
  } catch (err) {
    return [symbol, { error: err.name === "AbortError" ? "upstream timeout" : String(err) }];
  } finally {
    clearTimeout(timer);
  }
}

export default {
  async fetch(request) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }
    if (request.method !== "GET") {
      return jsonResponse({ error: "method not allowed" }, 405);
    }

    const requested = (new URL(request.url).searchParams.get("symbols") || "")
      .split(",")
      .map(s => s.trim().toUpperCase())
      .filter(Boolean);

    const symbols = [...new Set(requested)].filter(s => ALLOWED_SYMBOLS.has(s));
    if (!symbols.length) {
      return jsonResponse(
        { error: "no allowed symbols requested", allowed: [...ALLOWED_SYMBOLS] },
        400,
      );
    }

    const entries = await Promise.all(symbols.map(fetchQuote));
    return jsonResponse({
      generated_at_utc: new Date().toISOString(),
      quotes: Object.fromEntries(entries),
    });
  },
};
