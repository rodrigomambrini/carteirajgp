"""
Fetches daily price history from Yahoo Finance for the 5 positions held in
Rodrigo's carteira (XLK, XLE, EWZ, XLY long/short, GLD) plus the S&P 500
(^GSPC) as the CAPM benchmark, and CDI (Banco Central) as the risk-free rate.

Computes, per asset: price/performance/drawdown/rolling-vol/rolling-Sharpe
series (same method as the desafiojgp project, reused here), plus CAPM
beta/alpha vs the benchmark over the last CAPM_WINDOW trading days.

Also computes an aggregated "Carteira" daily series (signed weights - XLY is
held SHORT, so its daily return is subtracted, not added - plus cash earning
the daily CDI rate) and portfolio-level aggregate metrics: expected return,
volatility (from the covariance matrix using signed weights), Sharpe, beta,
alpha, 1-day 95% parametric VaR, and Euler risk-contribution by position.

Writes data/portfolio_data.json, read by js/app.js and js/markowitz.js.
Run manually or via .github/workflows/update-data.yml on a schedule.
"""
import json
import math
import os
import urllib.request
import datetime

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_DIR = os.path.join(BASE_DIR, "data")

with open(os.path.join(DATA_DIR, "portfolio.json"), encoding="utf-8") as f:
    PORTFOLIO = json.load(f)

ASSET_NAMES = {p["symbol"]: p["name"] for p in PORTFOLIO["positions"]}
ASSET_SIDE = {p["symbol"]: (1 if p["side"] == "long" else -1) for p in PORTFOLIO["positions"]}
ASSET_WEIGHT = {p["symbol"]: p["weight"] for p in PORTFOLIO["positions"]}
ASSET_ORDER = [p["symbol"] for p in PORTFOLIO["positions"]]
CASH_WEIGHT = PORTFOLIO["cash_weight"]
BENCHMARK_SYMBOL = PORTFOLIO["benchmark_symbol"]

VOL_WINDOW = 21
SHARPE_WINDOW = 63
TRADING_DAYS = 252
CAPM_WINDOW = 252          # 1 trading year for beta/alpha and portfolio vol/VaR
YEARS_TO_KEEP = 11         # enough daily history for a long-window correlation view client-side


def fetch_daily(symbol):
    url = (
        f"https://query1.finance.yahoo.com/v8/finance/chart/{symbol}"
        f"?period1=0&period2=9999999999&interval=1d&events=history"
    )
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=30) as resp:
        payload = json.load(resp)
    result = payload["chart"]["result"][0]
    ts = result["timestamp"]
    quote = result["indicators"]["quote"][0]
    rows = []
    for i in range(len(ts)):
        c = quote["close"][i]
        if c is None:
            continue
        d = datetime.datetime.utcfromtimestamp(ts[i]).date()
        rows.append((d, c))
    rows.sort(key=lambda r: r[0])
    dedup = {}
    for d, c in rows:
        dedup[d] = c
    return sorted(dedup.items())


def percentile(sorted_vals, pct):
    if not sorted_vals:
        return None
    k = (len(sorted_vals) - 1) * pct
    lo, hi = math.floor(k), math.ceil(k)
    if lo == hi:
        return sorted_vals[int(k)]
    return sorted_vals[lo] + (sorted_vals[hi] - sorted_vals[lo]) * (k - lo)


def percentile_band(values):
    if not values:
        return {"p10": None, "p25": None, "p50": None, "p75": None, "p90": None}
    s = sorted(values)
    return {k: round(percentile(s, p), 4) for k, p in (("p10", .10), ("p25", .25), ("p50", .50), ("p75", .75), ("p90", .90))}


