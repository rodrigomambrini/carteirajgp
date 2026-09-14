# CLAUDE.md — Carteira JGP

Context for whichever Claude session picks this project up next.

## What this is

A single-page dashboard for Rodrigo's specific portfolio: **XLK 20% long,
XLE 15% long, EWZ 10% long, XLY 10% SHORT, GLD 10% long, 35% cash**. Built
right after `desafiojgp` (a 3-ETF EWZ/FXE/EEM dashboard) in the same
directory — this project deliberately reuses its design language and math
(same dark theme, same Markowitz/correlation code shape) but is its own
independent repo/site, not a page inside desafiojgp.

**Live site:** https://rodrigomambrini.github.io/carteirajgp/ (once Pages is
enabled — see below).

## The short position is the whole point — don't lose it when editing

XLY is held **short**, not long. Every place that matters, it's handled via
a *signed* weight (`weight * -1` for XLY), not by pretending it's a normal
long position:

- `scripts/fetch_and_compute.py`: `ASSET_SIDE = {..., "XLY": -1}`, used to
  build the aggregate `portfolio_series` (Section 3's "Carteira" line) and
  `portfolio_metrics` (Section 6 — vol, beta, alpha, VaR, risk contribution
  all use signed weights).
- `js/app.js`'s composition table (Section 1) shows XLY's quantity and $
  value as negative, tagged "SHORT" in red.
- **The Markowitz simulator/frontier (Section 4, `js/markowitz.js`) does
  NOT replicate this** — it's a long-only exploration tool across the same
  5 tickers, explicitly labeled as such in the UI. Don't "fix" it by adding
  a short toggle without asking; the real portfolio's actual risk (with the
  short) is what Sections 1/2/6/7 report instead, and mixing the two
  purposes would confuse which number is "real."
- The correlation heatmap (Section 2) shows raw asset-return correlation
  (how XLK and XLY actually move together, both long) — a caveat is
  appended to any XLY pair's interpretation line reminding the reader the
  sign flips in practice since the position is short.

If Rodrigo ever changes which position is short/long or the weights, edit
**`data/portfolio.json`** only (`side: "long"|"short"`, `weight`,
`cash_weight`) — everything else derives from it. Don't hardcode weights
anywhere else.

## Architecture — server computes, client renders

Same pattern as `desafiojgp`: `scripts/fetch_and_compute.py` (no
dependencies beyond the stdlib) fetches Yahoo Finance daily closes for the 5
tickers + `^GSPC` (CAPM benchmark) + CDI from the Banco Central SGS API,
computes everything, and writes one file, `data/portfolio_data.json`. The
page just fetches and renders it — no browser-side calls to Yahoo (their
chart API has no CORS headers, so that would fail silently in a browser
regardless).

