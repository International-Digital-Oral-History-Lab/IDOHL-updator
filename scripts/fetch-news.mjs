// fetch-news.mjs — IDOHL Update page news aggregator
//
// Pulls the latest N items from each partner institution and writes a
// normalised JSON cache that the static Update page reads at runtime.
//
//   Sources:
//     - TU Darmstadt HDSM blog (RSS 2.0, hypotheses.org)
//     - UCL Information Studies news listing (HTML, parsed via cheerio)
//
//   Failure handling:
//     - Atomic write (tmp + rename) so the page never reads a half-written file
//     - On a single source's failure, keeps the prior items for that source and
//       flags fetchOk=false; the other source is unaffected
//
//   Run:
//     - In CI (default): .github/workflows/fetch-news.yml, Mon & Thu 06:15 UTC + manual
//     - Locally:        cd scripts && npm install && node fetch-news.mjs

import { writeFile, readFile, mkdir, rename } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as cheerio from 'cheerio';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const OUTPUT_PATH = resolve(REPO_ROOT, 'landing_page/data/news-cache.json');

const ITEMS_PER_FEED = 6;
const HTTP_TIMEOUT_MS = 15000;

const UCL_URL = 'https://www.ucl.ac.uk/arts-humanities/information-studies/news';
const TUD_URL = 'https://hdsm.hypotheses.org/category/digital_oral_history_lab/feed/';
const TUD_VIEW_ALL_URL = 'https://hdsm.hypotheses.org/category/digital_oral_history_lab';

// hypotheses.org is behind Anubis bot protection but whitelists feed-reader UAs.
// Feedly's UA passes the challenge; a generic browser UA does not.
const TUD_UA = 'Feedly/1.0 (+http://www.feedly.com/fetcher.html; like FeedFetcher-Google)';
const UCL_UA = 'IDOHL Update Aggregator (+https://idohl.org)';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function logErr(msg) {
    console.error(`[${new Date().toISOString()}] ${msg}`);
}

async function httpGet(url, userAgent) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), HTTP_TIMEOUT_MS);
    try {
        const res = await fetch(url, {
            signal: ctrl.signal,
            headers: {
                'User-Agent': userAgent,
                'Accept': 'application/rss+xml,application/xml,text/xml,text/html;q=0.9,*/*;q=0.8',
                'Accept-Language': 'en-GB,en;q=0.8',
            },
            redirect: 'follow',
        });
        if (!res.ok) {
            logErr(`GET ${url} -> HTTP ${res.status}`);
            return null;
        }
        return await res.text();
    } catch (err) {
        logErr(`GET ${url} failed: ${err.message}`);
        return null;
    } finally {
        clearTimeout(t);
    }
}

const NAMED_ENTITIES = {
    amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
    rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“',
    ndash: '–', mdash: '—', hellip: '…',
};

function decodeEntities(s) {
    return String(s ?? '')
        .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(parseInt(n, 10)))
        .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
        .replace(/&([a-zA-Z]+);/g, (m, name) => NAMED_ENTITIES[name] ?? m);
}

function cleanText(s) {
    return decodeEntities(String(s ?? '').replace(/<[^>]*>/g, ' '))
        .replace(/\s+/g, ' ')
        .trim();
}

function truncate(s, max = 180) {
    if (s.length <= max) return s;
    let cut = s.slice(0, max);
    const sp = cut.lastIndexOf(' ');
    if (sp > max * 0.6) cut = cut.slice(0, sp);
    return cut.replace(/[\s.,;:]+$/, '') + '…';
}

function isoDate(d) {
    return d.toISOString().slice(0, 10);
}

// Parse UK news dates ("22 Apr 2026", "22 April 2026") explicitly as UTC so
// .toISOString().slice(0,10) doesn't drop a day in non-UTC runners.
const UK_MONTHS = {
    jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
    jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};
function parseUKDate(s) {
    const m = String(s).trim().match(/^(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})$/);
    if (!m) return null;
    const month = UK_MONTHS[m[2].toLowerCase().slice(0, 3)];
    if (month === undefined) return null;
    return new Date(Date.UTC(parseInt(m[3], 10), month, parseInt(m[1], 10)));
}

// ---------------------------------------------------------------------------
// Source: TU Darmstadt HDSM (RSS 2.0)
// ---------------------------------------------------------------------------

