/*
 * All client-side statistics for the dashboard.
 *
 * Everything here is derived from raw `dates` + `close` arrays, which is what
 * makes live prices work: when a fresh quote patches the tail of an asset's
 * close array, re-running initStats() recomputes the derived series, the
 * covariance/correlation matrices and the CAPM betas from the new data. The
 * JSON-only path and the live path therefore run identical code — the reason
 * the numbers can't drift between them.
 *
 * scripts/fetch_and_compute.py deliberately ships only dates/close/quote:
 * duplicating these formulas server-side would just create two
 * implementations of the same math that can disagree.
 *
 * Exports (plain globals — classic <script> tags share one scope):
 *   buildAssetSeries(closes)        derived series + summary stats
 *   rollingSeriesFromReturns(rets)  the same math starting from returns
 *   COV / CORR / ANN_RETURN / SIGMA / RF
 *   portfolioVariance(w)            w'*COV*w, accepts SIGNED weights
 *
 * Two windows on purpose: return/vol/covariance use WINDOW (63 pregões) so
 * they react to regime changes, while correlation uses the full loaded
 * history, since correlation is far more stable and a quarter is too small a
 * sample to pin it down.
 */

const WINDOW = 63;        // trading days — return/vol/covariance window
const TRADING_DAYS = 252;
const VOL_WINDOW = 21;
const SHARPE_WINDOW = 63;

let STATS_DATA = null;
let RETURNS = {};
let CORR_RETURNS = {};
let ANN_RETURN = {};
let COV = null;
let CORR = null;
let SIGMA = {};
let RF = 0;

function statsMean(arr) { return arr.reduce((a, b) => a + b, 0) / arr.length; }
function statsClose(sym) { return STATS_DATA.assets[sym].close; }

function meanSd(arr) {
  const m = statsMean(arr);
  const v = arr.reduce((s, r) => s + (r - m) ** 2, 0) / (arr.length - 1);
  return { m, sd: Math.sqrt(v) };
}

// --- derived series ----------------------------------------------------------

// `rets[0]` is null (no return on the first observation), matching how the
// series are indexed against `dates`.
function rollingSeriesFromReturns(rets) {
  const n = rets.length;
  const perf = [100];
  for (let i = 1; i < n; i++) perf.push(perf[i - 1] * (1 + rets[i]));

  let peak = perf[0];
  const drawdown = perf.map(p => { peak = Math.max(peak, p); return (p / peak - 1) * 100; });

  const rollVol = new Array(n).fill(null);
  for (let i = VOL_WINDOW; i < n; i++) {
    const win = rets.slice(i - VOL_WINDOW + 1, i + 1).filter(r => r != null);
    if (win.length < VOL_WINDOW - 1) continue;
    rollVol[i] = meanSd(win).sd * Math.sqrt(TRADING_DAYS) * 100;
  }

  const rollSharpe = new Array(n).fill(null);
  for (let i = SHARPE_WINDOW; i < n; i++) {
    const win = rets.slice(i - SHARPE_WINDOW + 1, i + 1).filter(r => r != null);
    if (win.length < SHARPE_WINDOW - 1) continue;
    const { m, sd } = meanSd(win);
    rollSharpe[i] = sd > 0 ? (m / sd) * Math.sqrt(TRADING_DAYS) : null;
  }

  return { perf_index: perf, drawdown_pct: drawdown, rolling_vol_pct: rollVol, rolling_sharpe: rollSharpe };
}

// Drawdown is scale-invariant, so running this on a price series and on a
// compounded index built from the same returns gives identical numbers —
// which is why the portfolio line can reuse rollingSeriesFromReturns().
function buildAssetSeries(closes) {
  const rets = [null];
  for (let i = 1; i < closes.length; i++) rets.push(closes[i] / closes[i - 1] - 1);
  const series = rollingSeriesFromReturns(rets);

  const volValid = series.rolling_vol_pct.filter(v => v != null);
  const sharpeValid = series.rolling_sharpe.filter(v => v != null);
  const last = closes[closes.length - 1];
  const prev = closes.length > 1 ? closes[closes.length - 2] : last;
  const maxDd = Math.min(...series.drawdown_pct);

  return {
    ...series,
    stats: {
      last_close: last,
      day_change_pct: (last / prev - 1) * 100,
      max_drawdown_pct: maxDd,
      current_drawdown_pct: series.drawdown_pct[series.drawdown_pct.length - 1],
      latest_rolling_vol_pct: volValid.length ? volValid[volValid.length - 1] : null,
      latest_rolling_sharpe: sharpeValid.length ? sharpeValid[sharpeValid.length - 1] : null,
    },
  };
}

// --- CAPM --------------------------------------------------------------------

