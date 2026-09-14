/*
 * Carteira JGP — main orchestrator + the interactive "ajuste a carteira"
 * control panel. Loads data/portfolio_data.json (fetched and computed
 * server-side by scripts/fetch_and_compute.py: prices, CAPM beta/alpha) and
 * renders every section of the single-page dashboard.
 *
 * STATE {weights, sides} holds the CURRENT portfolio the user is looking
 * at — it starts equal to the real allocation in data/portfolio.json, but
 * every slider/toggle in the control panel mutates it and re-renders
 * sections 1 (composição), 2 (correlação — the interpretation and the
 * heatmap's per-asset weight badges), 3 (a recomputed "Carteira" line), 6
 * (métricas agregadas) and 7 (recomendação) from the CURRENT state, not the
 * original allocation. Section 4 (Markowitz/fronteira) is intentionally a
 * SEPARATE long-only what-if tool over the same 5 tickers (js/markowitz.js
 * already made it interactive) — it does not drive or get driven by STATE,
 * since simulating shorts+cash through an efficient frontier is a different
 * problem than this control panel's job. js/capm.js renders section 5,
 * which is per-asset and doesn't depend on weights at all.
 *
 * Live recompute reuses js/markowitz.js's COV/ANN_RETURN/RF/portfolioVariance
 * (63-trading-day window) rather than introducing a second covariance
 * calculation client-side — one shared source of truth for "current
 * weights" math. The "Carteira" performance line (section 3) is instead
 * rebuilt directly from each asset's daily close prices (full history) plus
 * a flat daily rate derived from the current CDI (data.risk_free), since
 * the JSON doesn't carry a full historical CDI series to the client.
 *
 * All three JS files (capm.js, markowitz.js, app.js) share one global scope
 * (classic <script> tags, no modules), so consts/functions declared here
 * are visible there and vice versa.
 *
 * No live browser-side fetch to Yahoo Finance: their chart API doesn't send
 * CORS headers, so a client-side fetch would fail. Same pattern as the
 * desafiojgp project — python fetches + computes, GitHub Actions commits the
 * JSON, the page just reads a static file.
 */

const ASSET_ORDER = ["XLK", "XLE", "EWZ", "XLY", "GLD"];
const ALL_KEYS = [...ASSET_ORDER, "CASH"];
const ACCENT_VAR = { XLK: "--accent-xlk", XLE: "--accent-xle", EWZ: "--accent-ewz", XLY: "--accent-xly", GLD: "--accent-gld", CASH: "--accent-cash", PORT: "--accent-port" };
const RANGES = [
  { key: "1m", label: "1M", days: 21 },
  { key: "6m", label: "6M", days: 126 },
  { key: "1y", label: "1A", days: 252 },
  { key: "3y", label: "3A", days: 756 },
  { key: "5y", label: "5A", days: 1260 },
  { key: "max", label: "Max", days: null },
];
const DEFAULT_RANGE_KEY = "1y";

let DATA = null;
let ASSET_NAME = {};       // symbol -> display name
let DEFAULT_STATE = null;  // {weights:{...}, sides:{...}} from data/portfolio.json — used by the reset button
let STATE = null;          // live, mutated by the control panel
let currentRange = null;
const perfCharts = {};
let pieChart = null;

// precomputed once at load, used to rebuild the "Carteira" line for any weights
let COMMON_DATES = [];
let ASSET_RET_BY_DATE = {}; // sym -> {date: dailyReturn}
let DAILY_RF = 0;

function fmtPct(v, digits = 2) { if (v === null || v === undefined || Number.isNaN(v)) return "—"; return (v >= 0 ? "+" : "") + v.toFixed(digits) + "%"; }
function fmtNum(v, digits = 2) { if (v === null || v === undefined || Number.isNaN(v)) return "—"; return v.toFixed(digits); }
function fmtUsd(v) { if (v === null || v === undefined) return "—"; return "$" + Math.round(v).toLocaleString("en-US"); }
function fmtDateShort(iso) { const [y, m, d] = iso.split("-"); return d + "/" + m + "/" + y.slice(2); }
function cssVar(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }
function accentColor(sym) { return cssVar(ACCENT_VAR[sym]); }

// --- STATE helpers -----------------------------------------------------------

function signedFrac(sym) { return (STATE.weights[sym] / 100) * (STATE.sides[sym] === "short" ? -1 : 1); }
function cashFrac() { return STATE.weights.CASH / 100; }

