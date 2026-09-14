/*
 * Carteira JGP — main orchestrator. Loads data/portfolio_data.json (fetched
 * and computed server-side by scripts/fetch_and_compute.py: prices, CAPM
 * beta/alpha, aggregate portfolio metrics) and renders every section of the
 * single-page dashboard. js/markowitz.js renders the correlation heatmap +
 * slider simulator + efficient frontier; js/capm.js renders the CAPM table.
 * All three files share one global scope (classic <script> tags, no
 * modules), so consts/functions declared here are visible there too.
 *
 * No live browser-side fetch to Yahoo Finance: their chart API doesn't send
 * CORS headers, so a client-side fetch would fail. Same pattern as the
 * desafiojgp project — python fetches + computes, GitHub Actions commits the
 * JSON, the page just reads a static file.
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
let ASSETS = []; // [{symbol, name, weight, side, signedWeight}]
let CASH_WEIGHT = 0;
const perfCharts = {};

function fmtPct(v, digits = 2) { if (v === null || v === undefined || Number.isNaN(v)) return "—"; return (v >= 0 ? "+" : "") + v.toFixed(digits) + "%"; }
function fmtNum(v, digits = 2) { if (v === null || v === undefined || Number.isNaN(v)) return "—"; return v.toFixed(digits); }
function fmtUsd(v) { if (v === null || v === undefined) return "—"; return "$" + Math.round(v).toLocaleString("en-US"); }
function fmtDateShort(iso) { const [y, m, d] = iso.split("-"); return d + "/" + m + "/" + y.slice(2); }
function cssVar(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }

function accentColor(sym) { return cssVar(ACCENT_VAR[sym]); }

// --- Section 1: Composição --------------------------------------------------

function renderComposition() {
  const capital = DATA.portfolio.capital_usd;
  const rows = ASSETS.map(a => {
    const price = DATA.assets[a.symbol].stats.last_close;
    const value = a.weight * capital * (a.side === "short" ? -1 : 1);
    const qty = value / price;
    return { ...a, price, qty, value };
  });
  const cashValue = CASH_WEIGHT * capital;

  const pieLabels = [...ASSETS.map(a => a.symbol), "CASH"];
  const pieValues = [...ASSETS.map(a => a.weight), CASH_WEIGHT];
  const pieColors = [...ASSETS.map(a => accentColor(a.symbol)), accentColor("CASH")];

  new Chart(document.getElementById("chart-composition").getContext("2d"), {
    type: "pie",
    data: { labels: pieLabels.map((l, i) => `${l} ${(pieValues[i] * 100).toFixed(0)}%`), datasets: [{ data: pieValues, backgroundColor: pieColors, borderColor: cssVar("--bg"), borderWidth: 2 }] },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { position: "bottom", labels: { color: cssVar("--text-secondary"), font: { size: 11 }, padding: 12 } } },
    },
  });

  const rowsHtml = rows.map(r => `
    <tr class="${r.side === "short" ? "short-row" : ""}">
      <td class="asset-name-cell"><span class="asset-dot" style="background:${accentColor(r.symbol)}"></span>${r.symbol}<span class="side-tag ${r.side}">${r.side === "short" ? "SHORT" : "LONG"}</span></td>
      <td>${(r.weight * 100).toFixed(0)}%</td>
      <td class="num">$${fmtNum(r.price)}</td>
      <td class="num">${r.qty >= 0 ? "" : "-"}${fmtNum(Math.abs(r.qty), 0)}</td>
      <td class="num">${r.value >= 0 ? "" : "-"}$${fmtNum(Math.abs(r.value) / 1000, 0)}k</td>
    </tr>
  `).join("");

  document.getElementById("composition-table-body").innerHTML = rowsHtml + `
    <tr class="cash-row">
      <td class="asset-name-cell"><span class="asset-dot" style="background:${accentColor("CASH")}"></span>CASH<span class="side-tag cash">CAIXA</span></td>
      <td>${(CASH_WEIGHT * 100).toFixed(0)}%</td>
      <td>—</td>
      <td>—</td>
      <td class="num">$${fmtNum(cashValue / 1000, 0)}k</td>
    </tr>
  `;
}

// --- Section 3: Performance --------------------------------------------------

function seriesSlice(series, days) {
  const n = series.dates.length;
  const start = days ? Math.max(0, n - days) : 0;
  return {
    dates: series.dates.slice(start),
    close: series.close.slice(start),
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
  const labels = seriesSlice(DATA.portfolio_series, range.days).dates.map(fmtDateShort);
  const lines = [
    ...ASSETS.map(a => ({ sym: a.symbol, name: a.symbol, color: accentColor(a.symbol) })),
    { sym: "__PORT__", name: "Carteira", color: accentColor("PORT") },
  ];

  const mk = (key, canvasId, field, options) => {
    if (perfCharts[key]) perfCharts[key].destroy();
    const datasets = lines.map(l => {
      const series = l.sym === "__PORT__" ? DATA.portfolio_series : DATA.assets[l.sym];
      const s = seriesSlice(series, range.days);
      const data = field === "perf_index" ? s.perf_index : s[field];
      return {
        label: l.name, data, borderColor: l.color, backgroundColor: "transparent",
        borderWidth: l.sym === "__PORT__" ? 2.5 : 1.5, pointRadius: 0, spanGaps: true, tension: 0.05,
      };
    });
    perfCharts[key] = new Chart(document.getElementById(canvasId).getContext("2d"), { type: "line", data: { labels, datasets }, options });
  };

  mk("price", "chart-price", "perf_index", baseLineOptions("", ""));
  mk("dd", "chart-dd", "drawdown_pct", baseLineOptions("", "%"));
  mk("vol", "chart-vol", "rolling_vol_pct", baseLineOptions("", "%"));
  mk("sharpe", "chart-sharpe", "rolling_sharpe", baseLineOptions("", ""));

  const legendHtml = lines.map(l => `<div class="legend-item"><span class="legend-dot" style="background:${l.color}"></span>${l.name}</div>`).join("");
  document.getElementById("perf-legend").innerHTML = legendHtml;
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
  const m = DATA.portfolio_metrics;
  document.getElementById("agg-stats").innerHTML = `
    <div class="stat"><div class="label">Retorno esperado (CAPM)</div><div class="value num">${fmtPct(m.expected_return_capm_pct)}</div><div class="note">realizado (${m.window_days}p): ${fmtPct(m.expected_return_realized_pct)}</div></div>
    <div class="stat"><div class="label">Volatilidade anualizada</div><div class="value num">${fmtNum(m.volatility_annual_pct, 1)}%</div><div class="note">com correlações entre posições</div></div>
    <div class="stat"><div class="label">Sharpe</div><div class="value num">${fmtNum(m.sharpe)}</div><div class="note">rf = CDI ${fmtNum(m.risk_free_annual_pct, 1)}% a.a.</div></div>
    <div class="stat"><div class="label">Beta da carteira</div><div class="value num">${fmtNum(m.beta)}</div><div class="note">${m.beta >= 1 ? "mais agressiva que o mercado" : "mais defensiva que o mercado"}</div></div>
    <div class="stat"><div class="label">Alpha da carteira</div><div class="value num" style="color:${m.alpha_annual_pct >= 0 ? "var(--good-text)" : "var(--critical-text)"}">${fmtPct(m.alpha_annual_pct)}</div><div class="note">vs. CAPM (S&amp;P 500)</div></div>
    <div class="stat"><div class="label">Diversificação</div><div class="value num">${fmtNum(m.diversification_pct, 0)}%</div><div class="note">nº efetivo de posições independentes</div></div>
    <div class="stat"><div class="label">VaR 95% (1 dia)</div><div class="value num" style="color:var(--critical-text)">-${fmtNum(m.var95_1d_pct, 2)}%</div><div class="note">≈ -${fmtUsd(m.var95_1d_usd)} sobre $${(m.capital_usd / 1e6).toFixed(1)}M</div></div>
    <div class="stat"><div class="label">Capital de referência</div><div class="value num">$${(m.capital_usd / 1e6).toFixed(1)}M</div><div class="note">usado para os valores em $</div></div>
  `;

  const contrib = m.risk_contribution_pct;
  const maxAbs = Math.max(...Object.values(contrib).map(Math.abs), 1);
  const order = [...ASSET_ORDER, "CASH"];
  document.getElementById("risk-contrib-body").innerHTML = order.map(sym => {
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
  const m = DATA.portfolio_metrics;
  const isAggressive = m.beta >= 1;
  const profileLabel = isAggressive ? "AGRESSIVA" : "MODERADA / DEFENSIVA";
  const profileColor = isAggressive ? "var(--critical-bg)" : "var(--good-bg)";
  const profileTextColor = isAggressive ? "var(--critical-text)" : "var(--good-text)";

  const capmMap = Object.fromEntries(ASSET_ORDER.map(s => [s, DATA.assets[s].capm]));
  const corr = window.CORR_MATRIX; // populated by markowitz.js
  const pairs = [];
  if (corr) {
    for (let i = 0; i < ASSET_ORDER.length; i++) {
      for (let j = i + 1; j < ASSET_ORDER.length; j++) {
        pairs.push({ a: ASSET_ORDER[i], b: ASSET_ORDER[j], v: corr[i][j] });
      }
    }
  }
  const mostCorrelated = pairs.length ? pairs.reduce((max, p) => (Math.abs(p.v) > Math.abs(max.v) ? p : max)) : null;
  const mostVolatile = ASSET_ORDER.reduce((max, s) => (DATA.assets[s].stats.latest_rolling_vol_pct > DATA.assets[max].stats.latest_rolling_vol_pct ? s : max), ASSET_ORDER[0]);
  const xlyReturn = capmMap.XLY.realized_return_pct;

  const strengths = [
    "Diversificação entre setores: tecnologia (XLK), energia (XLE), Brasil/emergentes (EWZ) e ouro (GLD) reagem a diferentes motores macro.",
    `Ouro (GLD) tende a correlação mais baixa com os ativos de risco — ajuda a suavizar quedas concentradas em ações.`,
    `A posição SHORT em XLY (consumo discricionário) ${xlyReturn < 0 ? "gerou retorno positivo para a carteira" : "funciona como hedge"}: contribuição ao risco de ${fmtPct(m.risk_contribution_pct.XLY, 1)} — ${m.risk_contribution_pct.XLY < 0 ? "negativa, ou seja, reduz o risco total da carteira." : "monitorar, pois ainda soma risco."}`,
    `Caixa de ${(CASH_WEIGHT * 100).toFixed(0)}% remunerado ao CDI (${fmtNum(m.risk_free_annual_pct, 1)}% a.a.) dá um colchão de segurança e liquidez.`,
  ];
  const risks = [
    mostCorrelated ? `${mostCorrelated.a} × ${mostCorrelated.b}: correlação de ${fmtNum(mostCorrelated.v)} — o par mais redundante da carteira.` : null,
    `${mostVolatile} é a posição mais volátil no momento (${fmtNum(DATA.assets[mostVolatile].stats.latest_rolling_vol_pct, 1)}% anualizada) — maior sensibilidade a notícias específicas do setor.`,
    `A posição short em XLY precisa de monitoramento ativo: um rally forte em consumo discricionário gera perda na posição, mesmo com o resto da carteira subindo.`,
    `Beta da carteira de ${fmtNum(m.beta)} ${isAggressive ? "acima de 1 — a carteira amplifica movimentos do mercado." : "abaixo de 1, mas concentrado em poucas posições — atenção à diversificação real."}`,
  ].filter(Boolean);

  const spxCapm = capmMap.XLK; // just for reference values already computed vs SPX
  const alphaVsSpx = m.alpha_annual_pct;

  const mk = window.MARKOWITZ_RESULT; // {w, ret, vol, sharpe} from markowitz.js, long-only among the 5 risky assets
  let mkLine = "";
  if (mk) {
    const sig = ASSET_ORDER.filter(s => mk.w[s] > 0.005).sort((a, b) => mk.w[b] - mk.w[a]);
    const kScale = m.volatility_annual_pct / 100 > 0 && mk.vol > 0 ? Math.min(1, (m.volatility_annual_pct / 100) / mk.vol) : 0;
    const riskyPct = kScale * 100;
    const cashPct = 100 - riskyPct;
    const weightsStr = sig.map(s => `${s} ${(mk.w[s] * kScale * 100).toFixed(0)}%`).join(", ");
    mkLine = `Se quer <strong>máximo Sharpe mantendo o risco atual</strong> (~${fmtNum(m.volatility_annual_pct, 1)}% de vol.): <strong>${weightsStr}, Cash ${cashPct.toFixed(0)}%</strong> (mix long-only entre as 5 posições; a carteira real inclui o short em XLY, que o otimizador não simula).`;
  }

  document.getElementById("reco-card").innerHTML = `
    <h2>📊 Análise da carteira</h2>
    <div class="reco-profile" style="background:${profileColor}; color:${profileTextColor}">Perfil: ${profileLabel} (beta ${fmtNum(m.beta)})</div>
    <div class="reco-cols">
      <div class="reco-block">
        <h4>Pontos fortes</h4>
        <ul>${strengths.map(s => `<li>${s}</li>`).join("")}</ul>
      </div>
      <div class="reco-block">
        <h4>Riscos</h4>
        <ul>${risks.map(s => `<li>${s}</li>`).join("")}</ul>
      </div>
    </div>
    <div class="reco-block">
      <h4>Comparação vs. benchmark</h4>
      <table class="reco-bench-table">
        <tr><td>vs. S&amp;P 500 (CAPM)</td><td style="color:${alphaVsSpx >= 0 ? "var(--good-text)" : "var(--critical-text)"}">${fmtPct(alphaVsSpx)} alpha</td></tr>
        <tr><td>Retorno realizado da carteira (${m.window_days} pregões, anualizado)</td><td>${fmtPct(m.expected_return_realized_pct)}</td></tr>
        <tr><td>Retorno esperado pelo CAPM</td><td>${fmtPct(m.expected_return_capm_pct)}</td></tr>
      </table>
    </div>
    ${mkLine ? `<div class="reco-mk">🏆 Sugestão Markowitz: ${mkLine}</div>` : ""}
    <div class="reco-footnote">Análise gerada a partir de dados históricos (${m.window_days} pregões) e não constitui recomendação de investimento. Retorno passado não garante retorno futuro.</div>
  `;
}

// --- Shell / init --------------------------------------------------------

function renderShell() {
  const updated = new Date(DATA.generated_at_utc);
  document.getElementById("app-root").innerHTML = `
    <header class="top">
      <div>
        <h1>Carteira JGP</h1>
        <div class="sub">XLK · XLE · EWZ · XLY (short) · GLD + caixa — dashboard de risco e retorno</div>
      </div>
      <div class="updated">Dados atualizados em<br><strong>${updated.toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" })} (UTC)</strong></div>
    </header>
    <div class="disclaimer-banner">⚠️ Ferramenta educacional/analítica. Todos os números vêm de dados históricos (Yahoo Finance) e não constituem recomendação de investimento — retorno passado não garante retorno futuro.</div>

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
    <div class="range-row" id="range-row"></div>
    <div class="charts-grid">
      <div class="chart-card"><h3>Preço (indexado a 100)</h3><div class="desc">Evolução de cada posição e da carteira agregada</div><div class="canvas-wrap"><canvas id="chart-price"></canvas></div></div>
      <div class="chart-card"><h3>Drawdown</h3><div class="desc">Queda percentual em relação ao topo do período</div><div class="canvas-wrap"><canvas id="chart-dd"></canvas></div></div>
      <div class="chart-card"><h3>Volatilidade rolante (21p, anualizada)</h3><div class="desc">Desvio-padrão dos retornos diários</div><div class="canvas-wrap"><canvas id="chart-vol"></canvas></div></div>
      <div class="chart-card"><h3>Sharpe rolante (63p, anualizado)</h3><div class="desc">Retorno/risco, rf = 0%</div><div class="canvas-wrap"><canvas id="chart-sharpe"></canvas></div></div>
    </div>
    <div class="chart-legend" id="perf-legend"></div>

    <div class="section-title">4 · Medidas econométricas (Markowitz)</div>
    <div class="section-sub">Simulador long-only entre as 5 posições — a fronteira e o ótimo de Markowitz não simulam o short de XLY, apenas a carteira "real" (seções 1, 2, 6 e 7).</div>
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
    <div class="section-sub">Beta e alpha de cada posição vs. S&amp;P 500 (^GSPC), últimos ${DATA.capm_window_days} pregões.</div>
    <div class="capm-table-wrap"><table class="capm-table" id="capm-table"></table></div>
    <div class="chart-card"><h3>Beta por posição</h3><div class="desc">1.0 = mesma volatilidade do S&amp;P 500</div><div class="canvas-wrap" style="height:200px"><canvas id="chart-capm-beta"></canvas></div></div>

    <div class="section-title">6 · Métricas agregadas da carteira</div>
    <div class="agg-note">Janela de ${DATA.portfolio_metrics.window_days} pregões (~1 ano), pesos assinados (XLY short entra negativo).</div>
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
      Volatilidade/Sharpe rolantes: janelas de 21 e 63 pregões. CAPM, volatilidade da carteira, VaR e contribuição ao risco: janela de ${DATA.portfolio_metrics.window_days} pregões (~1 ano).
      Dados atualizados automaticamente via GitHub Actions. Esta página é uma ferramenta de análise histórica, não uma recomendação de investimento.
    </footer>
  `;
}

async function loadData() {
  const bust = Date.now();
  const res = await fetch(`data/portfolio_data.json?t=${bust}`, { cache: "no-store" });
  if (!res.ok) throw new Error("Falha ao carregar data/portfolio_data.json.");
  DATA = await res.json();
  ASSETS = DATA.portfolio.positions.map(p => ({ symbol: p.symbol, name: p.name, weight: p.weight, side: p.side }));
  CASH_WEIGHT = DATA.portfolio.cash_weight;
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
  renderComposition();
  buildRangeButtons();
  renderPerformanceCharts(RANGES.find(r => r.key === DEFAULT_RANGE_KEY));
  initMarkowitz(DATA);      // js/markowitz.js — correlation, sliders, frontier
  renderCapm(DATA);         // js/capm.js
  renderAggregateMetrics();
  renderRecommendation();
}

init();