def compute_series(dates, closes):
    rets = [None]
    for i in range(1, len(closes)):
        rets.append(closes[i] / closes[i - 1] - 1)

    perf = [100.0]
    for i in range(1, len(closes)):
        perf.append(perf[-1] * (1 + rets[i]))

    peak = closes[0]
    drawdown = []
    for c in closes:
        peak = max(peak, c)
        drawdown.append((c / peak - 1) * 100)
    max_dd = min(drawdown)
    max_dd_date = dates[drawdown.index(max_dd)]

    roll_vol = [None] * len(closes)
    for i in range(VOL_WINDOW, len(closes)):
        window = [r for r in rets[i - VOL_WINDOW + 1:i + 1] if r is not None]
        if len(window) < VOL_WINDOW - 1:
            continue
        m = sum(window) / len(window)
        var = sum((r - m) ** 2 for r in window) / (len(window) - 1)
        roll_vol[i] = math.sqrt(var) * math.sqrt(TRADING_DAYS) * 100

    roll_sharpe = [None] * len(closes)
    for i in range(SHARPE_WINDOW, len(closes)):
        window = [r for r in rets[i - SHARPE_WINDOW + 1:i + 1] if r is not None]
        if len(window) < SHARPE_WINDOW - 1:
            continue
        m = sum(window) / len(window)
        var = sum((r - m) ** 2 for r in window) / (len(window) - 1)
        sd = math.sqrt(var)
        roll_sharpe[i] = (m / sd) * math.sqrt(TRADING_DAYS) if sd > 0 else None

    vol_valid = [v for v in roll_vol if v is not None]
    sharpe_valid = [s for s in roll_sharpe if s is not None]
    last_close, prev_close = closes[-1], (closes[-2] if len(closes) > 1 else closes[-1])

    return {
        "dates": dates,
        "close": [round(c, 4) for c in closes],
        "perf_index": [round(p, 4) for p in perf],
        "drawdown_pct": [round(d, 4) for d in drawdown],
        "rolling_vol_pct": [None if v is None else round(v, 4) for v in roll_vol],
        "rolling_sharpe": [None if s is None else round(s, 4) for s in roll_sharpe],
        "bands": {"vol": percentile_band(vol_valid), "sharpe": percentile_band(sharpe_valid)},
        "stats": {
            "last_close": round(last_close, 2),
            "day_change_pct": round((last_close / prev_close - 1) * 100, 4),
            "max_drawdown_pct": round(max_dd, 2),
            "max_drawdown_date": max_dd_date,
            "current_drawdown_pct": round(drawdown[-1], 2),
            "latest_rolling_vol_pct": None if not vol_valid else round(vol_valid[-1], 2),
            "latest_rolling_sharpe": None if not sharpe_valid else round(sharpe_valid[-1], 2),
        },
        "_rets": rets,  # internal use only, stripped before writing to disk
    }


def fetch_cdi(start_date, end_date):
    max_span = datetime.timedelta(days=3652)
    if end_date - start_date > max_span:
        start_date = end_date - max_span
    url = (
        "https://api.bcb.gov.br/dados/serie/bcdata.sgs.12/dados"
        f"?formato=json&dataInicial={start_date.strftime('%d/%m/%Y')}&dataFinal={end_date.strftime('%d/%m/%Y')}"
    )
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0", "Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=30) as resp:
        rows = json.load(resp)
    dates, rates = [], []
    for row in rows:
        d, m, y = row["data"].split("/")
        dates.append(f"{y}-{m}-{d}")
        rates.append(float(row["valor"]))
    return {"dates": dates, "daily_rate_pct": rates}


def capm_beta_alpha(asset_rets, mkt_rets):
    """OLS beta/alpha of asset daily returns on market daily returns, both
    already aligned/truncated to the same length and window."""
    n = len(asset_rets)
    ma, mm = sum(asset_rets) / n, sum(mkt_rets) / n
    cov = sum((asset_rets[i] - ma) * (mkt_rets[i] - mm) for i in range(n)) / (n - 1)
    var_m = sum((r - mm) ** 2 for r in mkt_rets) / (n - 1)
    beta = cov / var_m if var_m > 0 else 0.0
    alpha_daily = ma - beta * mm
    alpha_annual_pct = ((1 + alpha_daily) ** TRADING_DAYS - 1) * 100
    return beta, alpha_annual_pct


def cdi_lookup(cdi):
    """date(iso)->daily rate% lookup with forward-fill for dates before/between CDI points."""
    pairs = list(zip(cdi["dates"], cdi["daily_rate_pct"]))
    pairs.sort()

    def get(date_iso):
        lo, hi = 0, len(pairs) - 1
        best = pairs[0][1] if pairs else 0.0
        while lo <= hi:
            mid = (lo + hi) // 2
            if pairs[mid][0] <= date_iso:
                best = pairs[mid][1]
                lo = mid + 1
            else:
                hi = mid - 1
        return best

    return get