function liveStats() {
  // Reuses COV / ANN_RETURN / RF / portfolioVariance from js/markowitz.js
  // (WINDOW = 63 trading days) — one shared covariance source for every
  // "current weights" computation on the page.
  const w = ASSET_ORDER.map(signedFrac);
  const wObj = Object.fromEntries(ASSET_ORDER.map((sym, i) => [sym, w[i]]));
  const ret = ASSET_ORDER.reduce((s, sym, i) => s + w[i] * ANN_RETURN[sym], 0) + cashFrac() * RF;
  const variance = Math.max(portfolioVariance(wObj), 0);
  const vol = Math.sqrt(variance);
  const sharpe = vol > 0 ? (ret - RF) / vol : null;
  const beta = ASSET_ORDER.reduce((s, sym, i) => s + w[i] * DATA.assets[sym].capm.beta, 0);
  const alphaPct = ASSET_ORDER.reduce((s, sym, i) => s + w[i] * DATA.assets[sym].capm.alpha_annual_pct, 0);

  const sigmaW = COV.map(row => row.reduce((s, c, j) => s + c * w[j], 0));
  const contrib = {};
  ASSET_ORDER.forEach((sym, i) => { contrib[sym] = variance > 0 ? (w[i] * sigmaW[i]) / variance * 100 : 0; });
  contrib.CASH = 0;
  const sumSq = Object.values(contrib).reduce((s, c) => s + (c / 100) ** 2, 0);
  const enb = sumSq > 0 ? 1 / sumSq : ALL_KEYS.length;
  const diversification = Math.max(0, Math.min(100, ((enb - 1) / (ALL_KEYS.length - 1)) * 100));

  const dailyVol = vol / Math.sqrt(TRADING_DAYS);
  const capital = DATA.portfolio.capital_usd;
  return {
    ret, vol, sharpe, beta, alphaPct, contrib, diversification,
    var95_1d_pct: 1.645 * dailyVol * 100,
    var95_1d_usd: 1.645 * dailyVol * capital,
    capital, variance,
  };
}

// --- Control panel (drives sections 1, 2, 3's portfolio line, 6, 7) ---------

function normalizeOthersOnDrag(sym, newVal) {
  const others = ALL_KEYS.filter(k => k !== sym);
  const remaining = 100 - newVal;
  const othersSum = others.reduce((s, o) => s + STATE.weights[o], 0);
  if (othersSum <= 0.001) others.forEach(o => { STATE.weights[o] = remaining / others.length; });
  else others.forEach(o => { STATE.weights[o] = (STATE.weights[o] / othersSum) * remaining; });
  STATE.weights[sym] = newVal;
}

function renderControlPanel() {
  document.getElementById("control-sliders").innerHTML = ALL_KEYS.map(sym => {
    const isCash = sym === "CASH";
    const side = STATE.sides[sym];
    return `
    <div class="control-row" style="--slider-accent:${accentColor(sym)}">
      <div class="control-head">
        <span class="name"><span class="asset-dot" style="background:${accentColor(sym)}"></span>${sym}</span>
        ${isCash ? `<span class="side-tag cash">CAIXA</span>` : `<button type="button" class="side-toggle ${side}" data-sym="${sym}">${side === "short" ? "SHORT" : "LONG"}</button>`}
        <span class="val num" id="control-val-${sym}">${fmtNum(STATE.weights[sym], 1)}%</span>
      </div>
      <input type="range" min="0" max="100" step="0.5" id="control-slider-${sym}" value="${STATE.weights[sym]}" />
    </div>`;
  }).join("");

  ALL_KEYS.forEach(sym => {
    document.getElementById("control-slider-" + sym).addEventListener("input", e => {
      normalizeOthersOnDrag(sym, Math.max(0, Math.min(100, Number(e.target.value))));
      renderAll();
    });
  });
  document.querySelectorAll(".side-toggle").forEach(btn => {
    btn.addEventListener("click", () => {
      const sym = btn.dataset.sym;
      STATE.sides[sym] = STATE.sides[sym] === "short" ? "long" : "short";
      renderAll();
    });
  });
  document.getElementById("reset-control-btn").addEventListener("click", () => {
    STATE = { weights: { ...DEFAULT_STATE.weights }, sides: { ...DEFAULT_STATE.sides } };
    renderAll();
  });
  updateControlUI();
}

function updateControlUI() {
  ALL_KEYS.forEach(sym => {
    document.getElementById("control-slider-" + sym).value = STATE.weights[sym];
    document.getElementById("control-val-" + sym).textContent = fmtNum(STATE.weights[sym], 1) + "%";
  });
  document.querySelectorAll(".side-toggle").forEach(btn => {
    const sym = btn.dataset.sym;
    btn.className = "side-toggle " + STATE.sides[sym];
    btn.textContent = STATE.sides[sym] === "short" ? "SHORT" : "LONG";
  });
  const total = ALL_KEYS.reduce((s, k) => s + STATE.weights[k], 0);
  const totalEl = document.getElementById("control-total");
  totalEl.textContent = `Total: ${total.toFixed(0)}%`;
  totalEl.className = "slider-total" + (Math.abs(total - 100) < 0.6 ? " ok" : "");
}

// --- Section 1: Composição --------------------------------------------------

