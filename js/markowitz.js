/*
 * Correlation heatmap, long-only portfolio slider simulator, efficient
 * frontier and max-Sharpe (Markowitz) recommendation — same method as the
 * desafiojgp project's js/medidas.js, scoped to this carteira's 5 positions.
 *
 * Long-only only: this simulator does NOT replicate the real portfolio's
 * short position on XLY or its cash allocation — it's a "what if I held
 * only these 5 long" exploration tool. The real portfolio's actual risk
 * (with the XLY short and cash) is computed server-side and shown in
 * sections 1/2/6/7 instead. Relies on globals from js/app.js (ASSET_ORDER,
 * cssVar, accentColor, fmtNum, fmtPct — all classic <script> tags share one
 * global scope) and runs after DATA is loaded, via initMarkowitz(data).
 */

const WINDOW = 63;          // trading days — return/vol/Markowitz window
const TRADING_DAYS = 252;
const FRONTIER_SAMPLES = 3000;

let MK_DATA = null;
let RETURNS = {};
let CORR_RETURNS = {};
let ANN_RETURN = {};
let COV = null;
let CORR = null;
let SIGMA = {};
let RF = 0;
let FRONTIER_CLOUD = [];
let MARKOWITZ = null;
let sliderWeights = {};
const mkCharts = {};

function mkMean(arr) { return arr.reduce((a, b) => a + b, 0) / arr.length; }
function mkClose(sym) { return MK_DATA.assets[sym].close; }

function returnsOverWindow(sym, window, cache) {
  if (cache[sym]) return cache[sym];
  const close = mkClose(sym);
  const n = close.length;
  const windowCloses = close.slice(Math.max(0, n - window - 1));
  const rets = [];
  for (let i = 1; i < windowCloses.length; i++) rets.push(windowCloses[i] / windowCloses[i - 1] - 1);
  cache[sym] = rets;
  return rets;
}
function windowReturns(sym) { return returnsOverWindow(sym, WINDOW, RETURNS); }
function corrWindowReturns(sym) { return returnsOverWindow(sym, mkClose(sym).length - 1, CORR_RETURNS); }

function computeReturnsAndStats() {
  ASSET_ORDER.forEach(sym => {
    const rets = windowReturns(sym);
    const close = mkClose(sym);
    const n = close.length;
    const windowCloses = close.slice(n - WINDOW - 1);
    const totalReturn = windowCloses[windowCloses.length - 1] / windowCloses[0] - 1;
    ANN_RETURN[sym] = Math.pow(1 + totalReturn, TRADING_DAYS / WINDOW) - 1;
  });

  COV = ASSET_ORDER.map(symI => ASSET_ORDER.map(symJ => {
    const ri = RETURNS[symI], rj = RETURNS[symJ];
    const mi = mkMean(ri), mj = mkMean(rj);
    let s = 0;
    for (let k = 0; k < ri.length; k++) s += (ri[k] - mi) * (rj[k] - mj);
    return (s / (ri.length - 1)) * TRADING_DAYS;
  }));
  ASSET_ORDER.forEach((sym, i) => { SIGMA[sym] = Math.sqrt(COV[i][i]); });
  RF = MK_DATA.risk_free.rf_annual_pct / 100;
}

function computeCorrelation() {
  ASSET_ORDER.forEach(sym => corrWindowReturns(sym));
  const minLen = Math.min(...ASSET_ORDER.map(sym => CORR_RETURNS[sym].length));
  const aligned = {};
  ASSET_ORDER.forEach(sym => { aligned[sym] = CORR_RETURNS[sym].slice(-minLen); });
  CORR = ASSET_ORDER.map(symI => ASSET_ORDER.map(symJ => {
    const ri = aligned[symI], rj = aligned[symJ];
    const mi = mkMean(ri), mj = mkMean(rj);
    let sij = 0, sii = 0, sjj = 0;
    for (let k = 0; k < ri.length; k++) { const di = ri[k] - mi, dj = rj[k] - mj; sij += di * dj; sii += di * di; sjj += dj * dj; }
    return sij / Math.sqrt(sii * sjj);
  }));
  window.CORR_MATRIX = CORR;
}

