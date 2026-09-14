/*
 * Shared statistics for the dashboard: annualized returns, the covariance
 * matrix and the correlation matrix over the 5 positions.
 *
 * This file used to also host a long-only Markowitz simulator, an efficient
 * frontier and a max-Sharpe recommendation card (section 4). Rodrigo asked
 * for those to be removed — the dashboard is for analysing the real book,
 * not for theoretical optimization — so only the math the rest of the page
 * actually consumes survives here.
 *
 * Consumers (all in js/app.js, which runs after initStats()):
 *   COV        annualized covariance matrix, order = ASSET_ORDER
 *   CORR       correlation matrix (also exposed as window.CORR_MATRIX)
 *   ANN_RETURN sym -> annualized realized return over WINDOW
 *   SIGMA      sym -> annualized volatility
 *   RF         annualized risk-free rate (CDI)
 *   portfolioVariance(w)  w'*COV*w, accepts SIGNED weights (short = negative)
 *
 * Two windows on purpose: return/vol/covariance use the short WINDOW (63
 * trading days) so they react to regime changes, while correlation uses the
 * full loaded history, since correlation is a far more stable quantity and a
 * quarter is too small a sample to pin it down. Same split as the sibling
 * desafiojgp project.
 */

const WINDOW = 63;        // trading days — return/vol/covariance window
const TRADING_DAYS = 252;

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
  // Clamp every series to the shortest one so each pair is measured over the
  // same calendar window (all 5 share the NYSE calendar, so this is a length
  // clamp, not a date realignment).
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

// Accepts signed weights — a short position passes a negative weight, and the
// quadratic form handles it correctly (that's what makes a hedge show up as
// risk-reducing rather than risk-adding).
function portfolioVariance(w) {
  const wv = ASSET_ORDER.map(sym => w[sym]);
  let v = 0;
  for (let i = 0; i < ASSET_ORDER.length; i++) {
    for (let j = 0; j < ASSET_ORDER.length; j++) v += wv[i] * wv[j] * COV[i][j];
  }
  return v;
}

function initStats(data) {
  STATS_DATA = data;
  RETURNS = {}; CORR_RETURNS = {}; ANN_RETURN = {}; SIGMA = {};
  computeReturnsAndStats();
  computeCorrelation();
}
