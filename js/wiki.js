// Wikipedia client: input parsing, first-link extraction, and cached,
// rate-limited lookups. Nothing in this file touches the page's DOM.

export const PHILOSOPHY = 'Philosophy';

const API = 'https://en.wikipedia.org/w/api.php';
const CACHE_KEY = 'first-link-cache-v1';
const CACHE_TTL_MS = 3 * 24 * 60 * 60 * 1000;
const CACHE_MAX = 3000;

// Namespaces and shortcuts that are never articles.
const NON_ARTICLE = /^(file|image|media|special|help|wikipedia|wp|talk|category|portal|template|user|draft|module|mos|h|book|timedtext|mediawiki|wikt|wiktionary|[a-z]+ talk):/i;

// Parts of an article that are not running text.
const JUNK = [
  'table', 'figure', 'style', 'script', 'sup',
  '.hatnote', '[role="note"]', '[role="navigation"]',
  '.infobox', '.sidebar', '.navbox', '.thumb', '.gallery',
  '.reflist', '.references', '.mw-references-wrap', '.mw-editsection',
  '.shortdescription', '.ambox', '.metadata', '.side-box', '.sistersitebox',
  '.noprint', '.toc', '#toc', '.mw-empty-elt', '#coordinates',
  '.portalbox', '.portal-bar',
].join(',');

export class WikiError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'WikiError';
    this.code = code;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function safeDecode(text) {
  try { return decodeURIComponent(text); } catch { return text; }
}

// "Foo_bar#Section" -> "Foo bar"
export function normalizeTitle(raw) {
  let title = String(raw ?? '').replace(/_/g, ' ');
  const hash = title.indexOf('#');
  if (hash !== -1) title = title.slice(0, hash);
  return title.replace(/\s+/g, ' ').trim();
}

// Wikipedia ignores the case of the first letter, so the cache does too.
export function titleKey(raw) {
  const title = normalizeTitle(raw);
  return title.charAt(0).toUpperCase() + title.slice(1);
}

export function articleUrl(title) {
  return 'https://en.wikipedia.org/wiki/' + encodeURIComponent(String(title).replace(/ /g, '_'));
}

// Turns whatever the visitor typed into a clean article title, or an error
// message that is safe to show.
export function parseInput(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return { error: 'Type an article title or paste a Wikipedia link.' };
  if (text.length > 500) return { error: 'That is too long to be an article title.' };

  let title = text;
  const hasScheme = /^https?:\/\//i.test(text);
  const wikiLink = /^(https?:\/\/)?([a-z0-9-]+\.)+wikipedia\.org(\/|$)/i.test(text);

  if (wikiLink) {
    let url;
    try { url = new URL(hasScheme ? text : 'https://' + text); }
    catch { return { error: 'That link could not be read.' }; }
    if (!/^en(\.m)?\.wikipedia\.org$/i.test(url.hostname)) {
      return { error: 'Only English Wikipedia links work here.' };
    }
    const path = url.pathname.match(/^\/wiki\/(.+)$/);
    if (path) title = safeDecode(path[1]);
    else if (url.searchParams.get('title')) title = url.searchParams.get('title');
    else return { error: 'That link does not point at an article.' };
  } else if (hasScheme) {
    return { error: 'Only English Wikipedia links work here.' };
  }

  title = normalizeTitle(title);
  if (!title) return { error: 'Type an article title or paste a Wikipedia link.' };
  if (/[<>\[\]{}|]/.test(title)) return { error: 'Article titles cannot contain < > [ ] { } or |.' };
  if (title.length > 255) return { error: 'That is too long to be an article title.' };
  if (NON_ARTICLE.test(title)) return { error: 'That page is not an article.' };
  return { title };
}