function renderComposition() {
  const capital = DATA.portfolio.capital_usd;
  const rows = ASSET_ORDER.map(sym => {
    const weight = STATE.weights[sym] / 100;
    const side = STATE.sides[sym];
    const price = DATA.assets[sym].stats.last_close;
    const value = weight * capital * (side === "short" ? -1 : 1);
    const qty = value / price;
    return { symbol: sym, weight, side, price, qty, value };
  });
  const cashWeight = STATE.weights.CASH / 100;
  const cashValue = cashWeight * capital;

  const pieLabels = [...ASSET_ORDER, "CASH"];
  const pieValues = [...ASSET_ORDER.map(sym => STATE.weights[sym]), STATE.weights.CASH];
  const pieColors = [...ASSET_ORDER.map(accentColor), accentColor("CASH")];

  if (pieChart) pieChart.destroy();
  pieChart = new Chart(document.getElementById("chart-composition").getContext("2d"), {
    type: "pie",
    data: { labels: pieLabels.map((l, i) => `${l} ${pieValues[i].toFixed(0)}%`), datasets: [{ data: pieValues, backgroundColor: pieColors, borderColor: cssVar("--bg"), borderWidth: 2 }] },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { position: "bottom", labels: { color: cssVar("--text-secondary"), font: { size: 11 }, padding: 12 } } },
    },
  });

  const rowsHtml = rows.map(r => `
    <tr class="${r.side === "short" ? "short-row" : ""}">
      <td class="asset-name-cell"><span class="asset-dot" style="background:${accentColor(r.symbol)}"></span>${r.symbol}<span class="side-tag ${r.side}">${r.side === "short" ? "SHORT" : "LONG"}</span></td>
      <td>${(r.weight * 100).toFixed(1)}%</td>
      <td class="num">$${fmtNum(r.price)}</td>
      <td class="num">${r.qty >= 0 ? "" : "-"}${fmtNum(Math.abs(r.qty), 0)}</td>
      <td class="num">${r.value >= 0 ? "" : "-"}$${fmtNum(Math.abs(r.value) / 1000, 0)}k</td>
    </tr>
  `).join("");

  document.getElementById("composition-table-body").innerHTML = rowsHtml + `
    <tr class="cash-row">
      <td class="asset-name-cell"><span class="asset-dot" style="background:${accentColor("CASH")}"></span>CASH<span class="side-tag cash">CAIXA</span></td>
      <td>${(cashWeight * 100).toFixed(1)}%</td>
      <td>—</td>
      <td>—</td>
      <td class="num">$${fmtNum(cashValue / 1000, 0)}k</td>
    </tr>
  `;
}

// --- Section 2: Correlação (heatmap values are asset-intrinsic and don't
// change with weights, but the interpretation below IS driven by STATE —
// it ranks pairs by how much they actually contribute to the CURRENT
// portfolio's variance, not just by raw |correlation|.) ----------------------

function corrColor(v) {
  const hexToRgb = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
  const rgbToStr = c => `rgb(${c[0]},${c[1]},${c[2]})`;
  const lerp = (a, b, t) => a.map((v2, i) => Math.round(v2 + (b[i] - v2) * t));
  const neg = hexToRgb(cssVar("--critical").trim() || "#F85149");
  const neu = hexToRgb("#1c2330");
  const pos = hexToRgb(cssVar("--good").trim() || "#3FB950");
  if (v >= 0) return rgbToStr(lerp(neu, pos, v));
  return rgbToStr(lerp(neu, neg, -v));
}

function renderCorrelation() {
  const corr = window.CORR_MATRIX;
  if (!corr) return;
  const order = ASSET_ORDER;

  const cells = [`<div></div>`];
  order.forEach(sym => cells.push(`<div class="corr-label">${sym}<span class="corr-label-w">${fmtNum(STATE.weights[sym], 0)}%${STATE.sides[sym] === "short" ? " S" : ""}</span></div>`));
  order.forEach((symRow, i) => {
    cells.push(`<div class="corr-label">${symRow}<span class="corr-label-w">${fmtNum(STATE.weights[symRow], 0)}%${STATE.sides[symRow] === "short" ? " S" : ""}</span></div>`);
    order.forEach((symCol, j) => {
      const v = corr[i][j];
      const textColor = Math.abs(v) > 0.55 ? "#0a0e14" : cssVar("--text-primary");
      cells.push(`<div class="corr-cell" style="background:${corrColor(v)}; color:${textColor}">${v.toFixed(2)}</div>`);
    });
  });
  document.getElementById("corr-grid-host").innerHTML = `<div class="corr-grid">${cells.join("")}</div>`;

  // Rank pairs by their actual contribution to the CURRENT portfolio's
  // variance (2 * w_i * w_j * Cov_ij / total variance) — this is what ties
  // the correlation section to the weights set in the control panel above,
  // rather than to a generic, weight-agnostic "most correlated pair" list.
  const w = order.map(signedFrac);
  const stats = liveStats();
  const pairs = [];
  for (let i = 0; i < order.length; i++) {
    for (let j = i + 1; j < order.length; j++) {
      const crossContrib = stats.variance > 0 ? (2 * w[i] * w[j] * COV[i][j]) / stats.variance * 100 : 0;
      pairs.push({ a: order[i], b: order[j], v: corr[i][j], contrib: crossContrib });
    }
  }
  const byContrib = [...pairs].sort((a, b) => Math.abs(b.contrib) - Math.abs(a.contrib));

  const describe = (p) => {
    const level = Math.abs(p.v) >= 0.6 ? "alta" : Math.abs(p.v) >= 0.3 ? "moderada" : "baixa";
    const sign = p.v >= 0 ? "positiva" : "negativa";
    let effectNote;
    const bothLong = STATE.sides[p.a] === "long" && STATE.sides[p.b] === "long";
    const effectiveSign = (STATE.sides[p.a] === "short" ? -1 : 1) * (STATE.sides[p.b] === "short" ? -1 : 1) * Math.sign(p.v || 1);
    if (bothLong) effectNote = p.v >= 0 ? "soma risco (as duas posições sobem/descem juntas)" : "efeito diversificador (tendem a compensar)";
    else effectNote = effectiveSign < 0 ? "efeito diversificador — o short inverte o sinal prático" : "soma risco mesmo com o short — atenção";
    return `<li><strong>${p.a} × ${p.b}</strong> correlação ${level} ${sign} (${fmtNum(p.v)}) · contribui <strong>${fmtPct(p.contrib, 1)}</strong> do risco da sua carteira atual — ${effectNote}</li>`;
  };

  document.getElementById("corr-interp").innerHTML = `
    <div class="info-title">📊 Interpretação (de acordo com os pesos definidos acima)</div>
    <ul>${byContrib.map(describe).join("")}</ul>
    <div class="div-score">Diversificação da carteira atual: <strong>${fmtNum(stats.diversification, 0)}%</strong> · volatilidade combinada: <strong>${fmtNum(stats.vol * 100, 1)}%</strong> a.a.</div>
  `;
}

