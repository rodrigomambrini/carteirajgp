/*
 * Carteira JGP — main orchestrator and the interactive "Ajuste a carteira"
 * control panel.
 *
 * WEIGHTS ARE INDEPENDENT. Moving one position's slider changes only that
 * position; cash is the slack variable that absorbs the difference
 * (cash = 100% - sum of all position weights, shorts included — per
 * Rodrigo's explicit rule, a short consumes allocation rather than
 * crediting cash). A slider is clamped so the allocated total can never
 * exceed 100%, which keeps cash >= 0 and the grand total at exactly 100%.
 *
 * Everything below the panel recomputes from STATE on every change:
 * composition, the correlation section's ranking, the "Carteira" line,
 * aggregate metrics and the written analysis.
 *
 * DATA FRESHNESS: the browser cannot fetch Yahoo Finance directly (their
 * chart API sends no CORS headers) and public CORS proxies rate-limit within
 * minutes of light use — both verified by testing, not assumed. So
 * scripts/fetch_and_compute.py runs every 15 minutes during market hours via
 * GitHub Actions and commits data/portfolio_data.json, and this page fetches
 * that file cache-busted on every load. A refresh therefore shows prices
 * that are at most one cron interval old, with no manual step.
 *
 * js/stats.js computes COV/CORR/ANN_RETURN/SIGMA/RF; js/capm.js renders the
 * CAPM table. All three files share one global scope (classic <script> tags,
 * no modules), loaded capm.js -> stats.js -> app.js.
 */

const ASSET_ORDER = ["XLK", "XLE", "EWZ", "XLY", "GLD"];
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
let DEFAULT_STATE = null;
let STATE = null;
let currentRange = null;
const perfCharts = {};
let pieChart = null;

let COMMON_DATES = [];
let ASSET_RET_BY_DATE = {};
let DAILY_RF = 0;

function fmtPct(v, digits = 2) { if (v === null || v === undefined || Number.isNaN(v)) return "—"; return (v >= 0 ? "+" : "") + v.toFixed(digits) + "%"; }
function fmtNum(v, digits = 2) { if (v === null || v === undefined || Number.isNaN(v)) return "—"; return v.toFixed(digits); }
function fmtMoney(v) { if (v === null || v === undefined) return "—"; const sign = v < 0 ? "-" : ""; return `${sign}$${(Math.abs(v) / 1e6).toFixed(1)}M`; }
function fmtVolume(v) { if (!v) return "—"; return v >= 1e6 ? (v / 1e6).toFixed(1) + "M" : (v / 1e3).toFixed(0) + "k"; }
function fmtDateShort(iso) { const [y, m, d] = iso.split("-"); return d + "/" + m + "/" + y.slice(2); }
function cssVar(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }
function accentColor(sym) { return cssVar(ACCENT_VAR[sym]); }

// --- STATE ------------------------------------------------------------------

function allocatedPct() { return ASSET_ORDER.reduce((s, sym) => s + STATE.weights[sym], 0); }
function cashPct() { return Math.max(0, 100 - allocatedPct()); }
function signedFrac(sym) { return (STATE.weights[sym] / 100) * (STATE.sides[sym] === "short" ? -1 : 1); }
function cashFrac() { return cashPct() / 100; }

// Independent weights: only `sym` moves. Clamped so the allocated total can't
// pass 100% — the remainder is cash, which must stay >= 0.
function setWeight(sym, value) {
  const others = allocatedPct() - STATE.weights[sym];
  STATE.weights[sym] = Math.max(0, Math.min(Number(value) || 0, 100 - others));
}

function liveStats() {
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
  const enb = sumSq > 0 ? 1 / sumSq : ASSET_ORDER.length + 1;
  const diversification = Math.max(0, Math.min(100, ((enb - 1) / ASSET_ORDER.length) * 100));

  const dailyVol = vol / Math.sqrt(TRADING_DAYS);
  const capital = DATA.portfolio.capital_usd;
  return {
    ret, vol, sharpe, beta, alphaPct, contrib, diversification, variance, capital,
    var95_1d_pct: 1.645 * dailyVol * 100,
    var95_1d_usd: 1.645 * dailyVol * capital,
  };
}

// --- Section 1: control panel ------------------------------------------------