// OLS regression of the asset's daily returns on the benchmark's, over the
// last `window` shared trading days.
function computeCapmFor(sym, window, rfAnnual) {
  const asset = STATS_DATA.assets[sym];
  const bench = STATS_DATA.benchmark;
  if (!bench || !bench.close) return null;

  const benchByDate = new Map(bench.dates.map((d, i) => [d, bench.close[i]]));
  const assetByDate = new Map(asset.dates.map((d, i) => [d, asset.close[i]]));
  const common = asset.dates.filter(d => benchByDate.has(d)).slice(-(window + 1));
  if (common.length < 30) return null;

  const a = common.map(d => assetByDate.get(d));
  const m = common.map(d => benchByDate.get(d));
  const aRets = [], mRets = [];
  for (let i = 1; i < common.length; i++) {
    aRets.push(a[i] / a[i - 1] - 1);
    mRets.push(m[i] / m[i - 1] - 1);
  }

  const ma = statsMean(aRets), mm = statsMean(mRets);
  let cov = 0, varM = 0;
  for (let i = 0; i < aRets.length; i++) {
    cov += (aRets[i] - ma) * (mRets[i] - mm);
    varM += (mRets[i] - mm) ** 2;
  }
  cov /= aRets.length - 1;
  varM /= mRets.length - 1;

  const beta = varM > 0 ? cov / varM : 0;
  const alphaDaily = ma - beta * mm;
  const n = aRets.length;
  const mktAnn = Math.pow(m[m.length - 1] / m[0], TRADING_DAYS / n) - 1;
  const assetAnn = Math.pow(a[a.length - 1] / a[0], TRADING_DAYS / n) - 1;

  return {
    beta,
    alpha_annual_pct: (Math.pow(1 + alphaDaily, TRADING_DAYS) - 1) * 100,
    expected_capm_pct: (rfAnnual + beta * (mktAnn - rfAnnual)) * 100,
    realized_return_pct: assetAnn * 100,
  };
}

// --- covariance / correlation -------------------------------------------------

function returnsOverWindow(sym, window, cache) {
  if (cache[sym]) return cache[sym];
  const close = statsClose(sym);
  const windowCloses = close.slice(Math.max(0, close.length - window - 1));
  const rets = [];
  for (let i = 1; i < windowCloses.length; i++) rets.push(windowCloses[i] / windowCloses[i - 1] - 1);
  cache[sym] = rets;
  return rets;
}

function computeReturnsAndStats() {
  ASSET_ORDER.forEach(sym => {
    returnsOverWindow(sym, WINDOW, RETURNS);
    const close = statsClose(sym);
    const windowCloses = close.slice(close.length - WINDOW - 1);
    const totalReturn = windowCloses[windowCloses.length - 1] / windowCloses[0] - 1;
    ANN_RETURN[sym] = Math.pow(1 + totalReturn, TRADING_DAYS / WINDOW) - 1;
  });

  COV = ASSET_ORDER.map(symI => ASSET_ORDER.map(symJ => {
    const ri = RETURNS[symI], rj = RETURNS[symJ];
    const mi = statsMean(ri), mj = statsMean(rj);
    let s = 0;
    for (let k = 0; k < ri.length; k++) s += (ri[k] - mi) * (rj[k] - mj);
    return (s / (ri.length - 1)) * TRADING_DAYS;
  }));
  ASSET_ORDER.forEach((sym, i) => { SIGMA[sym] = Math.sqrt(COV[i][i]); });
  RF = STATS_DATA.risk_free.rf_annual_pct / 100;
}

function computeCorrelation() {
  ASSET_ORDER.forEach(sym => returnsOverWindow(sym, statsClose(sym).length - 1, CORR_RETURNS));
  // Clamp every series to the shortest so each pair covers the same calendar
  // window (all 5 share the NYSE calendar — a length clamp, not a realignment).
  const minLen = Math.min(...ASSET_ORDER.map(sym => CORR_RETURNS[sym].length));
  const aligned = {};
  ASSET_ORDER.forEach(sym => { aligned[sym] = CORR_RETURNS[sym].slice(-minLen); });

  CORR = ASSET_ORDER.map(symI => ASSET_ORDER.map(symJ => {
    const ri = aligned[symI], rj = aligned[symJ];
    const mi = statsMean(ri), mj = statsMean(rj);
    let sij = 0, sii = 0, sjj = 0;
    for (let k = 0; k < ri.length; k++) {
      const di = ri[k] - mi, dj = rj[k] - mj;
      sij += di * dj; sii += di * di; sjj += dj * dj;
    }
    return sij / Math.sqrt(sii * sjj);
  }));
  window.CORR_MATRIX = CORR;
}

// Accepts signed weights — a short passes a negative weight, and the
// quadratic form handles it correctly, which is what makes a hedge show up as
// risk-reducing instead of risk-adding.
function portfolioVariance(w) {
  const wv = ASSET_ORDER.map(sym => w[sym]);
  let v = 0;
  for (let i = 0; i < ASSET_ORDER.length; i++) {
    for (let j = 0; j < ASSET_ORDER.length; j++) v += wv[i] * wv[j] * COV[i][j];
  }
  return v;
}

// Safe to call repeatedly: every cache is rebuilt, so this is also how live
// quotes get folded in (patch the close arrays, then call initStats again).
function initStats(data) {
  STATS_DATA = data;
  RETURNS = {}; CORR_RETURNS = {}; ANN_RETURN = {}; SIGMA = {};

  const rfAnnual = data.risk_free.rf_annual_pct / 100;
  const capmWindow = data.capm_window_days || 252;
  ASSET_ORDER.forEach(sym => {
    const asset = data.assets[sym];
    Object.assign(asset, buildAssetSeries(asset.close));
    asset.capm = computeCapmFor(sym, capmWindow, rfAnnual) || asset.capm;
  });

  computeReturnsAndStats();
  computeCorrelation();
}