// --- Section 3: Performance ---------------------------------------------------

function computeSeriesFromReturns(dates, rets) {
  const perf = [100.0];
  for (let i = 1; i < rets.length; i++) perf.push(perf[i - 1] * (1 + rets[i]));

  let peak = perf[0];
  const drawdown = perf.map(p => { peak = Math.max(peak, p); return (p / peak - 1) * 100; });

  const VOL_WINDOW = 21, SHARPE_WINDOW = 63;
  const rollVol = new Array(dates.length).fill(null);
  const rollSharpe = new Array(dates.length).fill(null);
  for (let i = VOL_WINDOW; i < dates.length; i++) {
    const window = rets.slice(i - VOL_WINDOW + 1, i + 1).filter(r => r !== null && r !== undefined);
    if (window.length < VOL_WINDOW - 1) continue;
    const m = window.reduce((a, b) => a + b, 0) / window.length;
    const varr = window.reduce((s, r) => s + (r - m) ** 2, 0) / (window.length - 1);
    rollVol[i] = Math.sqrt(varr) * Math.sqrt(TRADING_DAYS) * 100;
  }
  for (let i = SHARPE_WINDOW; i < dates.length; i++) {
    const window = rets.slice(i - SHARPE_WINDOW + 1, i + 1).filter(r => r !== null && r !== undefined);
    if (window.length < SHARPE_WINDOW - 1) continue;
    const m = window.reduce((a, b) => a + b, 0) / window.length;
    const varr = window.reduce((s, r) => s + (r - m) ** 2, 0) / (window.length - 1);
    const sd = Math.sqrt(varr);
    rollSharpe[i] = sd > 0 ? (m / sd) * Math.sqrt(TRADING_DAYS) : null;
  }

  return { dates, close: perf, perf_index: perf, drawdown_pct: drawdown, rolling_vol_pct: rollVol, rolling_sharpe: rollSharpe };
}

function computeLivePortfolioSeries() {
  const rets = [null];
  for (let i = 1; i < COMMON_DATES.length; i++) {
    const d = COMMON_DATES[i];
    let r = cashFrac() * DAILY_RF;
    ASSET_ORDER.forEach(sym => {
      const ar = ASSET_RET_BY_DATE[sym][d];
      if (ar !== undefined) r += signedFrac(sym) * ar;
    });
    rets.push(r);
  }
  return computeSeriesFromReturns(COMMON_DATES, rets);
}

function seriesSlice(series, days) {
  const n = series.dates.length;
  const start = days ? Math.max(0, n - days) : 0;
  return {
    dates: series.dates.slice(start),
    perf_index: series.perf_index.slice(start),
    drawdown_pct: series.drawdown_pct.slice(start),
    rolling_vol_pct: series.rolling_vol_pct.slice(start),
    rolling_sharpe: series.rolling_sharpe.slice(start),
  };
}

function baseLineOptions(yPrefix = "", ySuffix = "") {
  return {
    responsive: true, maintainAspectRatio: false, animation: false,
    interaction: { mode: "index", intersect: false },
    plugins: {
      legend: { display: false },
      tooltip: {
        backgroundColor: cssVar("--surface"), titleColor: cssVar("--text-primary"), bodyColor: cssVar("--text-secondary"),
        borderColor: cssVar("--border-strong"), borderWidth: 1, padding: 8,
        titleFont: { family: "IBM Plex Mono", size: 11 }, bodyFont: { family: "IBM Plex Mono", size: 11 },
      },
    },
    scales: {
      x: { grid: { display: false }, ticks: { color: cssVar("--text-muted"), maxTicksLimit: 7, font: { family: "IBM Plex Mono", size: 10 } } },
      y: { grid: { color: cssVar("--grid") }, ticks: { color: cssVar("--text-muted"), font: { family: "IBM Plex Mono", size: 10 }, callback: v => yPrefix + v + ySuffix } },
    },
  };
}