function renderControlPanel() {
  document.getElementById("control-sliders").innerHTML = ASSET_ORDER.map(sym => `
    <div class="control-row" style="--slider-accent:${accentColor(sym)}">
      <div class="control-head">
        <span class="name"><span class="asset-dot" style="background:${accentColor(sym)}"></span>${sym}</span>
        <button type="button" class="side-toggle ${STATE.sides[sym]}" data-sym="${sym}">${STATE.sides[sym] === "short" ? "SHORT" : "LONG"}</button>
        <span class="control-value">
          <input type="number" class="weight-input num" id="control-input-${sym}" min="0" max="100" step="0.5" value="${STATE.weights[sym]}" />%
        </span>
      </div>
      <input type="range" min="0" max="100" step="0.5" id="control-slider-${sym}" value="${STATE.weights[sym]}" />
    </div>
  `).join("") + `
    <div class="control-row cash-row-control">
      <div class="control-head">
        <span class="name"><span class="asset-dot" style="background:${accentColor("CASH")}"></span>CASH</span>
        <span class="side-tag cash">AUTOMÁTICO</span>
        <span class="control-value"><span class="num" id="control-val-CASH">—</span></span>
      </div>
      <div class="cash-bar"><div class="cash-bar-fill" id="cash-bar-fill"></div></div>
      <div class="cash-note">O caixa completa o que sobra para fechar 100% — não é ajustável direto.</div>
    </div>`;

  ASSET_ORDER.forEach(sym => {
    const slider = document.getElementById("control-slider-" + sym);
    const input = document.getElementById("control-input-" + sym);
    const apply = v => { setWeight(sym, v); renderAll(); };
    slider.addEventListener("input", e => apply(e.target.value));
    input.addEventListener("change", e => apply(e.target.value));
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
}

function updateControlUI() {
  ASSET_ORDER.forEach(sym => {
    document.getElementById("control-slider-" + sym).value = STATE.weights[sym];
    document.getElementById("control-input-" + sym).value = Number(STATE.weights[sym].toFixed(1));
    const btn = document.querySelector(`.side-toggle[data-sym="${sym}"]`);
    btn.className = "side-toggle " + STATE.sides[sym];
    btn.textContent = STATE.sides[sym] === "short" ? "SHORT" : "LONG";
  });
  const cash = cashPct();
  document.getElementById("control-val-CASH").textContent = fmtNum(cash, 1) + "%";
  document.getElementById("cash-bar-fill").style.width = cash + "%";
  const totalEl = document.getElementById("control-total");
  totalEl.innerHTML = `Alocado: <strong>${fmtNum(allocatedPct(), 1)}%</strong> · Caixa: <strong>${fmtNum(cash, 1)}%</strong> · Total: <strong>100%</strong>`;
  totalEl.className = "slider-total" + (cash <= 0.01 ? " maxed" : " ok");
}

// --- Section 2: Composição ---------------------------------------------------

function renderComposition() {
  const capital = DATA.portfolio.capital_usd;
  const rows = ASSET_ORDER.map(sym => {
    const weight = STATE.weights[sym] / 100;
    const side = STATE.sides[sym];
    const price = DATA.assets[sym].quote?.last_price ?? DATA.assets[sym].stats.last_close;
    const value = weight * capital * (side === "short" ? -1 : 1);
    return { symbol: sym, weight, side, price, qty: value / price, value };
  });
  const cash = cashFrac();

  const pieValues = [...ASSET_ORDER.map(sym => STATE.weights[sym]), cashPct()];
  const pieLabels = [...ASSET_ORDER, "CASH"];
  const pieColors = [...ASSET_ORDER.map(accentColor), accentColor("CASH")];

  if (pieChart) pieChart.destroy();
  pieChart = new Chart(document.getElementById("chart-composition").getContext("2d"), {
    type: "pie",
    data: { labels: pieLabels.map((l, i) => `${l} ${pieValues[i].toFixed(1)}%`), datasets: [{ data: pieValues, backgroundColor: pieColors, borderColor: cssVar("--bg"), borderWidth: 2 }] },
    options: {
      responsive: true, maintainAspectRatio: false, animation: false,
      plugins: { legend: { position: "bottom", labels: { color: cssVar("--text-secondary"), font: { size: 11 }, padding: 10 } } },
    },
  });

  document.getElementById("composition-table-body").innerHTML = rows.map(r => `
    <tr class="${r.side === "short" ? "short-row" : ""}">
      <td class="asset-name-cell"><span class="asset-dot" style="background:${accentColor(r.symbol)}"></span>${r.symbol}<span class="side-tag ${r.side}">${r.side === "short" ? "SHORT" : "LONG"}</span></td>
      <td>${(r.weight * 100).toFixed(1)}%</td>
      <td class="num">$${fmtNum(r.price)}</td>
      <td class="num">${r.qty >= 0 ? "" : "-"}${Math.round(Math.abs(r.qty)).toLocaleString("en-US")}</td>
      <td class="num">${fmtMoney(r.value)}</td>
    </tr>
  `).join("") + `
    <tr class="cash-row">
      <td class="asset-name-cell"><span class="asset-dot" style="background:${accentColor("CASH")}"></span>CASH<span class="side-tag cash">CAIXA</span></td>
      <td>${(cash * 100).toFixed(1)}%</td>
      <td>—</td>
      <td>—</td>
      <td class="num">${fmtMoney(cash * capital)}</td>
    </tr>
    <tr class="total-row">
      <td>TOTAL</td>
      <td>100.0%</td>
      <td>—</td>
      <td>—</td>
      <td class="num">${fmtMoney(capital)}</td>
    </tr>`;
}

// Static order book from data/portfolio.json — the individual lots behind the
// aggregate weights above (three separate XLK tickets, etc). Not affected by
// the sliders: it records what was actually sent to the market.
function renderOrders() {
  const lots = DATA.portfolio.lots || [];
  document.getElementById("orders-table-body").innerHTML = lots.map(l => {
    const pending = l.status === "pendente";
    return `<tr>
      <td class="asset-name-cell"><span class="asset-dot" style="background:${accentColor(l.symbol)}"></span>${l.symbol}<span class="side-tag ${l.side}">${l.side === "short" ? "SHORT" : "LONG"}</span></td>
      <td>${(l.weight * 100).toFixed(0)}%</td>
      <td class="num">${fmtMoney(l.weight * DATA.portfolio.capital_usd * (l.side === "short" ? -1 : 1))}</td>
      <td>${l.order_type}</td>
      <td class="num">${l.trigger_price ? "$" + fmtNum(l.trigger_price) : "—"}</td>
      <td><span class="status-badge ${pending ? "pending" : "done"}">${pending ? "Pendente" : "Executada"}</span>${l.note ? `<span class="status-note">${l.note}</span>` : ""}</td>
    </tr>`;
  }).join("");
}

function renderQuotes() {
  document.getElementById("quotes-strip").innerHTML = ASSET_ORDER.map(sym => {
    const q = DATA.assets[sym].quote || {};
    const price = q.last_price ?? DATA.assets[sym].stats.last_close;
    const chg = q.change_pct;
    const up = (chg ?? 0) >= 0;
    return `<div class="quote-card" style="--q-accent:${accentColor(sym)}">
      <div class="quote-head"><span class="asset-dot" style="background:${accentColor(sym)}"></span><strong>${sym}</strong>
        <span class="pill ${up ? "up" : "down"}">${up ? "&#9650;" : "&#9660;"} ${fmtPct(chg ?? 0)}</span></div>
      <div class="quote-price num">$${fmtNum(price)}</div>
      <div class="quote-meta num">A ${fmtNum(q.open)} · Máx ${fmtNum(q.day_high)} · Mín ${fmtNum(q.day_low)} · Vol ${fmtVolume(q.volume)}</div>
    </div>`;
  }).join("");
}

// --- Section 3: Correlação ---------------------------------------------------

function corrColor(v) {
  const hexToRgb = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
  const lerp = (a, b, t) => a.map((x, i) => Math.round(x + (b[i] - x) * t));
  const neg = hexToRgb(cssVar("--critical").trim() || "#F85149");
  const neu = hexToRgb("#1c2330");
  const pos = hexToRgb(cssVar("--good").trim() || "#3FB950");
  const c = v >= 0 ? lerp(neu, pos, v) : lerp(neu, neg, -v);
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}

function renderCorrelation() {
  const corr = window.CORR_MATRIX;
  if (!corr) return;

  const cells = [`<div></div>`];
  const label = sym => `<div class="corr-label">${sym}<span class="corr-label-w">${fmtNum(STATE.weights[sym], 0)}%${STATE.sides[sym] === "short" ? " S" : ""}</span></div>`;
  ASSET_ORDER.forEach(sym => cells.push(label(sym)));
  ASSET_ORDER.forEach((symRow, i) => {
    cells.push(label(symRow));
    ASSET_ORDER.forEach((symCol, j) => {
      const v = corr[i][j];
      const textColor = Math.abs(v) > 0.55 ? "#0a0e14" : cssVar("--text-primary");
      cells.push(`<div class="corr-cell" style="background:${corrColor(v)}; color:${textColor}">${v.toFixed(2)}</div>`);
    });
  });
  document.getElementById("corr-grid-host").innerHTML = `<div class="corr-grid">${cells.join("")}</div>`;

  // Pairs ranked by their real share of the CURRENT portfolio's variance
  // (2*w_i*w_j*Cov_ij / variance, signed weights) rather than by raw
  // |correlation| — this is what ties the matrix to the weights above.
  const w = ASSET_ORDER.map(signedFrac);
  const stats = liveStats();
  const pairs = [];
  for (let i = 0; i < ASSET_ORDER.length; i++) {
    for (let j = i + 1; j < ASSET_ORDER.length; j++) {
      pairs.push({
        a: ASSET_ORDER[i], b: ASSET_ORDER[j], v: corr[i][j],
        contrib: stats.variance > 0 ? (2 * w[i] * w[j] * COV[i][j]) / stats.variance * 100 : 0,
      });
    }
  }
  pairs.sort((x, y) => Math.abs(y.contrib) - Math.abs(x.contrib));

  // The note is derived from the CONTRIBUTION's sign, never from the
  // correlation's: the matrix measures the full price history while the
  // contribution measures the last WINDOW pregões with the current weights,
  // so the two can legitimately disagree in sign. Reading the note off the
  // correlation would then contradict the number printed right next to it.
  const describe = p => {
    const level = Math.abs(p.v) >= 0.6 ? "alta" : Math.abs(p.v) >= 0.3 ? "moderada" : "baixa";
    const sign = p.v >= 0 ? "positiva" : "negativa";
    const hasShort = STATE.sides[p.a] === "short" || STATE.sides[p.b] === "short";
    let note;
    if (Math.abs(p.contrib) < 0.05) {
      note = `<span class="pair-idle">peso ~0 na carteira, impacto desprezível</span>`;
    } else if (p.contrib > 0) {
      note = "soma risco à carteira" + (hasShort ? " mesmo com o short — atenção" : "");
    } else {
      note = "reduz o risco da carteira (efeito hedge)" + (hasShort ? " — o short inverte o sinal da correlação" : "");
    }
    return `<li><strong>${p.a} × ${p.b}</strong> correlação ${level} ${sign} (${fmtNum(p.v)}) · contribui <strong>${fmtPct(p.contrib, 1)}</strong> do risco da carteira atual — ${note}</li>`;
  };

  document.getElementById("corr-interp").innerHTML = `
    <div class="info-title">📊 Interpretação (com os pesos definidos acima)</div>
    <ul>${pairs.map(describe).join("")}</ul>
    <div class="div-score">Diversificação da carteira atual: <strong>${fmtNum(stats.diversification, 0)}%</strong> · volatilidade combinada: <strong>${fmtNum(stats.vol * 100, 1)}%</strong> a.a.</div>
    <div class="window-note">A correlação da matriz usa todo o histórico carregado (~11 anos, estimativa mais estável). A contribuição ao risco usa os últimos ${WINDOW} pregões com os seus pesos atuais — por isso um par pode ter correlação positiva no longo prazo e estar reduzindo o risco da carteira agora.</div>
  `;
}

// --- Section 4: Performance ---------------------------------------------------

function computeSeriesFromReturns(dates, rets) {
  const perf = [100.0];
  for (let i = 1; i < rets.length; i++) perf.push(perf[i - 1] * (1 + rets[i]));

  let peak = perf[0];
  const drawdown = perf.map(p => { peak = Math.max(peak, p); return (p / peak - 1) * 100; });

  const VOL_W = 21, SHARPE_W = 63;
  const rollVol = new Array(dates.length).fill(null);
  const rollSharpe = new Array(dates.length).fill(null);
  const stat = arr => {
    const m = arr.reduce((a, b) => a + b, 0) / arr.length;
    const v = arr.reduce((s, r) => s + (r - m) ** 2, 0) / (arr.length - 1);
    return { m, sd: Math.sqrt(v) };
  };
  for (let i = VOL_W; i < dates.length; i++) {
    const win = rets.slice(i - VOL_W + 1, i + 1).filter(r => r != null);
    if (win.length < VOL_W - 1) continue;
    rollVol[i] = stat(win).sd * Math.sqrt(TRADING_DAYS) * 100;
  }
  for (let i = SHARPE_W; i < dates.length; i++) {
    const win = rets.slice(i - SHARPE_W + 1, i + 1).filter(r => r != null);
    if (win.length < SHARPE_W - 1) continue;
    const { m, sd } = stat(win);
    rollSharpe[i] = sd > 0 ? (m / sd) * Math.sqrt(TRADING_DAYS) : null;
  }
  return { dates, perf_index: perf, drawdown_pct: drawdown, rolling_vol_pct: rollVol, rolling_sharpe: rollSharpe };
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
  const out = { dates: series.dates.slice(start) };
  ["close", "perf_index", "drawdown_pct", "rolling_vol_pct", "rolling_sharpe"].forEach(k => {
    if (series[k]) out[k] = series[k].slice(start);
  });
  // Re-base an indexed series so it starts at 100 within the visible window.
  if (out.perf_index && out.perf_index.length) {
    const base = out.perf_index[0];
    out.perf_index = out.perf_index.map(v => (v / base) * 100);
  }
  return out;
}

function baseLineOptions({ yPrefix = "", ySuffix = "", log = false } = {}) {
  return {
    responsive: true, maintainAspectRatio: false, animation: false,
    interaction: { mode: "index", intersect: false },
    plugins: {
      legend: { display: false },
      tooltip: {
        backgroundColor: cssVar("--surface"), titleColor: cssVar("--text-primary"), bodyColor: cssVar("--text-secondary"),
        borderColor: cssVar("--border-strong"), borderWidth: 1, padding: 8,
        titleFont: { family: "IBM Plex Mono", size: 11 }, bodyFont: { family: "IBM Plex Mono", size: 11 },
        callbacks: { label: ctx => `${ctx.dataset.label}: ${yPrefix}${ctx.parsed.y.toFixed(2)}${ySuffix}` },
      },
    },
    scales: {
      x: { grid: { display: false }, ticks: { color: cssVar("--text-muted"), maxTicksLimit: 7, font: { family: "IBM Plex Mono", size: 10 } } },
      y: {
        type: log ? "logarithmic" : "linear",
        grid: { color: cssVar("--grid") },
        ticks: {
          color: cssVar("--text-muted"), font: { family: "IBM Plex Mono", size: 10 },
          callback: v => yPrefix + (log ? Number(v).toFixed(0) : v) + ySuffix,
        },
      },
    },
  };
}

function renderPerformanceCharts(range) {
  currentRange = range;
  const portfolio = computeLivePortfolioSeries();
  const labels = seriesSlice(portfolio, range.days).dates.map(fmtDateShort);

  const assetLines = ASSET_ORDER.map(sym => ({ sym, name: sym, color: accentColor(sym) }));
  const withPortfolio = [...assetLines, { sym: "__PORT__", name: "Carteira", color: accentColor("PORT") }];

  const mk = (key, canvasId, field, lines, options) => {
    if (perfCharts[key]) perfCharts[key].destroy();
    const datasets = lines.map(l => {
      const series = l.sym === "__PORT__" ? portfolio : DATA.assets[l.sym];
      return {
        label: l.name, data: seriesSlice(series, range.days)[field],
        borderColor: l.color, backgroundColor: "transparent",
        borderWidth: l.sym === "__PORT__" ? 2.5 : 1.5, pointRadius: 0, spanGaps: true, tension: 0.05,
      };
    });
    perfCharts[key] = new Chart(document.getElementById(canvasId).getContext("2d"), { type: "line", data: { labels, datasets }, options });
  };

  // Real USD prices. Log y-axis because the five trade at very different
  // levels (GLD ~$390 vs EWZ ~$38) — on a linear axis the cheaper names
  // flatten into the baseline and their moves become unreadable. The
  // portfolio has no per-share price, so it's absent here and shown on the
  // indexed chart instead.
  mk("priceUsd", "chart-price-usd", "close", assetLines, baseLineOptions({ yPrefix: "$", log: true }));
  mk("priceIdx", "chart-price-idx", "perf_index", withPortfolio, baseLineOptions());
  mk("dd", "chart-dd", "drawdown_pct", withPortfolio, baseLineOptions({ ySuffix: "%" }));
  mk("vol", "chart-vol", "rolling_vol_pct", withPortfolio, baseLineOptions({ ySuffix: "%" }));
  mk("sharpe", "chart-sharpe", "rolling_sharpe", withPortfolio, baseLineOptions());

  document.getElementById("perf-legend").innerHTML = withPortfolio
    .map(l => `<div class="legend-item"><span class="legend-dot" style="background:${l.color}"></span>${l.name}</div>`).join("");
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
    <div class="stat"><div class="label">VaR 95% (1 dia)</div><div class="value num" style="color:var(--critical-text)">-${fmtNum(m.var95_1d_pct, 2)}%</div><div class="note">≈ -${fmtMoney(m.var95_1d_usd)} sobre ${fmtMoney(m.capital)}</div></div>
    <div class="stat"><div class="label">Patrimônio</div><div class="value num">${fmtMoney(m.capital)}</div><div class="note">capital total da carteira</div></div>
  `;

  const contrib = m.contrib;
  const maxAbs = Math.max(...Object.values(contrib).map(Math.abs), 1);
  document.getElementById("risk-contrib-body").innerHTML = [...ASSET_ORDER, "CASH"].map(sym => {
    const v = contrib[sym] || 0;
    const barColor = v < 0 ? cssVar("--good") : accentColor(sym);
    const barWidth = (Math.abs(v) / maxAbs) * 100;
    return `<tr>
      <td class="asset-name-cell"><span class="asset-dot" style="background:${accentColor(sym)}"></span>${sym}</td>
      <td class="${v < 0 ? "neg" : ""}">${fmtPct(v, 1)}
        <span class="risk-bar-wrap"><span class="risk-bar" style="left:${v < 0 ? 50 - barWidth / 2 : 50}%; width:${Math.max(barWidth / 2, 1)}%; background:${barColor}"></span></span>
      </td>
    </tr>`;
  }).join("");
}

// --- Section 7: Análise e recomendação ----------------------------------------

function renderRecommendation() {
  const m = liveStats();
  const isAggressive = m.beta >= 1;
  const profileLabel = isAggressive ? "AGRESSIVA" : "MODERADA / DEFENSIVA";

  const corr = window.CORR_MATRIX;
  const w = ASSET_ORDER.map(signedFrac);
  const pairs = [];
  if (corr) {
    for (let i = 0; i < ASSET_ORDER.length; i++) {
      for (let j = i + 1; j < ASSET_ORDER.length; j++) {
        pairs.push({
          a: ASSET_ORDER[i], b: ASSET_ORDER[j], v: corr[i][j],
          contrib: m.variance > 0 ? (2 * w[i] * w[j] * COV[i][j]) / m.variance * 100 : 0,
        });
      }
    }
  }
  const biggestPair = pairs.length ? pairs.reduce((mx, p) => (Math.abs(p.contrib) > Math.abs(mx.contrib) ? p : mx)) : null;
  const active = ASSET_ORDER.filter(s => STATE.weights[s] > 0.5);
  const mostVolatile = active.length
    ? active.reduce((mx, s) => (DATA.assets[s].stats.latest_rolling_vol_pct > DATA.assets[mx].stats.latest_rolling_vol_pct ? s : mx), active[0])
    : null;
  const shorts = ASSET_ORDER.filter(s => STATE.sides[s] === "short" && STATE.weights[s] > 0.5);
  const cash = cashPct();

  const strengths = [
    active.length > 1 ? `Diversificação entre setores: ${active.join(", ")} respondem a motores macro diferentes.` : null,
    STATE.weights.GLD > 0.5 ? `Ouro (GLD, ${fmtNum(STATE.weights.GLD, 0)}%) tem correlação baixa com os ativos de risco — suaviza quedas concentradas em ações.` : null,
    ...shorts.map(s => `Short em ${s}: contribuição ao risco de ${fmtPct(m.contrib[s], 1)} — ${m.contrib[s] < 0 ? "negativa, ou seja, reduz o risco total da carteira (hedge)." : "ainda soma risco, vale monitorar."}`),
    cash > 0.5 ? `Caixa de ${fmtNum(cash, 1)}% (${fmtMoney(cashFrac() * m.capital)}) remunerado ao CDI (${fmtNum(RF * 100, 1)}% a.a.) dá colchão e liquidez.` : null,
  ].filter(Boolean);

  const risks = [
    biggestPair && Math.abs(biggestPair.contrib) > 0.05
      ? `${biggestPair.a} × ${biggestPair.b}: correlação ${fmtNum(biggestPair.v)}, responde por ${fmtPct(Math.abs(biggestPair.contrib), 1)} do risco combinado — o par mais pesado da carteira.` : null,
    mostVolatile ? `${mostVolatile} é a posição mais volátil agora (${fmtNum(DATA.assets[mostVolatile].stats.latest_rolling_vol_pct, 1)}% anualizada) — mais sensível a notícias do setor.` : null,
    shorts.length ? `Posições short exigem monitoramento ativo: um rally forte no ativo gera perda mesmo com o resto da carteira subindo.` : null,
    `Beta de ${fmtNum(m.beta)} ${isAggressive ? "acima de 1 — a carteira amplifica os movimentos do mercado." : "abaixo de 1 — a carteira absorve menos que o mercado, mas concentração em poucas posições ainda limita a diversificação real."}`,
    m.diversification < 35 ? `Diversificação de apenas ${fmtNum(m.diversification, 0)}%: o risco está concentrado em poucas posições.` : null,
  ].filter(Boolean);

  document.getElementById("reco-card").innerHTML = `
    <h2>📊 Análise da carteira</h2>
    <div class="reco-profile" style="background:${isAggressive ? "var(--critical-bg)" : "var(--good-bg)"}; color:${isAggressive ? "var(--critical-text)" : "var(--good-text)"}">Perfil: ${profileLabel} (beta ${fmtNum(m.beta)})</div>
    <div class="reco-cols">
      <div class="reco-block"><h4>Pontos fortes</h4><ul>${strengths.length ? strengths.map(s => `<li>${s}</li>`).join("") : "<li>Defina pesos no painel acima para ver a análise.</li>"}</ul></div>
      <div class="reco-block"><h4>Riscos</h4><ul>${risks.map(s => `<li>${s}</li>`).join("")}</ul></div>
    </div>
    <div class="reco-block">
      <h4>Comparação vs. benchmark</h4>
      <table class="reco-bench-table">
        <tr><td>Alpha vs. S&amp;P 500 (CAPM)</td><td style="color:${m.alphaPct >= 0 ? "var(--good-text)" : "var(--critical-text)"}">${fmtPct(m.alphaPct)} a.a.</td></tr>
        <tr><td>Retorno esperado da carteira (anualizado)</td><td>${fmtPct(m.ret * 100)}</td></tr>
        <tr><td>Volatilidade · Sharpe</td><td>${fmtNum(m.vol * 100, 1)}% · ${fmtNum(m.sharpe)}</td></tr>
        <tr><td>Perda esperada num dia ruim (VaR 95%)</td><td style="color:var(--critical-text)">-${fmtMoney(m.var95_1d_usd)}</td></tr>
      </table>
    </div>
    <div class="reco-footnote">Análise gerada a partir dos dados históricos e dos pesos definidos no painel acima — atualiza em tempo real. Não constitui recomendação de investimento. Retorno passado não garante retorno futuro.</div>
  `;
}

// --- Orchestration ------------------------------------------------------------

function renderAll() {
  updateControlUI();
  renderComposition();
  renderCorrelation();
  renderPerformanceCharts(currentRange || RANGES.find(r => r.key === DEFAULT_RANGE_KEY));
  renderAggregateMetrics();
  renderRecommendation();
}

function renderShell() {
  const updated = new Date(DATA.generated_at_utc);
  const ageMin = Math.round((Date.now() - updated.getTime()) / 60000);
  const ageLabel = ageMin < 60 ? `há ${ageMin} min` : `há ${Math.round(ageMin / 60)} h`;
  document.getElementById("app-root").innerHTML = `
    <header class="top">
      <div>
        <h1>Carteira JGP</h1>
        <div class="sub">XLK · XLE · EWZ · XLY · GLD + caixa — dashboard interativo de risco e retorno</div>
      </div>
      <div class="updated">Preços atualizados<br><strong>${updated.toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" })} UTC</strong><br><span class="age">${ageLabel}</span></div>
    </header>
    <div class="disclaimer-banner">⚠️ Ferramenta educacional/analítica. Todos os números vêm de dados históricos (Yahoo Finance) e não constituem recomendação de investimento — retorno passado não garante retorno futuro.</div>

    <div class="quotes-strip" id="quotes-strip"></div>

    <div class="section-title">1 · Ajuste a carteira</div>
    <div class="section-sub">Cada peso é independente — mexer em um não mexe nos outros. O caixa absorve a diferença para fechar 100%. Composição, correlação, performance, métricas e análise atualizam em tempo real.</div>
    <div class="control-panel">
      <div id="control-sliders"></div>
      <div class="control-footer">
        <div class="slider-total" id="control-total"></div>
        <button type="button" class="reset-btn" id="reset-control-btn">↺ Restaurar carteira original</button>
      </div>
    </div>

    <div class="section-title">2 · Composição da carteira</div>
    <div class="comp-grid">
      <div class="comp-pie-card"><div class="canvas-wrap"><canvas id="chart-composition"></canvas></div></div>
      <div class="comp-table-card">
        <table class="comp-table">
          <thead><tr><th>Ativo</th><th>Peso</th><th>Preço</th><th>Quantidade</th><th>Valor</th></tr></thead>
          <tbody id="composition-table-body"></tbody>
        </table>
      </div>
    </div>
    <h3 class="sub-heading">Ordens da carteira original</h3>
    <div class="section-sub">Os lotes individuais por trás dos pesos acima. "Pendente" é o status técnico da ordem (PF = ordem com preço de disparo); as marcadas abaixo foram executadas na abertura. Esta tabela não muda com os sliders.</div>
    <div class="orders-table-wrap">
      <table class="orders-table">
        <thead><tr><th>Ativo</th><th>Peso</th><th>Valor</th><th>Tipo</th><th>Preço disparo</th><th>Status</th></tr></thead>
        <tbody id="orders-table-body"></tbody>
      </table>
    </div>

    <div class="section-title">3 · Matriz de correlação</div>
    <div class="corr-wrap">
      <div class="corr-scroll"><div id="corr-grid-host"></div></div>
      <div class="corr-scale"><span>-1 (inversa)</span><span class="bar"></span><span>+1 (junto)</span></div>
      <div class="info-card" id="corr-interp"></div>
    </div>

    <div class="section-title">4 · Performance</div>
    <div class="section-sub">A linha "Carteira" usa os pesos do painel acima (short e caixa incluídos; o caixa é aproximado pela taxa CDI atual aplicada a todo o histórico).</div>
    <div class="range-row" id="range-row"></div>
    <div class="chart-card chart-wide">
      <h3>Preço real (USD)</h3>
      <div class="desc">Cotação de fechamento de cada ativo em dólares. Escala logarítmica para que ativos de preços muito diferentes (GLD ~$390 vs EWZ ~$38) sejam comparáveis no mesmo gráfico.</div>
      <div class="canvas-wrap" style="height:300px"><canvas id="chart-price-usd"></canvas></div>
    </div>
    <div class="charts-grid">
      <div class="chart-card"><h3>Performance (indexada a 100)</h3><div class="desc">Mesma evolução em %, incluindo a carteira agregada</div><div class="canvas-wrap"><canvas id="chart-price-idx"></canvas></div></div>
      <div class="chart-card"><h3>Drawdown</h3><div class="desc">Queda percentual em relação ao topo do período</div><div class="canvas-wrap"><canvas id="chart-dd"></canvas></div></div>
      <div class="chart-card"><h3>Volatilidade rolante (21p, anualizada)</h3><div class="desc">Desvio-padrão dos retornos diários</div><div class="canvas-wrap"><canvas id="chart-vol"></canvas></div></div>
      <div class="chart-card"><h3>Sharpe rolante (63p, anualizado)</h3><div class="desc">Retorno/risco, rf = 0%</div><div class="canvas-wrap"><canvas id="chart-sharpe"></canvas></div></div>
    </div>
    <div class="chart-legend" id="perf-legend"></div>

    <div class="section-title">5 · CAPM (Capital Asset Pricing Model)</div>
    <div class="section-sub">Beta e alpha de cada posição vs. S&amp;P 500 (^GSPC), últimos ${DATA.capm_window_days} pregões — é propriedade de cada ativo, não muda com os pesos.</div>
    <div class="capm-table-wrap"><table class="capm-table" id="capm-table"></table></div>
    <div class="chart-card"><h3>Beta por posição</h3><div class="desc">1.0 = mesma sensibilidade do S&amp;P 500</div><div class="canvas-wrap" style="height:200px"><canvas id="chart-capm-beta"></canvas></div></div>

    <div class="section-title">6 · Métricas agregadas da carteira</div>
    <div class="agg-note">Calculado a partir dos pesos do painel acima, janela de ${WINDOW} pregões, pesos assinados (short entra negativo).</div>
    <div class="stats-row" id="agg-stats"></div>
    <div class="chart-card">
      <h3>Contribuição ao risco por posição</h3>
      <div class="desc">Decomposição de Euler da variância — valores negativos reduzem o risco total (hedge).</div>
      <table class="risk-contrib-table"><thead><tr><th>Posição</th><th>Contribuição ao risco</th></tr></thead><tbody id="risk-contrib-body"></tbody></table>
    </div>

    <div class="section-title">7 · Análise e recomendação</div>
    <div class="reco-card" id="reco-card"></div>

    <footer>
      Fonte de preços: Yahoo Finance (fechamento diário e cotação intradiária, não ajustados por proventos). Benchmark CAPM: S&amp;P 500 (^GSPC). Taxa livre de risco: CDI anualizado (Banco Central, série SGS 12).
      Os preços são atualizados automaticamente a cada 15 minutos no horário de mercado via GitHub Actions, e cada F5 busca a versão mais recente — o navegador não consegue chamar o Yahoo diretamente (sem CORS).
      Seções 2, 3, 4 (linha "Carteira"), 6 e 7 recalculam ao vivo no navegador a partir dos pesos definidos. Valores em dólar sobre um patrimônio de ${fmtMoney(DATA.portfolio.capital_usd)}; não há conversão de câmbio aplicada.
      Ferramenta de análise histórica, não recomendação de investimento.
    </footer>
  `;
}

async function loadData() {
  const res = await fetch(`data/portfolio_data.json?t=${Date.now()}`, { cache: "no-store" });
  if (!res.ok) throw new Error("Falha ao carregar data/portfolio_data.json.");
  DATA = await res.json();

  DEFAULT_STATE = { weights: {}, sides: {} };
  DATA.portfolio.positions.forEach(p => { DEFAULT_STATE.weights[p.symbol] = p.weight * 100; DEFAULT_STATE.sides[p.symbol] = p.side; });
  STATE = { weights: { ...DEFAULT_STATE.weights }, sides: { ...DEFAULT_STATE.sides } };

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
  renderQuotes();
  renderOrders();
  renderControlPanel();
  buildRangeButtons();
  initStats(DATA);      // js/stats.js — COV / CORR / ANN_RETURN / SIGMA / RF
  renderCapm(DATA);     // js/capm.js
  renderAll();
}

init();