// Parses article HTML into an inert document and strips everything that is
// not running text. DOMParser documents never run scripts or load images.
export function parseArticle(html) {
  // Wikipedia's HTML carries inline styles. They are useless here, and the
  // page's Content Security Policy would log every one as a blocked style,
  // so they are dropped before parsing.
  const plain = String(html)
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<[a-zA-Z][^>]*>/g, (tag) => tag.replace(/\sstyle\s*=\s*("[^"]*"|'[^']*')/gi, ''));
  const doc = new DOMParser().parseFromString(plain, 'text/html');
  const root = doc.querySelector('.mw-parser-output') || doc.body;
  root.querySelectorAll(JUNK).forEach((el) => el.remove());
  return root;
}

function linkTarget(anchor, selfKey) {
  const href = anchor.getAttribute('href') || '';
  if (!href.startsWith('/wiki/')) return null;
  const cls = anchor.classList;
  if (cls.contains('new') || cls.contains('external') || cls.contains('extiw') ||
      cls.contains('mw-selflink') || cls.contains('mw-file-description') || cls.contains('image')) {
    return null;
  }
  const title = normalizeTitle(safeDecode(href.slice(6).split('#')[0]));
  if (!title || NON_ARTICLE.test(title)) return null;
  if (titleKey(title) === selfKey) return null;
  return title;
}

// Walks one paragraph or list item in reading order and returns the first
// link that is outside parentheses and outside italics.
function scanBlock(block, selfKey) {
  let depth = 0;
  const count = (text) => {
    for (const ch of text) {
      if (ch === '(' || ch === '（') depth++;
      else if ((ch === ')' || ch === '）') && depth > 0) depth--;
    }
  };
  const walk = (node, italic) => {
    for (const child of node.childNodes) {
      if (child.nodeType === 3) { count(child.nodeValue); continue; }
      if (child.nodeType !== 1) continue;
      const tag = child.tagName;
      if (tag === 'A') {
        if (depth === 0 && !italic) {
          const target = linkTarget(child, selfKey);
          if (target) return target;
        }
        count(child.textContent);
        continue;
      }
      const hit = walk(child, italic || tag === 'I' || tag === 'EM');
      if (hit) return hit;
    }
    return null;
  };
  return walk(block, false);
}

// The rule of the game: first link in the running text that is not in
// parentheses, not in italics, and not a link to the page itself. Paragraphs
// and list items are read in page order, so a disambiguation page (which is
// only a list) still yields its first entry.
export function findFirstLink(root, currentTitle) {
  const selfKey = titleKey(currentTitle);
  for (const block of root.querySelectorAll('p, li')) {
    const next = scanBlock(block, selfKey);
    if (next) return { next, viaList: block.tagName === 'LI' || block.closest('li') !== null };
  }
  return null;
}

function browserStorage() {
  return {
    read() {
      try { return JSON.parse(localStorage.getItem(CACHE_KEY) || '{}') || {}; } catch { return {}; }
    },
    write(value) {
      try { localStorage.setItem(CACHE_KEY, JSON.stringify(value)); } catch { /* full or blocked: run without it */ }
    },
  };
}

export function memoryStorage() {
  let value = {};
  return { read: () => value, write: (v) => { value = JSON.parse(JSON.stringify(v)); } };
}

export function createWiki({
  fetchImpl = (url, init) => fetch(url, init),
  storage = browserStorage(),
  minGapMs = 120,
  retryBaseMs = 1000,
  maxTries = 4,
} = {}) {
  const stats = { requests: 0, cacheHits: 0, retries: 0, chars: 0 };
  const memo = new Map();      // title key -> { title, next, viaList, kind, at }
  const inflight = new Map();  // title key -> Promise
  let queue = Promise.resolve();
  let lastDone = 0;
  let saveTimer = null;

  // Load what earlier visits already worked out.
  const stored = storage.read();
  if (stored && typeof stored === 'object') {
    const cutoff = Date.now() - CACHE_TTL_MS;
    for (const [key, row] of Object.entries(stored)) {
      if (!Array.isArray(row) || typeof row[0] !== 'string' || !(row[3] > cutoff)) continue;
      memo.set(key, {
        title: row[0],
        next: typeof row[1] === 'string' ? row[1] : null,
        viaList: row[2] === 1,
        kind: 'article',
        at: row[3],
      });
    }
  }

  function save() {
    saveTimer = null;
    let rows = [...memo.entries()].filter(([, info]) => info.kind === 'article');
    if (rows.length > CACHE_MAX) {
      rows = rows.sort((a, b) => b[1].at - a[1].at).slice(0, CACHE_MAX);
    }
    const out = {};
    for (const [key, info] of rows) out[key] = [info.title, info.next, info.viaList ? 1 : 0, info.at];
    storage.write(out);
  }

  function remember(key, info) {
    const row = { ...info, at: Date.now() };
    memo.set(key, row);
    if (info.kind === 'article') {
      memo.set(titleKey(info.title), row);
      if (saveTimer === null) saveTimer = setTimeout(save, 800);
    }
  }

  // One request at a time, with a small gap, so a busy map never floods
  // Wikipedia no matter how many paths are running.
  function enqueue(task) {
    const run = queue.then(async () => {
      const wait = lastDone + minGapMs - Date.now();
      if (wait > 0) await sleep(wait);
      try { return await task(); } finally { lastDone = Date.now(); }
    });
    queue = run.catch(() => {});
    return run;
  }

  async function request(params) {
    const query = new URLSearchParams({ format: 'json', formatversion: '2', origin: '*', ...params });
    const url = API + '?' + query.toString();
    let delay = retryBaseMs;
    for (let attempt = 1; ; attempt++) {
      let res;
      stats.requests++;
      try {
        res = await fetchImpl(url);
      } catch {
        if (attempt >= maxTries) throw new WikiError('network', 'Could not reach Wikipedia. Check your connection and retry.');
        stats.retries++;
        await sleep(delay);
        delay = Math.min(delay * 2, 8000);
        continue;
      }
      if (res.status === 429 || res.status >= 500) {
        if (attempt >= maxTries) throw new WikiError('busy', `Wikipedia is busy right now (HTTP ${res.status}). Retry in a minute.`);
        const retryAfter = Number(res.headers.get('Retry-After'));
        const wait = Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter * 1000, 15000) : delay;
        stats.retries++;
        await sleep(wait);
        delay = Math.min(delay * 2, 8000);
        continue;
      }
      if (!res.ok) throw new WikiError('http', `Wikipedia answered with HTTP ${res.status}.`);
      const text = await res.text();
      stats.chars += text.length;
      try { return JSON.parse(text); }
      catch { throw new WikiError('format', 'Wikipedia sent an answer that could not be read.'); }
    }
  }

  async function fetchInfo(title) {
    const base = {
      action: 'parse', page: title, prop: 'text', redirects: '1',
      disableeditsection: '1', disablelimitreport: '1', disabletoc: '1',
    };
    // The lead section alone is about a tenth of the page and nearly always
    // holds the first link.
    let data = await request({ ...base, section: '0' });
    if (data.error) return failed(title, data.error);
    const resolved = normalizeTitle(data.parse.title);
    let found = findFirstLink(parseArticle(data.parse.text), resolved);
    if (!found) {
      data = await request(base);
      if (data.error) return failed(title, data.error);
      found = findFirstLink(parseArticle(data.parse.text), resolved);
    }
    return { title: resolved, next: found ? found.next : null, viaList: found ? found.viaList : false, kind: 'article' };
  }

  function failed(title, error) {
    if (error.code === 'missingtitle') return { title, next: null, viaList: false, kind: 'missing' };
    if (error.code === 'invalidtitle') return { title, next: null, viaList: false, kind: 'invalid' };
    throw new WikiError('api', 'Wikipedia could not open that page.');
  }

  // Resolves a title to { title, next, viaList, kind, cached }. Identical
  // lookups share one request, and answers are kept for later paths.
  function lookup(rawTitle) {
    const key = titleKey(rawTitle);
    const known = memo.get(key);
    if (known) {
      stats.cacheHits++;
      return Promise.resolve({ title: known.title, next: known.next, viaList: known.viaList, kind: known.kind, cached: true });
    }
    let pending = inflight.get(key);
    if (!pending) {
      pending = enqueue(() => fetchInfo(normalizeTitle(rawTitle))).then(
        (info) => { inflight.delete(key); remember(key, info); return info; },
        (err) => { inflight.delete(key); throw err; },
      );
      inflight.set(key, pending);
    }
    return pending.then((info) => ({ ...info, cached: false }));
  }

  async function randomTitles(count = 8) {
    const data = await enqueue(() => request({ action: 'query', list: 'random', rnnamespace: '0', rnlimit: String(count) }));
    const rows = data && data.query && Array.isArray(data.query.random) ? data.query.random : [];
    return rows.map((row) => normalizeTitle(row.title)).filter(Boolean);
  }

  return { lookup, randomTitles, stats, flush: save };
}