function renderPerformanceCharts(range) {
  currentRange = range;
  const livePortfolioSeries = computeLivePortfolioSeries();
  const labels = seriesSlice(livePortfolioSeries, range.days).dates.map(fmtDateShort);
  const lines = [
    ...ASSET_ORDER.map(sym => ({ sym, name: sym, color: accentColor(sym) })),
    { sym: "__PORT__", name: "Carteira", color: accentColor("PORT") },
  ];

  const mk = (key, canvasId, field, options) => {
    if (perfCharts[key]) perfCharts[key].destroy();
    const datasets = lines.map(l => {
      const series = l.sym === "__PORT__" ? livePortfolioSeries : DATA.assets[l.sym];
      const s = seriesSlice(series, range.days);
      return {
        label: l.name, data: s[field], borderColor: l.color, backgroundColor: "transparent",
        borderWidth: l.sym === "__PORT__" ? 2.5 : 1.5, pointRadius: 0, spanGaps: true, tension: 0.05,
      };
    });
    perfCharts[key] = new Chart(document.getElementById(canvasId).getContext("2d"), { type: "line", data: { labels, datasets }, options });
  };

  mk("price", "chart-price", "perf_index", baseLineOptions("", ""));
  mk("dd", "chart-dd", "drawdown_pct", baseLineOptions("", "%"));
  mk("vol", "chart-vol", "rolling_vol_pct", baseLineOptions("", "%"));
  mk("sharpe", "chart-sharpe", "rolling_sharpe", baseLineOptions("", ""));

  document.getElementById("perf-legend").innerHTML = lines.map(l => `<div class="legend-item"><span class="legend-dot" style="background:${l.color}"></span>${l.name}</div>`).join("");
}

function buildRangeButtons() {
  const el = document.getElementById("range-row");
  RANGES.forEach(r => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "range-btn" + (r.key === DEFAULT_RANGE_KEY ? " active" : "");
    btn.textContent = r.label;
    btn.addEventListener("click", () => {
      el.querySelectorAll(".range-btn").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      renderPerformanceCharts(r);
    });
    el.appendChild(btn);
  });
}

// --- Section 6: Métricas agregadas -------------------------------------------

function renderAggregateMetrics() {
  const m = liveStats();
  document.getElementById("agg-stats").innerHTML = `
    <div class="stat"><div class="label">Retorno esperado</div><div class="value num">${fmtPct(m.ret * 100)}</div><div class="note">anualizado, janela de ${WINDOW} pregões</div></div>
    <div class="stat"><div class="label">Volatilidade anualizada</div><div class="value num">${fmtNum(m.vol * 100, 1)}%</div><div class="note">com correlações entre posições</div></div>
    <div class="stat"><div class="label">Sharpe</div><div class="value num">${fmtNum(m.sharpe)}</div><div class="note">rf = CDI ${fmtNum(RF * 100, 1)}% a.a.</div></div>
    <div class="stat"><div class="label">Beta da carteira</div><div class="value num">${fmtNum(m.beta)}</div><div class="note">${m.beta >= 1 ? "mais agressiva que o mercado" : "mais defensiva que o mercado"}</div></div>
    <div class="stat"><div class="label">Alpha da carteira</div><div class="value num" style="color:${m.alphaPct >= 0 ? "var(--good-text)" : "var(--critical-text)"}">${fmtPct(m.alphaPct)}</div><div class="note">vs. CAPM (S&amp;P 500)</div></div>
    <div class="stat"><div class="label">Diversificação</div><div class="value num">${fmtNum(m.diversification, 0)}%</div><div class="note">nº efetivo de posições independentes</div></div>
    <div class="stat"><div class="label">VaR 95% (1 dia)</div><div class="value num" style="color:var(--critical-text)">-${fmtNum(m.var95_1d_pct, 2)}%</div><div class="note">≈ -${fmtUsd(m.var95_1d_usd)} sobre $${(m.capital / 1e6).toFixed(1)}M</div></div>
    <div class="stat"><div class="label">Capital de referência</div><div class="value num">$${(m.capital / 1e6).toFixed(1)}M</div><div class="note">usado para os valores em $</div></div>
  `;

  const contrib = m.contrib;
  const maxAbs = Math.max(...Object.values(contrib).map(Math.abs), 1);
  document.getElementById("risk-contrib-body").innerHTML = ALL_KEYS.map(sym => {
    const v = contrib[sym] || 0;
    const barColor = v < 0 ? cssVar("--good") : accentColor(sym);
    const barWidth = (Math.abs(v) / maxAbs) * 100;
    const barLeft = v < 0 ? 50 - barWidth / 2 : 50;
    return `<tr>
      <td class="asset-name-cell"><span class="asset-dot" style="background:${accentColor(sym)}"></span>${sym}</td>
      <td class="${v < 0 ? "neg" : ""}">${fmtPct(v, 1)}
        <span class="risk-bar-wrap"><span class="risk-bar" style="left:${barLeft}%; width:${Math.max(barWidth / 2, 1)}%; background:${barColor}"></span></span>
      </td>
    </tr>`;
  }).join("");
}

// --- Section 7: Recomendação --------------------------------------------------

