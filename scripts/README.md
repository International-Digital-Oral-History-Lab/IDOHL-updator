# IDOHL Update Page — News Aggregator

GitHub Actions workflow that pulls the latest 6 items from each partner
institution twice a week (Mon & Thu) and commits a JSON cache the static
`Update.html` page reads at runtime.

## How it works

```
┌──────────────────────────────────────────────────┐
│ GitHub Actions (.github/workflows/fetch-news.yml)│
│  schedule: 15 6 * * 1,4  (06:15 UTC Mon & Thu)   │
│  workflow_dispatch:      (manual button)         │
│   └─ node scripts/fetch-news.mjs                 │
│       ├─ Pull TU Darmstadt RSS                   │
│       ├─ Scrape UCL HTML (cheerio)               │
│       └─ Atomic write landing_page/data/         │
│              news-cache.json                     │
│   └─ Commit + push if changed                    │
└──────────────────────────────────────────────────┘
                  │
                  ▼
┌──────────────────────────────────────────────────┐
│ raw.githubusercontent.com/                       │
│   International-Digital-Oral-History-Lab/        │
│     IDOHL-site/main/                             │
│       landing_page/data/news-cache.json          │
│                                                  │
│   (CORS allowed; ~5 min CDN cache)               │
└──────────────────────────────────────────────────┘
                  │
                  ▼
┌──────────────────────────────────────────────────┐
│ Update.html — fetches the JSON, renders 2 cols   │
└──────────────────────────────────────────────────┘
```

| Source | Method |
|---|---|
| TU Darmstadt — HDSM | RSS 2.0 (`hdsm.hypotheses.org/.../feed/`) — Anubis bot challenge bypassed via Feedly UA |
| UCL Information Studies | HTML scrape (cheerio) — selector `.generic-feed-listing-item` |

## Initial setup (one-time)

The repo is already public — `raw.githubusercontent.com` can be read anonymously.

1. **Push these files to `main`** (workflow + script + Update.html). See
   "Pushing the change" below.
2. **Enable workflow permissions** (already declared in the YAML, but verify):
   `Settings` → `Actions` → `General` → *Workflow permissions* → set to
   **Read and write permissions**, save.
3. **Trigger the first run manually** to seed the JSON:
   `Actions` tab → *Refresh news cache* → *Run workflow* → *Run*.
   Wait ~30s; the run should be green and produce a new commit
   `chore(news): refresh cache <timestamp>` on `main`.
4. **Verify the JSON is reachable**:
   ```
   https://raw.githubusercontent.com/International-Digital-Oral-History-Lab/IDOHL-site/main/landing_page/data/news-cache.json
   ```
   Should return JSON with `itemsPerFeed: 6` and 6 items per source.
5. **Upload `Update.html` as an Omeka-S page** and add it to navigation
   (admin UI — not automatable from this repo).

After step 3, the workflow runs every Monday and Thursday on its own. No further action.

## Local dev

```bash
cd scripts
npm install
node fetch-news.mjs
# writes ../landing_page/data/news-cache.json
```

Requires Node ≥ 20.

## Failure handling (built into the script)

| Scenario | Behaviour |
|---|---|
| One source fails (network, bot challenge changes, selector breaks) | Keeps prior items for that source from the existing cache; flags `fetchOk: false` and `staleSince`. The page renders an amber "showing cached items from …" banner. |
| Both sources fail and no prior cache exists | Script exits with code 2 and writes nothing. Page falls back to two CTA cards linking out to UCL / TUD. |
| Atomic write | Output goes to `news-cache.json.tmp` first, then `rename()`. Readers never see a half-written file. |

The Action commits only when the file actually changed, so a no-op run leaves
git history clean.

## When the upstream HTML changes

- **UCL**: The scraper depends on `.generic-feed-listing-item`. If UCL
  redesigns the page, watch for the log line `UCL: no
  .generic-feed-listing-item nodes — selector may be stale` in the workflow
  output. Re-survey:
  ```bash
  curl -s -A "Mozilla/5.0" https://www.ucl.ac.uk/arts-humanities/information-studies/news \
    | grep -oE 'class="[^"]*listing[^"]*"' | sort -u
  ```
  Update the selectors in `fetchUCL()` inside `fetch-news.mjs`.

- **hypotheses.org Anubis policy**: If the Feedly UA stops passing the bot
  check, the response body will contain `Making sure you're not a bot`. Try
  another known feed-reader UA (`Inoreader/`, `NewsBlur/`, `FeedFetcher-Google`)
  by editing `TUD_UA` in `fetch-news.mjs`.

## Pushing the change

```bash
git add .github scripts landing_page/Update.html landing_page/data
git commit -m "feat(update): add Update page with daily news aggregator"
git push
```
