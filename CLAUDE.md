# CLAUDE.md — Carteira JGP

Context for whichever Claude session picks this project up next.

## What this is

A single-page, interactive dashboard for Rodrigo's book: **$100M total**,
XLK 30% long, XLE 20% long, EWZ 10% long, XLY 10% **short**, GLD 15% long,
15% cash. Built right after `desafiojgp` (a 3-ETF dashboard in the same
directory) and reusing its dark visual language, but its own repo/site.

**Live site:** https://rodrigomambrini.github.io/carteirajgp/

## Weights are INDEPENDENT and cash is the slack variable

This is the single most important interaction rule, and it was an explicit
correction to an earlier build that did it the other way:

- Moving one position's slider/number input changes **only that position**.
  Earlier the sliders re-normalized each other proportionally — Rodrigo
  asked for that to go. Don't reintroduce it.
- **Cash is derived, never set directly**: `cash = 100% − Σ(all position
  weights)`, with **a short consuming allocation exactly like a long**.
  Rodrigo chose this rule explicitly when asked; the alternative (short
  proceeds *crediting* cash, which is how a real book finances a short) was
  considered and rejected. So the default book shows 85% allocated / 15%
  cash, and `data/portfolio.json` has `"cash_rule": "allocation"` recording
  that choice.
- `setWeight()` clamps each position so the allocated total can never pass
  100%, which keeps cash ≥ 0 and the grand total at exactly 100%. Dragging
  XLK to 95% when 45% is already allocated elsewhere lands on 55%, not 95%.

`STATE = {weights, sides}` in `js/app.js` is the single source of interaction
truth, seeded from `data/portfolio.json` into `DEFAULT_STATE` (what the
"Restaurar carteira original" button restores). Every change calls
`renderAll()`, which re-renders composition, correlation, the "Carteira"
line, aggregate metrics and the written analysis.

## Data freshness — two layers

**Why there is no direct browser fetch.** Tested, not assumed:
`query1.finance.yahoo.com` sends no `Access-Control-Allow-Origin` header, so
a direct fetch fails; `corsproxy.io` returns 403; `api.allorigins.win` worked
once (live XLK quote in 8ms) and then rate-limited the origin within ~2
minutes of light testing, after which even a small request hung past a 12s
timeout. A free public proxy is not a viable data path — don't re-litigate
this without re-running the test.

**Layer 1 — the committed snapshot.** `.github/workflows/update-data.yml`
runs `scripts/fetch_and_compute.py` on `*/15 13-21 * * 1-5` (market hours)
and commits `data/portfolio_data.json`; the page fetches it cache-busted on
each load. GitHub delays scheduled runs under load, so 15 min is a floor.
This layer always works and is the fallback for everything below.

**Layer 2 — the Cloudflare Worker (`worker/yahoo-proxy.js`).** A ~100-line
Worker that proxies Yahoo quotes with CORS headers, restricted to the 6
tickers this dashboard uses (**not** an open proxy) and edge-cached for 60s
so a burst of refreshes hits Yahoo once. Rodrigo deploys it with
`npx wrangler deploy` and pastes the URL into **`js/config.js`**
(`LIVE_PROXY_URL`); see README for the walkthrough.

`applyLiveQuotes()` in `js/app.js` runs **after the first paint** on purpose —
the page is already usable on the snapshot, so a slow or missing Worker never
delays it. It then patches the tail of each close array and calls
`initStats()` + `renderAll()`, so series, covariance, correlation, CAPM and
every portfolio metric come back out of the fresh numbers.

Three states, all exercised in testing:

| `LIVE_PROXY_URL` | Worker | Header shows |
| --- | --- | --- |
| empty | — | `preços do GitHub Actions` |
| set | responds | `● ao vivo · HH:MM` |
| set | down/timeout | `live indisponível — usando último snapshot` |

`patchSeriesWithQuote()` handles three quote cases: same date as the last bar
→ replace it; newer date → append a bar (first refresh of a session before
the cron runs); older date → ignore. All three verified.

## Everything derived is computed in the browser