function portfolioReturn(w) { return ASSET_ORDER.reduce((s, sym) => s + w[sym] * ANN_RETURN[sym], 0); }
function portfolioVariance(w) {
  const n = ASSET_ORDER.length;
  const wv = ASSET_ORDER.map(sym => w[sym]);
  let v = 0;
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) v += wv[i] * wv[j] * COV[i][j];
  return v;
}
function portfolioStats(w) {
  const n = ASSET_ORDER.length;
  const ret = portfolioReturn(w);
  const variance = portfolioVariance(w);
  const vol = Math.sqrt(variance);
  const sharpe = vol > 0 ? (ret - RF) / vol : null;
  const wv = ASSET_ORDER.map(sym => w[sym]);
  const sigmaW = COV.map(row => row.reduce((s, c, j) => s + c * wv[j], 0));
  const contrib = {};
  ASSET_ORDER.forEach((sym, i) => { contrib[sym] = variance > 0 ? (wv[i] * sigmaW[i]) / variance : 1 / n; });
  const enb = 1 / ASSET_ORDER.reduce((s, sym) => s + contrib[sym] ** 2, 0);
  const diversification = ((enb - 1) / (n - 1)) * 100;
  return { ret, vol, sharpe, contrib, diversification };
}

function solveLinearSystem(A, b) {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(M[r][col]) > Math.abs(M[pivot][col])) pivot = r;
    [M[col], M[pivot]] = [M[pivot], M[col]];
    const pv = M[col][col];
    if (Math.abs(pv) < 1e-12) continue;
    for (let c = col; c <= n; c++) M[col][c] /= pv;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const factor = M[r][col];
      for (let c = col; c <= n; c++) M[r][c] -= factor * M[col][c];
    }
  }
  return M.map(row => row[n]);
}

function longOnlyTangencyPortfolio() {
  let active = [...ASSET_ORDER];
  while (active.length > 1) {
    const idx = active.map(sym => ASSET_ORDER.indexOf(sym));
    const covSub = idx.map(i => idx.map(j => COV[i][j]));
    const muSub = active.map(sym => ANN_RETURN[sym] - RF);
    const raw = solveLinearSystem(covSub, muSub);
    const minIdx = raw.indexOf(Math.min(...raw));
    if (raw[minIdx] >= -1e-9) {
      const sum = raw.reduce((a, b) => a + b, 0);
      if (sum > 1e-9) {
        const w = raw.map(v => v / sum);
        const full = {};
        ASSET_ORDER.forEach(sym => { full[sym] = 0; });
        active.forEach((sym, i) => { full[sym] = Math.max(0, w[i]); });
        return full;
      }
    }
    active.splice(minIdx, 1);
  }
  const full = {};
  ASSET_ORDER.forEach(sym => { full[sym] = 0; });
  full[active[0]] = 1;
  return full;
}

function randomSimplexWeights() {
  const draws = ASSET_ORDER.map(() => -Math.log(Math.random()));
  const sum = draws.reduce((a, b) => a + b, 0);
  const w = {};
  ASSET_ORDER.forEach((sym, i) => { w[sym] = draws[i] / sum; });
  return w;
}

function buildFrontierAndMarkowitz() {
  const cloud = [];
  for (let k = 0; k < FRONTIER_SAMPLES; k++) {
    const w = randomSimplexWeights();
    const s = portfolioStats(w);
    cloud.push({ x: s.vol * 100, y: s.ret * 100 });
  }
  FRONTIER_CLOUD = cloud;
  const w = longOnlyTangencyPortfolio();
  const s = portfolioStats(w);
  MARKOWITZ = { w, ret: s.ret, vol: s.vol, sharpe: s.sharpe, contrib: s.contrib, diversification: s.diversification };
  window.MARKOWITZ_RESULT = MARKOWITZ;
}

// --- rendering ---------------------------------------------------------------

function corrColor(v) {
  const hexToRgb = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
  const rgbToStr = c => `rgb(${c[0]},${c[1]},${c[2]})`;
  const lerp = (a, b, t) => a.map((v2, i) => Math.round(v2 + (b[i] - v2) * t));
  const neg = hexToRgb((cssVar("--critical").trim() || "#F85149").replace("#", "#"));
  const neu = hexToRgb("#1c2330");
  const pos = hexToRgb(cssVar("--good").trim() || "#3FB950");
  if (v >= 0) return rgbToStr(lerp(neu, pos, v));
  return rgbToStr(lerp(neu, neg, -v));
}

