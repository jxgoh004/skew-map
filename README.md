# Skew Map

A daily map of what options traders are paying for (25-delta put IV vs call IV) crossed with what each
stock actually did, sorted into four verdicts: contrarian bid, chase, hedged rally, fear.
Educational research tool — it shows where to look, never what to buy or when.

## Run it

```bash
pip install -r requirements.txt
```

```bash
python build_data.py
```

Then open `site/index.html` (double-click works; no server needed).
`python build_data.py --quick` refreshes only the watchlist and index ETFs.

Run it once per trading day after the US close. Each run banks a snapshot in `site/data/history/`;
the Δ skew column fills in once a snapshot at least five days old exists.

## Make it yours

Everything tunable lives in `config.json`: the watchlist, the neutral sector benchmark, and the seven
decisions (delta, expiry rule, quality bar, sanity ceiling, agreement threshold, volume cutoffs).
Change them deliberately and rarely — moving a dial makes older snapshots incomparable.

## Cost

Zero. Options data comes from Cboe's delayed quote feed (per-contract IV and delta, ~15 minutes
delayed); prices, volume and earnings dates come from Yahoo Finance via `yfinance`. Both are free but
unofficial: no uptime guarantee, and intended for personal use. The site is static files.

`.github/workflows/daily.yml` is an optional free automation: push this folder to a GitHub repo, enable
Pages (Settings → Pages → Source: GitHub Actions), and it rebuilds and publishes every weekday.