`data/portfolio_data.json` contains, per asset: the usual price/perf/
drawdown/rolling-vol/rolling-Sharpe series (21d/63d windows, same as
desafiojgp) **plus** a `capm` block (`beta`, `alpha_annual_pct`,
`expected_capm_pct`, `realized_return_pct` — OLS regression of daily returns
on `^GSPC`'s, last `capm_window_days` = 252 trading days). It also has a
synthetic `portfolio_series` (the "Carteira" line plotted alongside the 5
assets in Section 3 — signed-weight daily returns + cash earning the daily
CDI rate, compounded from the earliest common date) and `portfolio_metrics`
(Section 6's numbers: expected return via both CAPM and realized, annualized
vol from the signed-weight covariance matrix, Sharpe, beta, alpha, 1-day 95%
parametric VaR, and an Euler risk-contribution breakdown per position —
**XLY's contribution is legitimately negative**, meaning the short reduces
total portfolio risk; that's correct, not a bug).

Client-side (`js/markowitz.js`) *re-derives* covariance/correlation from the
raw `close` arrays for the interactive slider simulator + efficient frontier
— this duplicates some of what Python already computed, on purpose, because
the simulator needs to recompute live as the user drags sliders. If you
change the return/vol methodology, update both `fetch_and_compute.py`
(`CAPM_WINDOW`) and `js/markowitz.js` (`WINDOW`) — they're intentionally the
same 252-vs-63-day split as desafiojgp's medidas.js (short window for
expected return/vol since it reacts to regime changes; correlation uses the
full loaded history since it's a more stable quantity). Currently
`CAPM_WINDOW` (Python, feeds Section 6) = 252 and `WINDOW` (JS, feeds
Section 4's simulator) = 63 — these are **different windows for different
sections on purpose**, not a bug to unify.

## File map

```
index.html              shell + section markup, loads Chart.js + the 3 JS files
css/style.css            theme tokens, composition table, CAPM table, recommendation card
css/markowitz.css        correlation heatmap, slider simulator, frontier legend, Markowitz card
js/app.js                loads data/portfolio_data.json, renders sections 1/3/6/7, owns shared globals (ASSET_ORDER, ACCENT_VAR, fmt helpers, cssVar)
js/markowitz.js          sections 2 (correlation) + 4 (simulator/frontier/Markowitz) — exposes window.CORR_MATRIX and window.MARKOWITZ_RESULT for app.js's recommendation section
js/capm.js               section 5 (CAPM table + beta bar chart) — pure rendering, math already done in Python
data/portfolio.json      the ONLY place position weights/sides/capital live — edit this to rebalance
data/portfolio_data.json regenerated by fetch_and_compute.py — don't hand-edit
scripts/fetch_and_compute.py   fetches + computes everything, writes data/portfolio_data.json
.github/workflows/update-data.yml   hourly cron (market hours, weekdays), runs the script and commits if changed
.claude/launch.json      lets `preview_start` serve this dir locally on :8124
```

Note the 3 JS files are classic `<script>` tags (no modules, no bundler),
loaded `capm.js`, `markowitz.js`, `app.js` in that order — they share one
global scope. `app.js` declares the shared globals and calls `init()` last;
`capm.js`/`markowitz.js` only reference those globals inside function
bodies, which don't execute until `app.js`'s `init()` calls them after data
loads, so load order is safe despite `app.js` being listed last.

## Design — same fixed dark identity as desafiojgp, new accent set

One committed dark palette (`#0D1117` bg / `#161B22` surface), no
`@media(prefers-color-scheme)` or `[data-theme]` branching — copied
verbatim from desafiojgp's `css/style.css` `:root`. Fonts: `Fraunces`
(headings), `IBM Plex Sans` (body), `IBM Plex Mono` (all numbers, `.num`
class).

Per-position accents (`--accent-*` in `css/style.css`) were picked fresh for
this project's 5+1 legend, not reused from desafiojgp (whose EWZ/FXE/EEM/
XLK/XLE accents serve a different page/asset set): XLK blue `#4F8FD6`, XLE
dark green `#1F6E43`, EWZ green `#37A363`, XLY red `#F85149` (short —
intentionally uses the same hue family as `--critical` to visually flag it),
GLD gold `#D4AF37`, cash gray `#6E7681`, portfolio line off-white
`#E6EDF3`. These have **not** been run through a CVD-safety validator (the
`dataviz` skill's palette check desafiojgp used) — if that matters, run it
before shipping a redesign.

## What's deliberately simplified vs. the original spec

- **No intraday (1D) view.** The spec's range selector asked for `1D` too;
  this project only has daily granularity (`RANGES` in `js/app.js` starts at
  1M). Adding it would mean a second Yahoo fetch path
  (`range=1d&interval=5m`) for 6 tickers, mirroring desafiojgp's
  `fetch_intraday()` — straightforward to add later if wanted, just wasn't
  built yet.
- **Markowitz section is long-only across the 5 risky assets, no cash, no
  short.** See the "short position" section above for why — the real
  portfolio's short+cash math lives in Section 6/7 instead, computed
  server-side.
- **The Section 7 recommendation text is generated from live numbers**, not
  hand-written copy — `js/app.js`'s `renderRecommendation()` picks the most
  correlated pair, the most volatile position, etc. from whatever
  `data/portfolio_data.json` currently says. It'll read differently after
  each data refresh; that's intended, not a bug, and matches the spirit of
  the original request for a "análise da carteira" section that's actually
  live rather than a static mockup.
- **api.js was never created.** The original brief asked for
  `js/api.js` to fetch Yahoo Finance directly from the browser — skipped
  because Yahoo's `query1.finance.yahoo.com` doesn't send CORS headers, so a
  browser-side `fetch()` to it fails. Same reason desafiojgp fetches
  server-side. If a future session is asked to add live/intraday updates
  without the GitHub Actions round-trip, this CORS limitation is why that
  needs a small proxy, not a client-only fix.

## Deploy

Not yet turned on as of this writing — enable GitHub Pages from Settings →
Pages → Deploy from branch → `main` / `/ (root)` once the repo has its
first push. `.github/workflows/update-data.yml` needs no extra secrets
(uses the default `GITHUB_TOKEN` via `permissions: contents: write`).
