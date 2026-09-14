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

## Data freshness — why it is NOT a live browser fetch

Rodrigo asked for the page to fetch Yahoo Finance directly on every F5. That
was **tested and rejected on evidence**, not assumed:

- Direct browser → Yahoo: fails. `query1.finance.yahoo.com` sends no
  `Access-Control-Allow-Origin` header.
- `corsproxy.io`: 403.
- `api.allorigins.win`: worked once (returned a live XLK quote in 8ms), then
  rate-limited this origin within ~2 minutes of light testing — afterwards
  even a small request hung past a 12s timeout. Unusable as a dashboard's
  only data path.

So the pipeline stayed server-side, and Rodrigo picked the **every-15-minutes
GitHub Actions** option: `.github/workflows/update-data.yml` runs
`scripts/fetch_and_compute.py` on `*/15 13-21 * * 1-5` (market hours) and
commits `data/portfolio_data.json`; the page fetches that file cache-busted
on each load. A refresh therefore shows prices at most one cron interval old
with zero manual steps. GitHub delays scheduled runs under load, so treat 15
min as a floor.

**If asked for true per-F5 live data**, the answer is a tiny self-hosted
proxy (Cloudflare Worker / Vercel function) that Rodrigo deploys once — that
option was offered and deferred, not ruled out. A free public proxy is not a
viable substitute; see the test results above before re-litigating.

Yahoo's `interval=1d` history includes a partial bar for the current session,
so the last daily point already carries today's live price. On top of that,
`fetch_quote()` stores a per-asset `quote` block (last price, open, day
high/low, volume, change %, quote timestamp) that feeds the quotes strip
under the header.

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
index.html               shell, loads Chart.js + capm.js -> stats.js -> app.js
css/style.css            everything: theme tokens, control panel, quotes strip, tables, heatmap, cards
js/app.js                owns STATE + the control panel; renders sections 1,2,3,4,6,7; owns shared globals (ASSET_ORDER, ACCENT_VAR, fmt helpers, cssVar)
js/stats.js              COV / CORR / ANN_RETURN / SIGMA / RF + portfolioVariance(signed weights)
js/capm.js               section 5 (table + beta bars) — pure rendering
data/portfolio.json      THE source of truth: capital, positions, sides, lots, cash_rule
data/portfolio_data.json regenerated by the script — don't hand-edit
scripts/fetch_and_compute.py   Yahoo history + intraday quotes + CAPM + CDI -> portfolio_data.json
.github/workflows/update-data.yml   */15 during market hours
.claude/launch.json      preview_start serves this dir on :8124
```

The 3 JS files are classic `<script>` tags sharing one global scope, loaded
`capm.js` → `stats.js` → `app.js`. `app.js` declares the shared globals and
calls `init()` last; the other two only touch those globals inside function
bodies that run after `init()`, so the order is safe.

`portfolio_data.json` deliberately contains **no** portfolio-level metrics or
NAV series any more — those were server-side snapshots that went stale the
moment a slider moved, and the page computes them live. Don't re-add them.

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
