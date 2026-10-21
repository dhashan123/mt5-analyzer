# MT5 Backtest Report Analyzer

**Drop a MetaTrader 5 Strategy Tester HTML report on the page and get the
numbers that actually matter — in about a second, in your browser.**

Live: <https://mt5-analyzer.dhashan.workers.dev> ·
mirror: <https://dhashan123.github.io/mt5-analyzer/>

The file is parsed **locally in JavaScript**. It is never uploaded. There is
no account, no signup, no upload button, and no server round trip for the
analysis.

---

## What you get

A Strategy Tester report is a page of numbers. The ones that decide whether
a strategy is worth trading are the ones MT5 does not print, and this page
computes all of them from the report's own deal table:

- **the equity curve**, rebuilt from the deals — so drawdown is measured,
  not quoted
- **the worst losing streak**, and how much money it cost
- **the break-even win rate** implied by your average win and average loss,
  next to your actual win rate
- **profit by day of week** and **by hour of day** — this is where a session
  edge shows itself, and where a hidden concentration shows up
- **the result with costs doubled and tripled** — a strategy that only works
  at today's commission and swap is not a strategy
- **trades per month** over the actual sample length, so a system that needs
  a decade to prove itself is visible as such
- a plain reading of the whole thing, in words, with the thresholds stated

Every number that is missing from the report is shown as missing. Nothing is
guessed, and no metric is ever reported as zero when it is absent.

---

## Why a single report is not enough

One run on one symbol over one date range cannot tell you whether the
parameters fitted the sample. Two things can:

- a **parameter sweep** ranked by a *declared* objective, with every run
  pinned to one configuration so the comparison is real
- a **walk-forward validation** — parameters chosen on one window, run on the
  next, unseen one, with the efficiency number reported

Both are available as a service, and both will happily tell you the answer
is "no". That is the point of paying for measurement rather than another
screenshot.

---

## How to get your report

In MetaTrader 5: open the Strategy Tester, set it up, press **Run**, then
right-click the **Results** grid → **Report** → **HTML**. The terminal writes
it to its data folder as `<name>.htm`.

Already have one? Drop it on the page.

---

## For developers

The parser and the metrics are a faithful port of the Python implementation
in the private `mt5batch` project, and the two are checked against each other, so
this page and the paid reports can never quietly disagree.

The page is a static site plus one Worker:

| | |
|---|---|
| `public/` | the analyzer, the order page, `robots.txt`, `sitemap.xml` |
| `worker.js` | the Worker: serves the site, takes orders into KV, delivers reports |
| `wrangler.toml` | the Worker config and the KV binding |
| `build.py` | injects the public payment addresses into `public/config.js` |
| `scripts/cleanroom_guard.py` | fails CI if anything private is published |

Deploy it with the free Cloudflare plan:

```bash
export CLOUDFLARE_API_TOKEN=...
npx wrangler kv namespace create ORDERS     # put the id in wrangler.toml
echo "<a-long-random-string>" | npx wrangler secret put ORDER_TOKEN
python build.py --wallet /path/to/wallet.json
npx wrangler deploy
```

## Licence

MIT. See `LICENSE`.