function renderRecommendation() {
  const m = liveStats();
  const isAggressive = m.beta >= 1;
  const profileLabel = isAggressive ? "AGRESSIVA" : "MODERADA / DEFENSIVA";
  const profileColor = isAggressive ? "var(--critical-bg)" : "var(--good-bg)";
  const profileTextColor = isAggressive ? "var(--critical-text)" : "var(--good-text)";

  const capmMap = Object.fromEntries(ASSET_ORDER.map(s => [s, DATA.assets[s].capm]));
  const corr = window.CORR_MATRIX;
  const w = ASSET_ORDER.map(signedFrac);
  const pairs = [];
  if (corr) {
    for (let i = 0; i < ASSET_ORDER.length; i++) {
      for (let j = i + 1; j < ASSET_ORDER.length; j++) {
        const crossContrib = m.variance > 0 ? (2 * w[i] * w[j] * COV[i][j]) / m.variance * 100 : 0;
        pairs.push({ a: ASSET_ORDER[i], b: ASSET_ORDER[j], v: corr[i][j], contrib: crossContrib });
      }
    }
  }
  const biggestRiskPair = pairs.length ? pairs.reduce((max, p) => (Math.abs(p.contrib) > Math.abs(max.contrib) ? p : max)) : null;
  const activeSyms = ASSET_ORDER.filter(s => STATE.weights[s] > 0.5);
  const mostVolatile = activeSyms.length ? activeSyms.reduce((max, s) => (DATA.assets[s].stats.latest_rolling_vol_pct > DATA.assets[max].stats.latest_rolling_vol_pct ? s : max), activeSyms[0]) : null;
  const hasShort = ASSET_ORDER.some(s => STATE.sides[s] === "short" && STATE.weights[s] > 0.5);

  const strengths = [
    `Diversificação entre setores: ${activeSyms.join(", ") || "—"} reagem a diferentes motores macro.`,
    STATE.weights.GLD > 0.5 ? `Ouro (GLD, ${fmtNum(STATE.weights.GLD, 0)}%) tende a correlação mais baixa com os ativos de risco — ajuda a suavizar quedas concentradas em ações.` : null,
    hasShort ? ASSET_ORDER.filter(s => STATE.sides[s] === "short" && STATE.weights[s] > 0.5).map(s => `A posição SHORT em ${s} tem contribuição ao risco de ${fmtPct(m.contrib[s], 1)} — ${m.contrib[s] < 0 ? "negativa, reduz o risco total da carteira (hedge)." : "ainda soma risco, monitorar."}`).join(" ") : null,
    STATE.weights.CASH > 0.5 ? `Caixa de ${fmtNum(STATE.weights.CASH, 0)}% remunerado ao CDI (${fmtNum(RF * 100, 1)}% a.a.) dá um colchão de segurança e liquidez.` : null,
  ].filter(Boolean);

  const risks = [
    biggestRiskPair ? `${biggestRiskPair.a} × ${biggestRiskPair.b}: correlação ${fmtNum(biggestRiskPair.v)}, responde por ${fmtPct(Math.abs(biggestRiskPair.contrib), 1)} do risco combinado — o maior par de risco na carteira atual.` : null,
    mostVolatile ? `${mostVolatile} é a posição mais volátil no momento (${fmtNum(DATA.assets[mostVolatile].stats.latest_rolling_vol_pct, 1)}% anualizada) — maior sensibilidade a notícias específicas do setor.` : null,
    hasShort ? `Posições short precisam de monitoramento ativo: um rally forte no ativo gera perda na posição, mesmo com o resto da carteira subindo.` : null,
    `Beta da carteira de ${fmtNum(m.beta)} ${isAggressive ? "acima de 1 — a carteira amplifica movimentos do mercado." : "abaixo de 1, mas concentração em poucas posições ainda pode reduzir a diversificação real."}`,
  ].filter(Boolean);

  const mk = window.MARKOWITZ_RESULT;
  let mkLine = "";
  if (mk) {
    const sig = ASSET_ORDER.filter(s => mk.w[s] > 0.005).sort((a, b) => mk.w[b] - mk.w[a]);
    const kScale = m.vol > 0 && mk.vol > 0 ? Math.min(1, m.vol / mk.vol) : 0;
    const cashPct = 100 - kScale * 100;
    const weightsStr = sig.map(s => `${s} ${(mk.w[s] * kScale * 100).toFixed(0)}%`).join(", ");
    mkLine = `Se quer <strong>máximo Sharpe mantendo o risco atual</strong> (~${fmtNum(m.vol * 100, 1)}% de vol.): <strong>${weightsStr}, Cash ${cashPct.toFixed(0)}%</strong> (mix long-only entre as 5 posições — veja a seção 4; não simula shorts).`;
  }

  document.getElementById("reco-card").innerHTML = `
    <h2>📊 Análise da carteira</h2>
    <div class="reco-profile" style="background:${profileColor}; color:${profileTextColor}">Perfil: ${profileLabel} (beta ${fmtNum(m.beta)})</div>
    <div class="reco-cols">
      <div class="reco-block">
        <h4>Pontos fortes</h4>
        <ul>${strengths.length ? strengths.map(s => `<li>${s}</li>`).join("") : "<li>Ajuste os pesos acima para ver a análise.</li>"}</ul>
      </div>
      <div class="reco-block">
        <h4>Riscos</h4>
        <ul>${risks.map(s => `<li>${s}</li>`).join("")}</ul>
      </div>
    </div>
    <div class="reco-block">
      <h4>Comparação vs. benchmark</h4>
      <table class="reco-bench-table">
        <tr><td>vs. S&amp;P 500 (CAPM)</td><td style="color:${m.alphaPct >= 0 ? "var(--good-text)" : "var(--critical-text)"}">${fmtPct(m.alphaPct)} alpha</td></tr>
        <tr><td>Retorno esperado da carteira atual (anualizado)</td><td>${fmtPct(m.ret * 100)}</td></tr>
      </table>
    </div>
    ${mkLine ? `<div class="reco-mk">🏆 Sugestão Markowitz: ${mkLine}</div>` : ""}
    <div class="reco-footnote">Análise gerada a partir de dados históricos e dos pesos definidos no painel acima — atualiza em tempo real. Não constitui recomendação de investimento. Retorno passado não garante retorno futuro.</div>
  `;
}

