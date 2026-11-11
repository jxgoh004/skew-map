"""Skew map data pipeline - zero-cost sources only.

Options (per-contract IV + delta): CBOE delayed quotes (free, ~15 min delayed, unofficial endpoint).
Prices / volume / earnings dates:  Yahoo Finance via yfinance (free, unofficial).

Run:  python build_data.py            (full universe)
      python build_data.py --quick    (watchlist + indices only)

Writes site/data/latest.js (loaded by the site) and site/data/history/<date>.json (for change columns).
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import re
import statistics
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import requests

ROOT = Path(__file__).parent
OUT = ROOT / "site" / "data"
HIST = OUT / "history"
CBOE = "https://cdn.cboe.com/api/global/delayed_quotes/options/{}.json"
UA = {"User-Agent": "Mozilla/5.0 (skew-map; personal research)"}
OPT_RE = re.compile(r"^([A-Z.]+?)(\d{6})([CP])(\d{8})$")


# ---------- options ----------

def fetch_chain(symbol: str) -> dict | None:
    sym = symbol.replace(".", "")  # CBOE: BRK.B -> BRKB
    for attempt in range(4):
        try:
            r = requests.get(CBOE.format(sym), headers=UA, timeout=40)
            if r.status_code == 200:
                return r.json()
            if r.status_code == 404:  # no listed options for this symbol
                return None
        except (requests.RequestException, ValueError):
            pass
        time.sleep(3 * (attempt + 1))  # rate limits and transient blocks: back off and retry
    return None


def third_friday(d: dt.date) -> bool:
    return d.weekday() == 4 and 15 <= d.day <= 21


def pick_expiry(expiries: list[dt.date], today: dt.date, cfg: dict) -> dt.date | None:
    lo, hi = cfg["expiry"]["min_dte"], cfg["expiry"]["max_dte"]
    monthly = [e for e in expiries if third_friday(e) and lo <= (e - today).days <= hi]
    return min(monthly) if monthly else None


def interp(points: list[tuple[float, float]], x: float) -> float | None:
    """Linear interpolation of y at x over (x, y) points; None if x is not bracketed."""
    pts = sorted(points)
    for (x0, y0), (x1, y1) in zip(pts, pts[1:]):
        if x0 <= x <= x1:
            return y0 if x1 == x0 else y0 + (y1 - y0) * (x - x0) / (x1 - x0)
    return None


def spread_pct(o: dict) -> float:
    mid = (o["bid"] + o["ask"]) / 2
    return 100 * (o["ask"] - o["bid"]) / mid if mid > 0 else 999.0


def analyse_chain(symbol: str, raw: dict, cfg: dict) -> dict:
    """Reduce a full chain to the three numbers the map needs, plus quality flags."""
    d = raw["data"]
    today = dt.date.fromisoformat(raw["timestamp"][:10])
    spot = d.get("current_price") or d.get("close")
    res: dict = {"t": symbol, "px": spot, "iv30": d.get("iv30"), "asof": raw["timestamp"], "ok": False}

    by_exp: dict[dt.date, list[dict]] = {}
    for o in d.get("options", []):
        m = OPT_RE.match(o["option"])
        if not m:
            continue
        exp = dt.datetime.strptime(m.group(2), "%y%m%d").date()
        by_exp.setdefault(exp, []).append({**o, "cp": m.group(3), "k": int(m.group(4)) / 1000})

    exp = pick_expiry(list(by_exp), today, cfg)
    if not exp or not spot:
        res["why"] = "no monthly expiry in window"
        return res
    res["exp"], res["dte"] = exp.isoformat(), (exp - today).days
    legs = [o for o in by_exp[exp] if o["iv"] and o["iv"] > 0 and o["bid"] > 0]
    puts = [o for o in legs if o["cp"] == "P"]
    calls = [o for o in legs if o["cp"] == "C"]
    tgt = cfg["delta"]

    put_iv = interp([(abs(o["delta"]), o["iv"]) for o in puts if 0.03 < abs(o["delta"]) < 0.6], tgt)
    call_iv = interp([(o["delta"], o["iv"]) for o in calls if 0.03 < o["delta"] < 0.6], tgt)
    atm_p = interp([(o["k"], o["iv"]) for o in puts], spot)
    atm_c = interp([(o["k"], o["iv"]) for o in calls], spot)
    atm = statistics.mean([v for v in (atm_p, atm_c) if v]) if (atm_p or atm_c) else None
    if not (put_iv and call_iv and atm):
        res["why"] = "target delta or ATM strike not quoted"
        return res

    band = lambda side: [o for o in side if 0.05 <= abs(o["delta"]) <= 0.60]
    pb, cb = band(puts), band(calls)
    oi = sum(o["open_interest"] for o in by_exp[exp])
    q = cfg["quality"]
    near = lambda side: sorted(side, key=lambda o: abs(abs(o["delta"]) - tgt))[:2]
    worst_spread = statistics.median([spread_pct(o) for o in near(puts) + near(calls)] or [999])  # typical leg, not the single worst
    thin = []
    if min(len(pb), len(cb)) < q["min_strikes_per_side"]:
        thin.append(f"only {min(len(pb), len(cb))} quoted strikes per side")
    if oi < q["min_expiry_open_interest"]:
        thin.append(f"open interest {int(oi)}")
    if worst_spread > q["max_leg_spread_pct"]:
        thin.append(f"bid/ask {worst_spread:.0f}% wide")

    put_oi, call_oi = sum(o["open_interest"] for o in pb), sum(o["open_interest"] for o in cb)
    skew = (put_iv - call_iv) / atm
    res.update(
        atm=round(atm * 100, 2), piv=round(put_iv * 100, 2), civ=round(call_iv * 100, 2),
        skew=round(skew, 4), vp=round((put_iv - call_iv) * 100, 2),
        pc=round(put_oi / call_oi, 2) if call_oi else None, oi=int(oi), thin=thin,
    )
    if abs(skew) > cfg["sanity_ceiling_abs_skew"]:
        res["why"] = f"skew {skew:+.2f} beyond sanity ceiling - assumed bad quote"
        return res
    res["ok"] = True
    return res


# ---------- prices ----------

def fetch_prices(symbols: list[str]) -> dict[str, dict]:
    import yfinance as yf

    ymap = {s: s.replace(".", "-") for s in symbols}
    df = yf.download(list(ymap.values()), period="4mo", interval="1d", auto_adjust=True,
                     progress=False, group_by="ticker", threads=True)
    out = {}
    for s, y in ymap.items():
        try:
            sub = df[y].dropna(subset=["Close"])
            c, v = sub["Close"].tolist(), sub["Volume"].tolist()
            if len(c) < 45:
                continue
            ret = lambda n: round((c[-1] / c[-1 - n] - 1) * 100, 2)
            dv = [a * b for a, b in zip(c, v)]
            avg_v = statistics.mean(v[-21:-1])
            out[s] = {
                "r1d": ret(1), "r1w": ret(5), "r1m": ret(21),
                "rvol": round(v[-1] / avg_v, 2) if avg_v else None,
                "dv": round(statistics.mean(dv[-21:]) / 1e6, 1),        # $M, 21-day average
                "dv_prev": round(statistics.mean(dv[-42:-21]) / 1e6, 1),
                "pdate": sub.index[-1].date().isoformat(),
            }
        except Exception:
            continue
    return out


def fetch_earnings(symbol: str) -> str | None:
    import yfinance as yf
    try:
        cal = yf.Ticker(symbol.replace(".", "-")).calendar
        dates = [x for x in (cal or {}).get("Earnings Date", []) if x >= dt.date.today()]
        return min(dates).isoformat() if dates else None
    except Exception:
        return None


# ---------- assembly ----------

def quadrant(skew: float, ret: float) -> str:
    if skew < 0:
        return "contrarian" if ret < 0 else "chase"
    return "hedged" if ret >= 0 else "fear"


def load_prior(date: str, lookback: int) -> tuple[str | None, dict]:
    """Most recent snapshot at least `lookback` calendar days older than `date`."""
    cutoff = (dt.date.fromisoformat(date) - dt.timedelta(days=lookback)).isoformat()
    files = sorted(p for p in HIST.glob("*.json") if p.stem <= cutoff)
    if not files:
        return None, {}
    return files[-1].stem, json.loads(files[-1].read_text())


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--quick", action="store_true", help="watchlist + indices only")
    args = ap.parse_args()
    cfg = json.loads((ROOT / "config.json").read_text())

    sector_of: dict[str, str] = {}
    for sec, names in cfg["benchmark"].items():
        for n in names:
            sector_of[n] = sec
    bench = set(sector_of)
    watch = cfg["watchlist"]
    for w in watch:
        sector_of.setdefault(w, cfg["watchlist_sectors"].get(w, "Other"))
    indices = cfg["indices"]
    universe = (watch if args.quick else sorted(set(watch) | bench)) + indices

    print(f"Fetching {len(universe)} option chains from CBOE...", flush=True)
    t0 = time.time()

    def one(sym: str) -> dict:
        raw = fetch_chain(sym)
        if not raw:
            return {"t": sym, "ok": False, "why": "chain unavailable"}
        try:
            return analyse_chain(sym, raw, cfg)
        except Exception as e:  # one bad chain must not kill the run
            return {"t": sym, "ok": False, "why": f"parse error: {e}"}

    with ThreadPoolExecutor(3) as ex:
        chains = list(ex.map(one, universe))
    missing = [i for i, c in enumerate(chains) if c.get("why") == "chain unavailable"]
    if missing:  # second, sequential pass - a burst of failures is usually a temporary block
        print(f"  retrying {len(missing)} unavailable chains...", flush=True)
        time.sleep(20)
        for i in missing:
            chains[i] = one(universe[i])
    print(f"  done in {time.time() - t0:.0f}s. Fetching prices...", flush=True)
    prices = fetch_prices(universe)
    with ThreadPoolExecutor(6) as ex:
        earn = dict(zip(universe, ex.map(fetch_earnings, universe)))

    asofs = [c["asof"] for c in chains if c.get("asof")]
    asof = max(asofs) if asofs else dt.datetime.now().isoformat(sep=" ", timespec="seconds")
    date = asof[:10]
    prior_date, prior = load_prior(date, cfg["change_lookback_days"])

    rows, excluded, idx = [], [], []
    for c in chains:
        s = c["t"]
        p = prices.get(s)
        if not c["ok"] or not p:
            if s not in indices:
                excluded.append({"t": s, "sector": sector_of.get(s, "-"), "why": c.get("why") or "no price history"})
            continue
        row = {**c, **p, "sector": sector_of.get(s, "Index"),
               "watch": s in watch, "bench": s in bench,
               "vs_spy": None, "earn": earn.get(s),
               "earn_in": bool(earn.get(s) and earn[s] <= c["exp"]),
               "d_skew": round(c["skew"] - prior[s], 4) if s in prior else None}
        for k in ("ok", "asof", "why"):
            row.pop(k, None)
        (idx if s in indices else rows).append(row)

    spy = next((r for r in idx if r["t"] == "SPY"), None)
    for r in rows + idx:
        if spy:
            r["vs_spy"] = round(r["r1m"] - spy["r1m"], 2)
        r["quad"] = quadrant(r["skew"], r["r1m"])

    # rank inside own sector (benchmark names + any watchlist names mapped there); thin chains excluded
    sectors = []
    for sec in sorted({r["sector"] for r in rows}):
        grp = [r for r in rows if r["sector"] == sec and not r["thin"]]
        for r in grp:
            others = [o["skew"] for o in grp if o is not r]
            r["rank"] = round(100 * sum(o < r["skew"] for o in others) / len(others)) if others else None
        b = [r for r in grp if r["bench"]]
        if not b:
            continue
        puts_bid = sum(r["skew"] > 0 for r in b) / len(b)
        dv, dvp = sum(r["dv"] for r in b), sum(r["dv_prev"] for r in b)
        sectors.append({
            "sector": sec, "n": len(b),
            "vp": round(statistics.mean(r["vp"] for r in b), 2),
            "skew": round(statistics.mean(r["skew"] for r in b), 4),
            "agree": round(max(puts_bid, 1 - puts_bid), 2),
            "lean": "puts" if puts_bid >= 0.5 else "calls",
            "r1m": round(statistics.mean(r["r1m"] for r in b), 2),
            "up_share": round(sum(r["r1m"] > 0 for r in b) / len(b), 2),
            "dv": round(dv, 1), "dv_prev": round(dvp, 1),
        })
    tot, totp = sum(s["dv"] for s in sectors) or 1, sum(s["dv_prev"] for s in sectors) or 1
    for s in sectors:
        s["share"] = round(100 * s["dv"] / tot, 2)
        s["share_chg"] = round(100 * (s["dv"] / tot - s["dv_prev"] / totp), 2)
        s["trusted"] = s["n"] >= cfg["min_names_per_sector"] and s["agree"] >= cfg["agreement_threshold"]

    if len(rows) < 0.5 * (len(universe) - len(indices)):
        # A mostly-failed fetch must not overwrite a good board or bank a junk snapshot.
        print(f"ABORT: only {len(rows)} of {len(universe) - len(indices)} names covered - keeping previous data.")
        return 1

    payload = {
        "asof": asof, "date": date, "generated": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
        "prior_date": prior_date, "snapshots": len(list(HIST.glob("*.json"))) + (0 if (HIST / f"{date}.json").exists() else 1),
        "settings": {k: v for k, v in cfg.items() if not k.startswith("_") and k not in ("benchmark", "watchlist_sectors")},
        "rows": rows, "indices": idx, "sectors": sectors, "excluded": excluded,
    }
    HIST.mkdir(parents=True, exist_ok=True)
    (HIST / f"{date}.json").write_text(json.dumps({r["t"]: r["skew"] for r in rows + idx}))
    (OUT / "latest.js").write_text("window.SKEW_DATA = " + json.dumps(payload, separators=(",", ":")) + ";\n")
    (OUT / "latest.json").write_text(json.dumps(payload, indent=1))
    print(f"OK {date}: {len(rows)} names, {len(idx)} indices, {len(excluded)} excluded "
          f"({sum(bool(r['thin']) for r in rows)} thin). Prior snapshot: {prior_date or 'none yet'}")
    return 0 if rows else 1


if __name__ == "__main__":
    sys.exit(main())
