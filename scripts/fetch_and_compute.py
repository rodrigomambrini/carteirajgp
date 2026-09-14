"""
Fetches price data from Yahoo Finance for the 5 positions in Rodrigo's
carteira (XLK, XLE, EWZ, XLY, GLD) plus the S&P 500 (^GSPC) as the CAPM
benchmark, and CDI (Banco Central) as the risk-free rate.

Per asset it writes: the daily price/drawdown/rolling-vol/rolling-Sharpe
series, an intraday `quote` block (last price, open/high/low, volume, market
state), and a `capm` block (OLS beta/alpha vs the benchmark over the last
CAPM_WINDOW trading days).

Portfolio-level numbers are deliberately NOT computed here — the page
recomputes return/vol/Sharpe/beta/alpha/VaR/risk-contribution in the browser
from whatever weights the user sets in the "Ajuste a carteira" panel, so a
server-side snapshot of them would just be a stale duplicate.

Writes data/portfolio_data.json. Run manually or via
.github/workflows/update-data.yml, which runs every 15 minutes during market
hours so a page refresh always picks up near-live prices.
"""
import json
import math
import os
import urllib.parse
import urllib.request
import datetime

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_DIR = os.path.join(BASE_DIR, "data")

with open(os.path.join(DATA_DIR, "portfolio.json"), encoding="utf-8") as f:
    PORTFOLIO = json.load(f)

ASSET_NAMES = {p["symbol"]: p["name"] for p in PORTFOLIO["positions"]}
ASSET_ORDER = [p["symbol"] for p in PORTFOLIO["positions"]]
BENCHMARK_SYMBOL = PORTFOLIO["benchmark_symbol"]

VOL_WINDOW = 21
SHARPE_WINDOW = 63
TRADING_DAYS = 252
CAPM_WINDOW = 252    # 1 trading year for beta/alpha
YEARS_TO_KEEP = 11   # long history so the "Max" range and the correlation window have room


def _get_json(url):
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.load(resp)


def fetch_daily(symbol):
    """Daily closes. During market hours Yahoo includes a partial bar for the
    current session, so the last point already carries today's live price."""
    url = (
        f"https://query1.finance.yahoo.com/v8/finance/chart/{urllib.parse.quote(symbol)}"
        f"?period1=0&period2=9999999999&interval=1d&events=history"
    )
    result = _get_json(url)["chart"]["result"][0]
    ts = result["timestamp"]
    quote = result["indicators"]["quote"][0]
    dedup = {}
    for i in range(len(ts)):
        c = quote["close"][i]
        if c is None:
            continue
        dedup[datetime.datetime.utcfromtimestamp(ts[i]).date()] = c
    return sorted(dedup.items())


def fetch_quote(symbol):
    """Current session snapshot: last price, open/high/low, volume, market
    state. Uses the 5-minute intraday endpoint because its `meta` carries the
    live regularMarket* fields and its first bar gives the session open."""
    url = (
        f"https://query1.finance.yahoo.com/v8/finance/chart/{urllib.parse.quote(symbol)}"
        f"?range=1d&interval=5m"
    )
    result = _get_json(url)["chart"]["result"][0]
    meta = result.get("meta", {})
    opens = [o for o in (result.get("indicators", {}).get("quote", [{}])[0].get("open") or []) if o is not None]
    prev_close = meta.get("chartPreviousClose") or meta.get("previousClose")
    last = meta.get("regularMarketPrice")
    return {
        "last_price": round(last, 4) if last is not None else None,
        "open": round(opens[0], 4) if opens else None,
        "day_high": round(meta["regularMarketDayHigh"], 4) if meta.get("regularMarketDayHigh") is not None else None,
        "day_low": round(meta["regularMarketDayLow"], 4) if meta.get("regularMarketDayLow") is not None else None,
        "previous_close": round(prev_close, 4) if prev_close is not None else None,
        "volume": meta.get("regularMarketVolume"),
        "change_pct": round((last / prev_close - 1) * 100, 4) if last and prev_close else None,
        "market_state": meta.get("marketState"),
        "quote_time_utc": (
            datetime.datetime.utcfromtimestamp(meta["regularMarketTime"]).isoformat() + "Z"
            if meta.get("regularMarketTime") else None
        ),
    }


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
    }


def fetch_cdi(start_date, end_date):
    """Daily CDI (% per day) from the Banco Central SGS API, series 12. The
    `dados` endpoint hard-caps the date span at 3652 days and 406s past that,
    so the requested start is clamped."""
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
    return [float(row["valor"]) for row in rows]