// --- Orchestration --------------------------------------------------------

function renderAll() {
  updateControlUI();
  renderComposition();
  renderCorrelation();
  renderPerformanceCharts(currentRange || RANGES.find(r => r.key === DEFAULT_RANGE_KEY));
  renderAggregateMetrics();
  renderRecommendation();
}

// --- Shell / init --------------------------------------------------------

function renderShell() {
  const updated = new Date(DATA.generated_at_utc);
  document.getElementById("app-root").innerHTML = `
    <header class="top">
      <div>
        <h1>Carteira JGP</h1>
        <div class="sub">XLK · XLE · EWZ · XLY · GLD + caixa — dashboard interativo de risco e retorno</div>
      </div>
      <div class="updated">Dados atualizados em<br><strong>${updated.toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" })} (UTC)</strong></div>
    </header>
    <div class="disclaimer-banner">⚠️ Ferramenta educacional/analítica. Todos os números vêm de dados históricos (Yahoo Finance) e não constituem recomendação de investimento — retorno passado não garante retorno futuro.</div>

    <div class="section-title">Ajuste a carteira</div>
    <div class="section-sub">Mude o peso e o lado (long/short) de cada posição — composição, correlação, performance, métricas e recomendação abaixo atualizam em tempo real.</div>
    <div class="control-panel">
      <div id="control-sliders"></div>
      <div class="slider-total" id="control-total">Total: 100%</div>
      <button type="button" class="reset-btn" id="reset-control-btn">↺ Restaurar carteira original</button>
    </div>

    <div class="section-title">1 · Composição da carteira</div>
    <div class="comp-grid">
      <div class="comp-pie-card"><div class="canvas-wrap"><canvas id="chart-composition"></canvas></div></div>
      <div class="comp-table-card">
        <table class="comp-table">
          <thead><tr><th>Ativo</th><th>Peso</th><th>Preço</th><th>Quantidade</th><th>Valor</th></tr></thead>
          <tbody id="composition-table-body"></tbody>
        </table>
      </div>
    </div>

    <div class="section-title">2 · Matriz de correlação</div>
    <div class="corr-wrap">
      <div class="corr-scroll"><div id="corr-grid-host"></div></div>
      <div class="corr-scale"><span>-1 (inversa)</span><span class="bar"></span><span>+1 (junto)</span></div>
      <div class="info-card" id="corr-interp"></div>
    </div>

    <div class="section-title">3 · Performance</div>
    <div class="section-sub">A linha "Carteira" usa os pesos definidos no painel acima (short e caixa incluídos — caixa aproximado pela taxa CDI atual aplicada ao histórico todo).</div>
    <div class="range-row" id="range-row"></div>
    <div class="charts-grid">
      <div class="chart-card"><h3>Preço (indexado a 100)</h3><div class="desc">Evolução de cada posição e da carteira agregada</div><div class="canvas-wrap"><canvas id="chart-price"></canvas></div></div>
      <div class="chart-card"><h3>Drawdown</h3><div class="desc">Queda percentual em relação ao topo do período</div><div class="canvas-wrap"><canvas id="chart-dd"></canvas></div></div>
      <div class="chart-card"><h3>Volatilidade rolante (21p, anualizada)</h3><div class="desc">Desvio-padrão dos retornos diários</div><div class="canvas-wrap"><canvas id="chart-vol"></canvas></div></div>
      <div class="chart-card"><h3>Sharpe rolante (63p, anualizado)</h3><div class="desc">Retorno/risco, rf = 0%</div><div class="canvas-wrap"><canvas id="chart-sharpe"></canvas></div></div>
    </div>
    <div class="chart-legend" id="perf-legend"></div>

    <div class="section-title">4 · Medidas econométricas (Markowitz)</div>
    <div class="section-sub">Simulador independente, long-only entre as 5 posições (fronteira e ótimo de Markowitz não simulam short nem caixa) — para explorar combinações teóricas, não a sua carteira atual do painel acima.</div>
    <div class="sim-card">
      <div id="sliders-host"></div>
      <div class="slider-total" id="slider-total">Total: 100%</div>
      <div class="sim-results" id="sim-results"></div>
    </div>
    <div class="chart-card" style="margin-top:16px">
      <h3>Fronteira eficiente</h3>
      <div class="desc">Cada ponto cinza é uma combinação de pesos possível (long-only); os pontos coloridos são os ativos isolados, sua simulação e o ótimo de Markowitz.</div>
      <div class="canvas-wrap" style="height:340px"><canvas id="chart-frontier"></canvas></div>
      <div class="legend-row" id="frontier-legend"></div>
    </div>
    <div class="section-title" style="margin-top:26px">Recomendação Markowitz</div>
    <div class="markowitz-card" id="markowitz-card"></div>

    <div class="section-title">5 · CAPM (Capital Asset Pricing Model)</div>
    <div class="section-sub">Beta e alpha de cada posição vs. S&amp;P 500 (^GSPC), últimos ${DATA.capm_window_days} pregões — não muda com os pesos, é uma propriedade de cada ativo.</div>
    <div class="capm-table-wrap"><table class="capm-table" id="capm-table"></table></div>
    <div class="chart-card"><h3>Beta por posição</h3><div class="desc">1.0 = mesma volatilidade do S&amp;P 500</div><div class="canvas-wrap" style="height:200px"><canvas id="chart-capm-beta"></canvas></div></div>

    <div class="section-title">6 · Métricas agregadas da carteira</div>
    <div class="agg-note">Calculado a partir dos pesos definidos no painel "Ajuste a carteira" acima, janela de ${WINDOW} pregões, pesos assinados (short entra negativo).</div>
    <div class="stats-row" id="agg-stats"></div>
    <div class="chart-card">
      <h3>Contribuição ao risco por posição</h3>
      <div class="desc">Decomposição de Euler da variância da carteira — valores negativos reduzem o risco total (hedge).</div>
      <table class="risk-contrib-table"><thead><tr><th>Posição</th><th>Contribuição ao risco</th></tr></thead><tbody id="risk-contrib-body"></tbody></table>
    </div>

    <div class="section-title">7 · Recomendação e análise</div>
    <div class="reco-card" id="reco-card"></div>

    <footer>
      Fonte de preços: Yahoo Finance (fechamento diário, não ajustado por proventos). Benchmark CAPM: S&amp;P 500 (^GSPC). Taxa livre de risco: CDI anualizado (Banco Central, série SGS 12).
      Seções 1, 2, 3 (linha "Carteira"), 6 e 7 recalculam ao vivo, no navegador, a partir dos pesos definidos no painel "Ajuste a carteira". Seção 4 é um simulador long-only independente. Seção 5 (CAPM) é por ativo e não depende dos pesos.
      Dados de preço atualizados automaticamente via GitHub Actions. Esta página é uma ferramenta de análise histórica, não uma recomendação de investimento.
    </footer>
  `;
}