function renderCorrelation() {
  const order = ASSET_ORDER;
  const cells = [`<div></div>`];
  order.forEach(sym => cells.push(`<div class="corr-label">${sym}</div>`));
  order.forEach((symRow, i) => {
    cells.push(`<div class="corr-label">${symRow}</div>`);
    order.forEach((symCol, j) => {
      const v = CORR[i][j];
      const textColor = Math.abs(v) > 0.55 ? "#0a0e14" : cssVar("--text-primary");
      cells.push(`<div class="corr-cell" style="background:${corrColor(v)}; color:${textColor}">${v.toFixed(2)}</div>`);
    });
  });

  const pairs = [];
  for (let i = 0; i < order.length; i++) for (let j = i + 1; j < order.length; j++) pairs.push({ a: order[i], b: order[j], v: CORR[i][j] });
  const avgCorr = mkMean(pairs.map(p => p.v));
  const divGeral = Math.max(0, Math.min(100, (1 - avgCorr) * 100));
  const byAbsDesc = [...pairs].sort((a, b) => Math.abs(b.v) - Math.abs(a.v));
  const describePair = (p) => {
    const level = Math.abs(p.v) >= 0.6 ? "alta" : Math.abs(p.v) >= 0.3 ? "moderada" : "baixa";
    const sign = p.v >= 0 ? "positiva" : "negativa";
    let note = p.v >= 0 ? "se diversificar, esse par soma pouco valor" : "correlação negativa: tende a compensar movimentos";
    if (p.a === "XLY" || p.b === "XLY") note += " — lembrete: XLY é mantido SHORT na carteira real, então o efeito prático sobre o risco é o oposto do sinal mostrado aqui.";
    return `<li><strong>${p.a} × ${p.b}</strong> correlação ${level} ${sign} (${fmtNum(p.v)}) — ${note}</li>`;
  };

  document.getElementById("corr-grid-host").innerHTML = `<div class="corr-grid">${cells.join("")}</div>`;
  document.getElementById("corr-interp").innerHTML = `
    <div class="info-title">📊 Interpretação</div>
    <ul>${byAbsDesc.map(describePair).join("")}</ul>
    <div class="div-score" style="margin-top:12px; padding-top:12px; border-top:1px solid var(--border);">Diversificação geral (correlação média entre os ${pairs.length} pares): <strong>${divGeral.toFixed(0)}%</strong></div>
  `;
}

function updateSliderUI() {
  ASSET_ORDER.forEach(sym => {
    document.getElementById("slider-" + sym).value = sliderWeights[sym];
    document.getElementById("slider-val-" + sym).textContent = fmtNum(sliderWeights[sym], 1) + "%";
  });
  const total = ASSET_ORDER.reduce((s, sym) => s + sliderWeights[sym], 0);
  const totalEl = document.getElementById("slider-total");
  totalEl.textContent = `Total: ${total.toFixed(0)}%`;
  totalEl.className = "slider-total" + (Math.abs(total - 100) < 0.6 ? " ok" : "");
}
function currentWeightsFraction() {
  const w = {};
  ASSET_ORDER.forEach(sym => { w[sym] = sliderWeights[sym] / 100; });
  return w;
}
function zeroWeights() {
  const w = {};
  ASSET_ORDER.forEach(sym => { w[sym] = 0; });
  return w;
}

function renderAlternativesTable(currentStats) {
  const equalW = 1 / ASSET_ORDER.length;
  const equal = portfolioStats(Object.fromEntries(ASSET_ORDER.map(sym => [sym, equalW])));
  const rows = [
    { label: "Sua simulação", s: currentStats, cls: "current" },
    { label: `Equal weight (${(equalW * 100).toFixed(0)}% cada)`, s: equal, cls: "" },
    { label: `Ótimo Markowitz (${ASSET_ORDER.filter(s => MARKOWITZ.w[s] > 0.005).map(s => `${s} ${(MARKOWITZ.w[s] * 100).toFixed(0)}%`).join("/")})`, s: MARKOWITZ, cls: "optimal" },
  ];
  return `<table class="alt-table"><thead><tr><th>vs. alternativas</th><th>Retorno</th><th>Vol.</th><th>Sharpe</th></tr></thead>
    <tbody>${rows.map(r => `<tr class="${r.cls}"><td>${r.label}</td><td>${fmtPct(r.s.ret * 100)}</td><td>${fmtNum(r.s.vol * 100, 1)}%</td><td>${fmtNum(r.s.sharpe)}</td></tr>`).join("")}</tbody></table>`;
}