`fetch_and_compute.py` is a **thin fetcher**: per asset it writes only
`dates`, `close` and a `quote` block, plus the benchmark series and the CDI
risk-free rate. Drawdown, rolling vol/Sharpe, covariance, correlation, CAPM
beta/alpha and all portfolio metrics are computed by `js/stats.js` and
`js/app.js` from those arrays.

This is deliberate and load-bearing: live quotes patch the close arrays, so
the page has to recompute those series anyway. Keeping a server-side copy
would be two implementations of the same math, free to disagree — exactly
the failure mode that produced the earlier "soma risco next to a negative
number" bug. When the Python originally owned this math, its output was
verified against the JS port over the same closes: CAPM matched to ~4e-3 and
every derived series to ~1e-4 (pure JSON rounding). Dropping it also cut the
JSON from 0.87 MB to 0.37 MB.

**If you add a metric, add it in `js/stats.js`, not in Python.**

## Section map (Markowitz is gone — don't add it back)

1. **Ajuste a carteira** — the control panel described above.
2. **Composição** — pie + table (values in $ over the $100M book), plus a
   static **Ordens** table listing the individual lots from
   `portfolio.json`'s `lots` array (three separate XLK tickets, PF trigger
   prices, status badges). The orders table is deliberately NOT driven by
   the sliders: it records what was actually sent to the market. Per
   Rodrigo, "Pendente" is the correct *technical* status for the PF orders
   even though they filled at the open, hence the "Executada na abertura"
   note beside the badge.
3. **Matriz de correlação** — see the window caveat below.
4. **Performance** — a full-width **real-USD price chart** (primary, per
   Rodrigo) plus indexed/drawdown/vol/Sharpe. The USD chart uses a
   **logarithmic y-axis**: the five trade between ~$38 and ~$400, and on a
   linear axis the cheaper names flatten into the baseline. It shows only
   the 5 assets — the portfolio has no per-share price, so the "Carteira"
   line lives on the indexed chart instead.
5. **CAPM** — per-asset beta/alpha vs `^GSPC`. Independent of weights.
6. **Métricas agregadas** — live from `STATE`.
7. **Análise e recomendação** — generated from live numbers, not fixed copy.