async function fetchTUDarmstadt() {
    const body = await httpGet(TUD_URL, TUD_UA);
    if (!body) return { ok: false, items: [] };

    let $;
    try {
        $ = cheerio.load(body, { xmlMode: true });
    } catch (err) {
        logErr(`TU Darmstadt: failed to parse RSS — ${err.message}`);
        return { ok: false, items: [] };
    }

    const items = [];
    $('item').each((_, el) => {
        if (items.length >= ITEMS_PER_FEED) return false;
        const $el = $(el);
        const title = cleanText($el.find('title').first().text());
        const link = cleanText($el.find('link').first().text());
        const pubDate = $el.find('pubDate').first().text().trim();
        const desc = cleanText($el.find('description').first().text());

        if (!title || !link) return;

        const d = pubDate ? new Date(pubDate) : null;
        items.push({
            title,
            url: link,
            date: d && !isNaN(d) ? isoDate(d) : '',
            excerpt: truncate(desc),
        });
    });

    return { ok: items.length > 0, items };
}

// ---------------------------------------------------------------------------
// Source: UCL Information Studies news (HTML scrape)
// ---------------------------------------------------------------------------

async function fetchUCL() {
    const body = await httpGet(UCL_URL, UCL_UA);
    if (!body) return { ok: false, items: [] };

    const $ = cheerio.load(body);
    const items = [];

    $('.generic-feed-listing-item').each((_, el) => {
        if (items.length >= ITEMS_PER_FEED) return false;
        const $el = $(el);

        const $a = $el.find('a.generic-feed-listing-item__link--heading-link').first();
        const title = cleanText($a.text());
        let url = ($a.attr('href') || '').trim();
        if (!title || !url) return;
        if (url.startsWith('/')) url = 'https://www.ucl.ac.uk' + url;

        const excerpt = cleanText(
            $el.find('.generic-feed-listing-item__paragraph')
                .not('.generic-feed-listing-item__paragraph--date')
                .first()
                .text()
        );
        const dateRaw = cleanText(
            $el.find('.generic-feed-listing-item__paragraph--date').first().text()
        );
        const d = parseUKDate(dateRaw);

        items.push({
            title,
            url,
            date: d ? isoDate(d) : '',
            excerpt: truncate(excerpt),
        });
    });

    if (items.length === 0) {
        logErr('UCL: no .generic-feed-listing-item nodes — selector may be stale');
    }

    return { ok: items.length > 0, items };
}

// ---------------------------------------------------------------------------
// Cache merge: keep last-good items if a source fails this run
// ---------------------------------------------------------------------------

async function loadPriorCache(path) {
    try {
        const raw = await readFile(path, 'utf8');
        return JSON.parse(raw);
    } catch {
        return null;
    }
}

function mergeWithPrior(fresh, prior, key) {
    if (!fresh.ok && prior?.sources?.[key]?.items?.length) {
        return {
            fetchOk: false,
            staleSince: prior.sources[key].lastFetchedAt ?? null,
            items: prior.sources[key].items,
        };
    }
    return {
        fetchOk: fresh.ok,
        lastFetchedAt: new Date().toISOString(),
        items: fresh.items,
    };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
    await mkdir(dirname(OUTPUT_PATH), { recursive: true });

    const prior = await loadPriorCache(OUTPUT_PATH);
    const [tud, ucl] = await Promise.all([fetchTUDarmstadt(), fetchUCL()]);

    const payload = {
        lastFetchedAt: new Date().toISOString(),
        itemsPerFeed: ITEMS_PER_FEED,
        sources: {
            ucl: {
                label: 'UCL Information Studies',
                url: UCL_URL,
                ...mergeWithPrior(ucl, prior, 'ucl'),
            },
            tudarmstadt: {
                label: 'TU Darmstadt — HDSM',
                url: TUD_VIEW_ALL_URL,
                ...mergeWithPrior(tud, prior, 'tudarmstadt'),
            },
        },
    };

    const json = JSON.stringify(payload, null, 2) + '\n';
    const tmpPath = OUTPUT_PATH + '.tmp';
    await writeFile(tmpPath, json, 'utf8');
    await rename(tmpPath, OUTPUT_PATH);

    const uclCount = payload.sources.ucl.items.length;
    const tudCount = payload.sources.tudarmstadt.items.length;
    console.log(
        `[${new Date().toISOString()}] wrote ${OUTPUT_PATH} — UCL:${uclCount} TUD:${tudCount}`
    );

    if (!ucl.ok && !tud.ok && uclCount === 0 && tudCount === 0) {
        logErr('both sources failed and no prior cache — JSON is empty');
        process.exit(2);
    }
}

main().catch((err) => {
    logErr(`fatal: ${err.message}`);
    process.exit(1);
});
