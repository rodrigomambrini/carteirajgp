"""
Fetches price data from Yahoo Finance for the 5 positions in Rodrigo's
carteira (XLK, XLE, EWZ, XLY, GLD) plus the S&P 500 (^GSPC) as the CAPM
benchmark, and CDI (Banco Central) as the risk-free rate.

This is deliberately a thin fetcher: per asset it writes only `dates`,
`close` and an intraday `quote` block. Every derived number — drawdown,
rolling vol/Sharpe, covariance, correlation, CAPM beta/alpha and all the
portfolio-level metrics — is computed in the browser by js/stats.js and
js/app.js.

Two reasons for that split. The weights live in the UI, so portfolio metrics
computed here would go stale the moment a slider moves. And when a live quote
from the Cloudflare Worker patches the tail of a close array, the page has to
recompute those series anyway; keeping a second implementation here would be
two versions of the same math, free to disagree.

Writes data/portfolio_data.json. Run manually or via
.github/workflows/update-data.yml, which runs every 15 minutes during market
hours so a page refresh always picks up near-live prices.
"""
import json
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

TRADING_DAYS = 252
# The only window this script still owns: it's shipped as metadata and read by
# js/stats.js's computeCapmFor(). The rolling vol/Sharpe windows live in
# js/stats.js, since that's where those series are actually built.
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


def main():
    today = datetime.date.today()
    cutoff = today - datetime.timedelta(days=int(365.25 * YEARS_TO_KEEP))

    out = {
        "generated_at_utc": datetime.datetime.now(datetime.timezone.utc).replace(tzinfo=None).isoformat() + "Z",
        "capm_window_days": CAPM_WINDOW,
        "portfolio": dict(PORTFOLIO),
        "assets": {},
    }

    for sym in ASSET_ORDER:
        rows = [(d, c) for d, c in fetch_daily(sym) if d >= cutoff]
        try:
            quote = fetch_quote(sym)
        except Exception as exc:  # a missing quote shouldn't fail the whole run
            print(f"{sym}: quote fetch failed ({exc})")
            quote = {}
        out["assets"][sym] = {
            "name": ASSET_NAMES[sym],
            "dates": [d.isoformat() for d, _ in rows],
            "close": [round(c, 4) for _, c in rows],
            "quote": quote,
        }
        print(f"{sym}: {len(rows)} daily rows, last {rows[-1][1]:.2f}")

    bench_rows = [(d, c) for d, c in fetch_daily(BENCHMARK_SYMBOL) if d >= cutoff]
    print(f"{BENCHMARK_SYMBOL}: {len(bench_rows)} daily rows")

    try:
        cdi_rates = fetch_cdi(cutoff, today)
        latest_cdi_daily_pct = cdi_rates[-1] if cdi_rates else 0.0
        print(f"CDI: {len(cdi_rates)} rows, latest {latest_cdi_daily_pct}%/day")
    except Exception as exc:
        print(f"CDI fetch failed ({exc}); defaulting rf=0")
        latest_cdi_daily_pct = 0.0
    rf_annual = (1 + latest_cdi_daily_pct / 100) ** TRADING_DAYS - 1

    out["benchmark"] = {
        "symbol": BENCHMARK_SYMBOL,
        "name": PORTFOLIO["benchmark_name"],
        "dates": [d.isoformat() for d, _ in bench_rows],
        "close": [round(c, 4) for _, c in bench_rows],
    }
    out["risk_free"] = {"rf_annual_pct": round(rf_annual * 100, 3), "source": "CDI (Banco Central SGS 12), anualizado"}

    out_path = os.path.join(DATA_DIR, "portfolio_data.json")
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False)
    print("wrote", out_path)


if __name__ == "__main__":
    main()