function renderSimResults() {
  const w = currentWeightsFraction();
  const s = portfolioStats(w);
  document.getElementById("sim-results").innerHTML = `
    <div class="sim-results-grid">
      <div class="sim-stat"><div class="label">Retorno anualizado</div><div class="value">${fmtPct(s.ret * 100)}</div></div>
      <div class="sim-stat"><div class="label">Volatilidade</div><div class="value">${fmtNum(s.vol * 100, 1)}%</div></div>
      <div class="sim-stat"><div class="label">Sharpe</div><div class="value">${fmtNum(s.sharpe)}</div></div>
      <div class="sim-stat"><div class="label">Diversificação</div><div class="value">${fmtNum(s.diversification, 0)}%</div></div>
    </div>
    <div class="risk-contrib">${ASSET_ORDER.map(sym => `<div style="width:${Math.max(0, s.contrib[sym] * 100).toFixed(1)}%; background:${accentColor(sym)}">${s.contrib[sym] > 0.12 ? (s.contrib[sym] * 100).toFixed(0) + "%" : ""}</div>`).join("")}</div>
    <div class="risk-contrib-legend">${ASSET_ORDER.filter(s2 => w[s2] > 0.005).map(sym => `<span><span class="asset-dot" style="background:${accentColor(sym)}"></span>${sym} ${(s.contrib[sym] * 100).toFixed(0)}%</span>`).join("")}</div>
    ${renderAlternativesTable(s)}
  `;
  updateFrontierCurrentPoint(s);
}

function baseScatterOptions(xLabel, yLabel) {
  return {
    responsive: true, maintainAspectRatio: false, animation: false,
    plugins: {
      legend: { display: false },
      tooltip: {
        backgroundColor: cssVar("--surface"), titleColor: cssVar("--text-primary"), bodyColor: cssVar("--text-secondary"),
        borderColor: cssVar("--border-strong"), borderWidth: 1,
        callbacks: { label: ctx => `${ctx.dataset.label}: risco ${ctx.parsed.x.toFixed(1)}% · retorno ${ctx.parsed.y.toFixed(1)}%` },
      },
    },
    scales: {
      x: { title: { display: true, text: xLabel, color: cssVar("--text-muted"), font: { size: 11 } }, grid: { color: cssVar("--grid") }, ticks: { color: cssVar("--text-muted"), font: { family: "IBM Plex Mono", size: 10 }, callback: v => v + "%" } },
      y: { title: { display: true, text: yLabel, color: cssVar("--text-muted"), font: { size: 11 } }, grid: { color: cssVar("--grid") }, ticks: { color: cssVar("--text-muted"), font: { family: "IBM Plex Mono", size: 10 }, callback: v => v + "%" } },
    },
  };
}

function renderFrontierChart() {
  const currentW = currentWeightsFraction();
  const currentS = portfolioStats(currentW);
  mkCharts.frontier = new Chart(document.getElementById("chart-frontier").getContext("2d"), {
    type: "scatter",
    data: {
      datasets: [
        { label: "Combinações possíveis", data: FRONTIER_CLOUD, backgroundColor: cssVar("--border-strong"), pointRadius: 2, pointHoverRadius: 3 },
        ...ASSET_ORDER.map(sym => ({ label: sym, data: [{ x: SIGMA[sym] * 100, y: ANN_RETURN[sym] * 100 }], backgroundColor: accentColor(sym), pointRadius: 7, pointHoverRadius: 9, pointStyle: "rectRot" })),
        { label: "Sua simulação", data: [{ x: currentS.vol * 100, y: currentS.ret * 100 }], backgroundColor: cssVar("--text-primary"), pointRadius: 8, pointHoverRadius: 10, pointStyle: "circle" },
        { label: "Ótimo Markowitz", data: [{ x: MARKOWITZ.vol * 100, y: MARKOWITZ.ret * 100 }], backgroundColor: cssVar("--good"), pointRadius: 9, pointHoverRadius: 11, pointStyle: "star" },
      ],
    },
    options: baseScatterOptions("Risco (volatilidade anualizada, %)", "Retorno esperado anualizado (%)"),
  });
  document.getElementById("frontier-legend").innerHTML = `
    <div class="legend-item"><span class="legend-dot" style="background:${cssVar('--border-strong')}"></span>Combinações possíveis</div>
    ${ASSET_ORDER.map(sym => `<div class="legend-item"><span class="legend-dot" style="background:${accentColor(sym)}"></span>${sym} isolado</div>`).join("")}
    <div class="legend-item"><span class="legend-dot" style="background:${cssVar('--text-primary')}"></span>Sua simulação</div>
    <div class="legend-item"><span class="legend-dot" style="background:${cssVar('--good')}"></span>Ótimo Markowitz</div>
  `;
}