def capm_beta_alpha(asset_rets, mkt_rets):
    """OLS beta/alpha of asset daily returns on market daily returns."""
    n = len(asset_rets)
    ma, mm = sum(asset_rets) / n, sum(mkt_rets) / n
    cov = sum((asset_rets[i] - ma) * (mkt_rets[i] - mm) for i in range(n)) / (n - 1)
    var_m = sum((r - mm) ** 2 for r in mkt_rets) / (n - 1)
    beta = cov / var_m if var_m > 0 else 0.0
    alpha_daily = ma - beta * mm
    return beta, ((1 + alpha_daily) ** TRADING_DAYS - 1) * 100


def main():
    today = datetime.date.today()
    cutoff = today - datetime.timedelta(days=int(365.25 * YEARS_TO_KEEP))

    out = {
        "generated_at_utc": datetime.datetime.now(datetime.timezone.utc).replace(tzinfo=None).isoformat() + "Z",
        "vol_window_days": VOL_WINDOW,
        "sharpe_window_days": SHARPE_WINDOW,
        "capm_window_days": CAPM_WINDOW,
        "portfolio": dict(PORTFOLIO),
        "assets": {},
    }

    raw = {}
    for sym in ASSET_ORDER:
        rows = [(d, c) for d, c in fetch_daily(sym) if d >= cutoff]
        raw[sym] = compute_series([d.isoformat() for d, _ in rows], [c for _, c in rows])
        print(f"{sym}: {len(rows)} daily rows, last {rows[-1][1]:.2f}")

    bench_rows = [(d, c) for d, c in fetch_daily(BENCHMARK_SYMBOL) if d >= cutoff]
    bench_dates = [d.isoformat() for d, _ in bench_rows]
    bench_closes = [c for _, c in bench_rows]
    print(f"{BENCHMARK_SYMBOL}: {len(bench_rows)} daily rows")

    try:
        cdi_rates = fetch_cdi(cutoff, today)
        latest_cdi_daily_pct = cdi_rates[-1] if cdi_rates else 0.0
        print(f"CDI: {len(cdi_rates)} rows, latest {latest_cdi_daily_pct}%/day")
    except Exception as exc:
        print(f"CDI fetch failed ({exc}); defaulting rf=0")
        latest_cdi_daily_pct = 0.0
    rf_annual = (1 + latest_cdi_daily_pct / 100) ** TRADING_DAYS - 1

    bench_close_by_date = dict(zip(bench_dates, bench_closes))
    for sym in ASSET_ORDER:
        s = raw[sym]
        asset_close_by_date = dict(zip(s["dates"], s["close"]))
        common = [d for d in s["dates"] if d in bench_close_by_date][-(CAPM_WINDOW + 1):]
        a_closes = [asset_close_by_date[d] for d in common]
        m_closes = [bench_close_by_date[d] for d in common]
        a_rets = [a_closes[i] / a_closes[i - 1] - 1 for i in range(1, len(a_closes))]
        m_rets = [m_closes[i] / m_closes[i - 1] - 1 for i in range(1, len(m_closes))]
        beta, alpha_annual_pct = capm_beta_alpha(a_rets, m_rets)
        mkt_ann = (m_closes[-1] / m_closes[0]) ** (TRADING_DAYS / len(m_rets)) - 1
        asset_ann = (a_closes[-1] / a_closes[0]) ** (TRADING_DAYS / len(a_rets)) - 1

        try:
            quote = fetch_quote(sym)
        except Exception as exc:  # a missing quote shouldn't fail the whole run
            print(f"{sym}: quote fetch failed ({exc})")
            quote = {}

        out["assets"][sym] = {
            **s,
            "name": ASSET_NAMES[sym],
            "quote": quote,
            "capm": {
                "beta": round(beta, 3),
                "alpha_annual_pct": round(alpha_annual_pct, 2),
                "expected_capm_pct": round((rf_annual + beta * (mkt_ann - rf_annual)) * 100, 2),
                "realized_return_pct": round(asset_ann * 100, 2),
            },
        }

    out["benchmark"] = {
        "symbol": BENCHMARK_SYMBOL,
        "name": PORTFOLIO["benchmark_name"],
        "dates": bench_dates,
        "close": [round(c, 4) for c in bench_closes],
    }
    out["risk_free"] = {"rf_annual_pct": round(rf_annual * 100, 3), "source": "CDI (Banco Central SGS 12), anualizado"}

    out_path = os.path.join(DATA_DIR, "portfolio_data.json")
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False)
    print("wrote", out_path)


if __name__ == "__main__":
    main()