def main():
    today = datetime.date.today()
    cutoff = today - datetime.timedelta(days=int(365.25 * YEARS_TO_KEEP))

    out = {
        "generated_at_utc": datetime.datetime.utcnow().isoformat() + "Z",
        "vol_window_days": VOL_WINDOW,
        "sharpe_window_days": SHARPE_WINDOW,
        "capm_window_days": CAPM_WINDOW,
        "portfolio": dict(PORTFOLIO),
        "assets": {},
    }

    raw = {}
    for sym in ASSET_ORDER:
        rows = [(d, c) for d, c in fetch_daily(sym) if d >= cutoff]
        dates = [d.isoformat() for d, _ in rows]
        closes = [c for _, c in rows]
        raw[sym] = compute_series(dates, closes)
        print(f"{sym}: {len(dates)} rows, last close {closes[-1]:.2f}")

    bench_rows = [(d, c) for d, c in fetch_daily(BENCHMARK_SYMBOL) if d >= cutoff]
    bench_dates = [d.isoformat() for d, _ in bench_rows]
    bench_closes = [c for _, c in bench_rows]
    bench_series = compute_series(bench_dates, bench_closes)
    print(f"{BENCHMARK_SYMBOL}: {len(bench_dates)} rows")

    try:
        cdi = fetch_cdi(cutoff, today)
        print(f"CDI: {len(cdi['dates'])} rows")
    except Exception as exc:
        print(f"CDI fetch failed ({exc}); defaulting rf=0")
        cdi = {"dates": [], "daily_rate_pct": []}
    cdi_get = cdi_lookup(cdi)
    latest_cdi_daily_pct = cdi["daily_rate_pct"][-1] if cdi["daily_rate_pct"] else 0.0
    rf_annual = (1 + latest_cdi_daily_pct / 100) ** TRADING_DAYS - 1

    # --- CAPM per asset, over the last CAPM_WINDOW common trading days ------
    bench_date_index = {d: i for i, d in enumerate(bench_dates)}
    capm = {}
    for sym in ASSET_ORDER:
        s = raw[sym]
        common_dates = [d for d in s["dates"] if d in bench_date_index]
        common_dates = common_dates[-(CAPM_WINDOW + 1):]
        asset_close_by_date = dict(zip(s["dates"], s["close"]))
        bench_close_by_date = dict(zip(bench_dates, bench_closes))
        a_closes = [asset_close_by_date[d] for d in common_dates]
        m_closes = [bench_close_by_date[d] for d in common_dates]
        a_rets = [a_closes[i] / a_closes[i - 1] - 1 for i in range(1, len(a_closes))]
        m_rets = [m_closes[i] / m_closes[i - 1] - 1 for i in range(1, len(m_closes))]
        beta, alpha_annual_pct = capm_beta_alpha(a_rets, m_rets)
        mkt_total_return = m_closes[-1] / m_closes[0] - 1
        mkt_ann_return = (1 + mkt_total_return) ** (TRADING_DAYS / len(m_rets)) - 1
        asset_total_return = a_closes[-1] / a_closes[0] - 1
        asset_ann_return = (1 + asset_total_return) ** (TRADING_DAYS / len(a_rets)) - 1
        expected_capm = rf_annual + beta * (mkt_ann_return - rf_annual)
        capm[sym] = {
            "beta": round(beta, 3),
            "alpha_annual_pct": round(alpha_annual_pct, 2),
            "expected_capm_pct": round(expected_capm * 100, 2),
            "realized_return_pct": round(asset_ann_return * 100, 2),
            "_ann_return": asset_ann_return,
            "_rets_window": a_rets,
        }
        s.pop("_rets", None)
        out["assets"][sym] = {**s, "name": ASSET_NAMES[sym], "capm": {k: v for k, v in capm[sym].items() if not k.startswith("_")}}

    out["benchmark"] = {**{k: v for k, v in bench_series.items() if k != "_rets"}, "name": PORTFOLIO["benchmark_name"], "symbol": BENCHMARK_SYMBOL}
    out["risk_free"] = {"rf_annual_pct": round(rf_annual * 100, 3), "source": "CDI (Banco Central SGS 12), anualizado"}

    # --- Aggregate "Carteira" daily series (signed weights + cash @ CDI) ----
    common_dates = raw[ASSET_ORDER[0]]["dates"]
    for sym in ASSET_ORDER[1:]:
        common_dates = [d for d in common_dates if d in set(raw[sym]["dates"])]
    common_dates.sort()

    asset_ret_by_date = {sym: dict(zip(raw[sym]["dates"], [None] + [
        raw[sym]["close"][i] / raw[sym]["close"][i - 1] - 1 for i in range(1, len(raw[sym]["close"]))
    ])) for sym in ASSET_ORDER}

    port_dates, port_rets = [], [None]
    for i, d in enumerate(common_dates):
        port_dates.append(d)
        if i == 0:
            continue
        daily_cdi_pct = cdi_get(d)
        r = CASH_WEIGHT * (daily_cdi_pct / 100)
        for sym in ASSET_ORDER:
            ar = asset_ret_by_date[sym].get(d)
            if ar is not None:
                r += ASSET_WEIGHT[sym] * ASSET_SIDE[sym] * ar
        port_rets.append(r)

    port_closes = [100.0]
    for i in range(1, len(port_rets)):
        port_closes.append(port_closes[-1] * (1 + port_rets[i]))
    port_series = compute_series(port_dates, port_closes)
    port_series.pop("_rets", None)
    out["portfolio_series"] = port_series

    # --- Covariance (CAPM_WINDOW) with signed weights, for vol/VaR/contribution
    window_dates = common_dates[-(CAPM_WINDOW + 1):]
    rets_matrix = {}
    for sym in ASSET_ORDER:
        closes = [dict(zip(raw[sym]["dates"], raw[sym]["close"]))[d] for d in window_dates]
        rets_matrix[sym] = [closes[i] / closes[i - 1] - 1 for i in range(1, len(closes))]

    n = len(ASSET_ORDER)
    means = {sym: sum(rets_matrix[sym]) / len(rets_matrix[sym]) for sym in ASSET_ORDER}
    cov_daily = [[0.0] * n for _ in range(n)]
    for i, si in enumerate(ASSET_ORDER):
        for j, sj in enumerate(ASSET_ORDER):
            ri, rj = rets_matrix[si], rets_matrix[sj]
            mi, mj = means[si], means[sj]
            cov_daily[i][j] = sum((ri[k] - mi) * (rj[k] - mj) for k in range(len(ri))) / (len(ri) - 1)

    signed_w = [ASSET_WEIGHT[sym] * ASSET_SIDE[sym] for sym in ASSET_ORDER]
    port_var_daily = sum(signed_w[i] * signed_w[j] * cov_daily[i][j] for i in range(n) for j in range(n))
    port_vol_daily = math.sqrt(max(port_var_daily, 0))
    port_vol_annual = port_vol_daily * math.sqrt(TRADING_DAYS)

    capital = PORTFOLIO["capital_usd"]
    var95_1d_pct = 1.645 * port_vol_daily * 100
    var95_1d_usd = 1.645 * port_vol_daily * capital

    port_ann_return_capm = sum(signed_w[i] * capm[ASSET_ORDER[i]]["expected_capm_pct"] / 100 for i in range(n)) + CASH_WEIGHT * rf_annual
    port_ann_return_realized = sum(signed_w[i] * capm[ASSET_ORDER[i]]["_ann_return"] for i in range(n)) + CASH_WEIGHT * rf_annual
    port_beta = sum(signed_w[i] * capm[ASSET_ORDER[i]]["beta"] for i in range(n))
    port_alpha_pct = sum(signed_w[i] * capm[ASSET_ORDER[i]]["alpha_annual_pct"] for i in range(n))
    port_sharpe = (port_ann_return_realized - rf_annual) / port_vol_annual if port_vol_annual > 0 else None

    sigma_w_daily = [sum(cov_daily[i][j] * signed_w[j] for j in range(n)) for i in range(n)]
    contrib = {}
    for i, sym in enumerate(ASSET_ORDER):
        contrib[sym] = (signed_w[i] * sigma_w_daily[i] / port_var_daily * 100) if port_var_daily > 0 else 0.0
    contrib["CASH"] = 0.0
    enb = 1 / sum((c / 100) ** 2 for c in contrib.values()) if any(contrib.values()) else 1
    n_effective_assets = n + 1  # + cash slot
    diversification_pct = max(0.0, min(100.0, ((enb - 1) / (n_effective_assets - 1)) * 100))

    out["portfolio_metrics"] = {
        "capital_usd": capital,
        "expected_return_capm_pct": round(port_ann_return_capm * 100, 2),
        "expected_return_realized_pct": round(port_ann_return_realized * 100, 2),
        "volatility_annual_pct": round(port_vol_annual * 100, 2),
        "sharpe": None if port_sharpe is None else round(port_sharpe, 2),
        "beta": round(port_beta, 3),
        "alpha_annual_pct": round(port_alpha_pct, 2),
        "var95_1d_pct": round(var95_1d_pct, 3),
        "var95_1d_usd": round(var95_1d_usd, 0),
        "diversification_pct": round(diversification_pct, 1),
        "risk_contribution_pct": {k: round(v, 1) for k, v in contrib.items()},
        "risk_free_annual_pct": round(rf_annual * 100, 3),
        "window_days": CAPM_WINDOW,
    }

    for sym in ASSET_ORDER:
        out["assets"][sym].pop("_rets", None)

    out_path = os.path.join(DATA_DIR, "portfolio_data.json")
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False)
    print("wrote", out_path)


if __name__ == "__main__":
    main()