function updateFrontierCurrentPoint(stats) {
  if (!mkCharts.frontier) return;
  const ds = mkCharts.frontier.data.datasets.find(d => d.label === "Sua simulação");
  ds.data = [{ x: stats.vol * 100, y: stats.ret * 100 }];
  mkCharts.frontier.update("none");
}

function renderMarkowitzCard() {
  const equalW = 1 / ASSET_ORDER.length;
  const equal = portfolioStats(Object.fromEntries(ASSET_ORDER.map(sym => [sym, equalW])));
  const sharpeGain = ((MARKOWITZ.sharpe - equal.sharpe) / Math.abs(equal.sharpe)) * 100;
  document.getElementById("markowitz-card").innerHTML = `
    <div class="mk-title">🏆 Portfólio ótimo (Markowitz, long-only)</div>
    <div>Para maximizar o Sharpe entre as 5 posições (sem venda a descoberto):</div>
    <div class="mk-weights">${ASSET_ORDER.filter(s => MARKOWITZ.w[s] > 0.005).map(sym => `${sym}: ${(MARKOWITZ.w[sym] * 100).toFixed(0)}%`).join(" · ")}</div>
    <div class="mk-stats">
      <div><div class="label">Retorno esperado</div><div class="value">${fmtPct(MARKOWITZ.ret * 100)} a.a.</div></div>
      <div><div class="label">Volatilidade</div><div class="value">${fmtNum(MARKOWITZ.vol * 100, 1)}%</div></div>
      <div><div class="label">Sharpe</div><div class="value">${fmtNum(MARKOWITZ.sharpe)}</div></div>
      <div><div class="label">Diversificação</div><div class="value">${fmtNum(MARKOWITZ.diversification, 0)}%</div></div>
    </div>
    <div class="mk-vs">Vs. equal-weight (20% cada): ${sharpeGain >= 0 ? "+" : ""}${sharpeGain.toFixed(0)}% de Sharpe.</div>
    <div class="mk-note">⚠️ Retorno e volatilidade baseados nos últimos ${WINDOW} pregões; correlação sobre todo o histórico carregado. Não simula o short em XLY nem o caixa da carteira real. Não constitui recomendação de investimento.</div>
  `;
}

function attachSliderHandlers() {
  ASSET_ORDER.forEach(sym => {
    document.getElementById("slider-" + sym).addEventListener("input", e => {
      const newVal = Math.max(0, Math.min(100, Number(e.target.value)));
      const others = ASSET_ORDER.filter(s => s !== sym);
      const remaining = 100 - newVal;
      const othersSum = others.reduce((s, o) => s + sliderWeights[o], 0);
      if (othersSum <= 0.001) others.forEach(o => { sliderWeights[o] = remaining / others.length; });
      else others.forEach(o => { sliderWeights[o] = (sliderWeights[o] / othersSum) * remaining; });
      sliderWeights[sym] = newVal;
      updateSliderUI();
      renderSimResults();
    });
  });
}

function initMarkowitz(data) {
  MK_DATA = data;
  sliderWeights = Object.fromEntries(ASSET_ORDER.map(sym => [sym, 100 / ASSET_ORDER.length]));
  computeReturnsAndStats();
  computeCorrelation();
  buildFrontierAndMarkowitz();

  document.getElementById("sliders-host").innerHTML = ASSET_ORDER.map(sym => `
    <div class="slider-row" style="--slider-accent:${accentColor(sym)}">
      <div class="slider-head">
        <span class="name"><span class="asset-dot" style="background:${accentColor(sym)}"></span>${sym}</span>
        <span class="val" id="slider-val-${sym}">${fmtNum(sliderWeights[sym], 1)}%</span>
      </div>
      <input type="range" min="0" max="100" step="0.5" id="slider-${sym}" value="${sliderWeights[sym]}" />
    </div>
  `).join("");

  renderCorrelation();
  attachSliderHandlers();
  updateSliderUI();
  renderFrontierChart();
  renderSimResults();
  renderMarkowitzCard();
}