**Section 4 used to be a long-only Markowitz simulator + efficient frontier +
max-Sharpe card.** Rodrigo asked for it removed ("deixar mais limpo, focado
em análise, não em otimização teórica"). `js/markowitz.js` and
`css/markowitz.css` were deleted; the math the rest of the page still needs
(COV/CORR/ANN_RETURN/SIGMA/RF) moved to `js/stats.js` and the heatmap CSS was
folded into `css/style.css`. Don't resurrect the frontier without asking.

## The short position

XLY is held short and is handled by *signed* weights everywhere it matters —
`signedFrac()` returns a negative fraction, and `portfolioVariance()` takes
signed weights so a hedge shows up as risk-reducing. The composition and
orders tables show its quantity and value as negative, tagged SHORT in red.
The long/short toggle in the control panel can flip any position.

If the book changes, edit **`data/portfolio.json` only** (`positions[].weight`
/ `.side`, `lots[]`, `capital_usd`) — everything derives from it.

## Correlation: two windows, and why the text is written the way it is

The heatmap's correlation uses the **full loaded history (~11 years)** — a
stable estimate, matching the preference Rodrigo stated on the sibling
project. The pair rankings underneath use **contribution to the current
portfolio's variance** (`2·wᵢ·wⱼ·Covᵢⱼ / variance`, signed weights) over the
short `WINDOW = 63` pregões, which is what actually ties the section to the
weights he sets.

Those two can **legitimately disagree in sign** — XLK × XLE shows long-run
correlation +0.41 while contributing −20% of current risk. An earlier version
derived the explanatory note from the correlation's sign and so printed
"soma risco" next to a negative number. **The note is now derived from the
contribution's sign**, and a footnote in the card explains the two windows.
If you touch that text, keep it reading off `p.contrib`, never off `p.v`.

Related deliberate mismatch: `liveStats()` combines 63-day vol/covariance
with 252-day CAPM betas. That mirrors real practice (beta is conventionally
a longer-window number) — not a bug to unify.

## File map

```
index.html               shell, loads Chart.js + config.js -> capm.js -> stats.js -> app.js
css/style.css            everything: theme tokens, control panel, quotes strip, tables, heatmap, cards
js/config.js             LIVE_PROXY_URL (the Worker) + LIVE_TIMEOUT_MS — the one file to edit after deploying
js/app.js                owns STATE + the control panel + the live-quote overlay; renders sections 1,2,3,4,6,7; owns shared globals (ASSET_ORDER, ACCENT_VAR, fmt helpers, cssVar)
js/stats.js              ALL derived math: buildAssetSeries, rollingSeriesFromReturns, computeCapmFor, COV/CORR/ANN_RETURN/SIGMA/RF, portfolioVariance(signed weights)
js/capm.js               section 5 (table + beta bars) — rendering only
worker/yahoo-proxy.js    Cloudflare Worker: CORS proxy for Yahoo quotes, 6-ticker allowlist, 60s edge cache
worker/wrangler.toml     deploy config (npx wrangler deploy from that folder)
data/portfolio.json      THE source of truth: capital, positions, sides, lots, cash_rule
data/portfolio_data.json regenerated by the script — don't hand-edit
scripts/fetch_and_compute.py   thin fetcher: Yahoo closes + intraday quotes + CDI -> portfolio_data.json
.github/workflows/update-data.yml   */15 during market hours
.claude/launch.json      preview_start serves this dir on :8124
```

The JS files are classic `<script>` tags sharing one global scope, loaded
`config.js` → `capm.js` → `stats.js` → `app.js`. `app.js` declares the shared
globals and calls `init()` last; the others only touch those globals inside
function bodies that run after `init()`, so the order is safe.

**Cache-busting:** `index.html` references every local asset with `?v=N`.
GitHub Pages serves through a CDN and browsers cache aggressively, so
**bump that N whenever you change a JS or CSS file** or returning visitors
keep running the old code. This bit me during development: a fix looked like
it hadn't applied when the browser was simply serving the cached file.

**Anything rendered more than once must destroy its Chart.js instance first**
(`pieChart`, `perfCharts`, `capmChart`). `renderCapm` originally didn't, and
threw "Canvas is already in use" the first time live quotes triggered a
re-render — caught only because the live path was tested.

## Design

One committed dark palette (`#0D1117` bg / `#161B22` surface), no
`prefers-color-scheme` or `[data-theme]` branching. Fonts: `Fraunces`
(headings), `IBM Plex Sans` (body), `IBM Plex Mono` (numbers, `.num`).

Per-position accents in `css/style.css`: XLK blue `#4F8FD6`, XLE dark green
`#1F6E43`, EWZ green `#37A363`, XLY red `#F85149` (deliberately in the
`--critical` hue family to flag the short), GLD gold `#D4AF37`, cash gray
`#6E7681`, portfolio line off-white `#E6EDF3`. These have **not** been run
through a CVD-safety validator — worth doing before any redesign.

## Currency

Rodrigo described the book as "R$ 100 milhões" but quoted every position in
`$`, and the ETFs are USD-denominated. Following the precedent already set on
`desafiojgp`: **no FX conversion is applied anywhere**, the UI labels values
with `$`, and the footer says so. Don't silently insert a BRL/USD rate — ask
first if it starts to matter.

## Known rough edges

- **No intraday (1D) chart range.** The range selector starts at 1M; the
  `quote` block gives today's snapshot numbers but there's no 5-minute bar
  series stored. Adding it means persisting `range=1d&interval=5m` per
  symbol, like desafiojgp's `fetch_intraday()`.
- **The "Carteira" line approximates cash** with a flat daily rate from the
  current CDI applied across all history, because the JSON doesn't ship a
  historical CDI series to the client. Fine for a what-if line, not a
  precise backtest.
- **The Worker was never executed end to end here** — this machine has no
  Node, so `wrangler dev` couldn't run. The page side of the live path was
  verified by stubbing `fetchLiveQuotes()` (patching, re-render, append,
  timeout fallback, stale-quote rejection all confirmed); the Worker itself
  was only reviewed by reading. First real deploy should sanity-check the
  response shape against what `applyLiveQuotes()` expects:
  `{quotes: {SYM: {price, open, high, low, previousClose, volume, date, time}}}`.