async function loadData() {
  const bust = Date.now();
  const res = await fetch(`data/portfolio_data.json?t=${bust}`, { cache: "no-store" });
  if (!res.ok) throw new Error("Falha ao carregar data/portfolio_data.json.");
  DATA = await res.json();
  ASSET_NAME = Object.fromEntries(DATA.portfolio.positions.map(p => [p.symbol, p.name]));

  DEFAULT_STATE = { weights: {}, sides: {} };
  DATA.portfolio.positions.forEach(p => { DEFAULT_STATE.weights[p.symbol] = p.weight * 100; DEFAULT_STATE.sides[p.symbol] = p.side; });
  DEFAULT_STATE.weights.CASH = DATA.portfolio.cash_weight * 100;
  STATE = { weights: { ...DEFAULT_STATE.weights }, sides: { ...DEFAULT_STATE.sides } };

  // Precompute the common trading-date calendar and each asset's daily
  // return-by-date map, used to rebuild the "Carteira" line for ANY weights
  // without another server round-trip.
  let dates = DATA.assets[ASSET_ORDER[0]].dates;
  ASSET_ORDER.slice(1).forEach(sym => {
    const set = new Set(DATA.assets[sym].dates);
    dates = dates.filter(d => set.has(d));
  });
  COMMON_DATES = [...dates].sort();

  ASSET_RET_BY_DATE = {};
  ASSET_ORDER.forEach(sym => {
    const a = DATA.assets[sym];
    const byDate = {};
    for (let i = 1; i < a.dates.length; i++) byDate[a.dates[i]] = a.close[i] / a.close[i - 1] - 1;
    ASSET_RET_BY_DATE[sym] = byDate;
  });

  DAILY_RF = Math.pow(1 + DATA.risk_free.rf_annual_pct / 100, 1 / 252) - 1;
}

async function init() {
  const root = document.getElementById("app-root");
  try {
    await loadData();
  } catch (err) {
    root.innerHTML = `<div class="load-error">Não foi possível carregar os dados: ${err.message}</div>`;
    return;
  }
  renderShell();
  renderControlPanel();
  buildRangeButtons();
  initMarkowitz(DATA);      // js/markowitz.js — its own long-only simulator, correlation math (CORR/COV/ANN_RETURN/RF), frontier
  renderCapm(DATA);         // js/capm.js
  renderAll();
}

init();
