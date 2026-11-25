// In-browser checks. Open tests.html through a local server. The first
// groups run offline against fixtures and fakes; the last group calls
// Wikipedia for real.

import { parseInput, parseArticle, findFirstLink, createWiki, memoryStorage } from './wiki.js';
import { createStore, titlesFromHash, hashFromTitles, loopLabel, MAX_HOPS } from './chains.js';
import { createGraph } from './graph.js';
import { createSidebar } from './sidebar.js';

const listEl = document.getElementById('results');
const summaryEl = document.getElementById('summary');
const uncaught = [];
let passed = 0;
let failed = 0;

window.addEventListener('error', (event) => uncaught.push('error: ' + event.message));
window.addEventListener('unhandledrejection', (event) => {
  uncaught.push('unhandledrejection: ' + (event.reason && event.reason.message ? event.reason.message : String(event.reason)));
});

// Anything the Content Security Policy blocks is counted, with where it came from.
const blocked = [];
document.addEventListener('securitypolicyviolation', (event) => {
  blocked.push(`${event.violatedDirective} ${event.blockedURI} at ${String(event.sourceFile).split('/').pop()}:${event.lineNumber}`);
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const withTimeout = (promise, ms) => Promise.race([
  promise,
  sleep(ms).then(() => { throw new Error(`timed out after ${ms} ms`); }),
]);

function check(name, ok, detail = '') {
  if (ok) passed++; else failed++;
  const item = document.createElement('li');
  item.className = ok ? 'pass' : 'fail';
  item.textContent = `${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : '  [' + detail + ']'}`;
  listEl.append(item);
}

function same(name, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  check(name, a === e, `got ${a}, wanted ${e}`);
}

function heading(text) {
  const item = document.createElement('li');
  item.className = 'group';
  item.textContent = text;
  listEl.append(item);
}

async function group(name, fn) {
  heading(name);
  try { await fn(); } catch (err) { check(`${name}: threw`, false, err && err.message ? err.message : String(err)); }
}

const article = (body) => `<div class="mw-parser-output">${body}</div>`;
const first = (body, title = 'Foo') => findFirstLink(parseArticle(article(body)), title);

// A stand-in for the Wikipedia client: a table of title -> next title.
function fakeWiki(table, delay = 0) {
  const calls = [];
  return {
    calls,
    stats: { requests: 0, cacheHits: 0 },
    async lookup(title) {
      calls.push(title);
      if (delay) await sleep(delay);
      if (typeof table === 'function') return table(title);
      if (!(title in table)) return { title, next: null, viaList: false, kind: 'missing', cached: false };
      return { title, next: table[title], viaList: false, kind: 'article', cached: false };
    },
  };
}

function parseReply(title, body) {
  return JSON.stringify({ parse: { title, pageid: 1, text: article(body) } });
}

function fakeFetch(replies) {
  const log = { urls: [], active: 0, maxActive: 0 };
  const impl = async (url) => {
    log.urls.push(url);
    log.active++;
    log.maxActive = Math.max(log.maxActive, log.active);
    await sleep(5);
    log.active--;
    const reply = typeof replies === 'function' ? replies(url, log.urls.length) : replies.shift();
    if (reply instanceof Error) throw reply;
    return new Response(reply.body ?? '', { status: reply.status ?? 200, headers: reply.headers ?? {} });
  };
  return { impl, log };
}

await group('Link rule', async () => {
  same('skips a link inside parentheses',
    first('<p><b>Foo</b> (from <a href="/wiki/Greek_language">Greek</a>) is a <a href="/wiki/Kind_of_thing">thing</a>.</p>')?.next, 'Kind of thing');
  same('skips a link in italics',
    first('<p><i><a href="/wiki/Latin">lorem</a></i> then <a href="/wiki/Real">real</a></p>')?.next, 'Real');
  same('skips Help and File pages, strips the #section',
    first('<p><a href="/wiki/Help:IPA/English">/x/</a> <a href="/wiki/File:X.png">f</a> <a href="/wiki/Target#Sec">t</a></p>')?.next, 'Target');
  same('skips links to the page itself',
    first('<p><a href="/wiki/Foo_bar">a</a> <a href="/wiki/foo_bar#x">b</a> <a href="/wiki/Other">c</a></p>', 'Foo bar')?.next, 'Other');
  same('ignores hatnotes and infobox tables',
    first('<div class="hatnote"><a href="/wiki/Hat">h</a></div><table class="infobox"><tr><td><p><a href="/wiki/Box">b</a></p></td></tr></table><p><a href="/wiki/Body">b</a></p>')?.next, 'Body');
  same('ignores red links and outside links',
    first('<p><a href="/w/index.php?title=Nope&amp;action=edit&amp;redlink=1" class="new">n</a> <a href="https://example.org" class="external">e</a> <a href="/wiki/Yes">y</a></p>')?.next, 'Yes');
  same('falls back to list entries on a disambiguation page',
    first('<p><b>Mercury</b> most commonly refers to:</p><ul><li><a href="/wiki/Mercury_(planet)">Mercury (planet)</a>, a planet</li></ul>', 'Mercury'),
    { next: 'Mercury (planet)', viaList: true });
  same('returns nothing when there is no usable link', first('<p>Plain text only.</p>'), null);
  same('reads past headings wrapped in a div',
    first('<p>No links here.</p><div class="mw-heading mw-heading2"><h2>History</h2></div><p><a href="/wiki/Later">l</a></p>')?.next, 'Later');
  const styled = parseArticle(article('<style>.x{color:red}</style><p style="color:red">A <span style=\'margin:0\'>b</span> <a href="/wiki/Kept" style="x:y" title="t">k</a></p>'));
  same('inline styles are dropped before parsing, links survive',
    [styled.querySelectorAll('[style], style').length, findFirstLink(styled, 'Foo')?.next], [0, 'Kept']);
  same('decodes encoded titles', first('<p><a href="/wiki/C%2B%2B">c</a></p>')?.next, 'C++');
  same('survives a malformed percent sign', first('<p><a href="/wiki/100%_Design">d</a></p>')?.next, '100% Design');
});

await group('Input', async () => {
  same('plain title', parseInput('Jazz').title, 'Jazz');
  same('link without scheme, with section', parseInput(' en.wikipedia.org/wiki/Jazz_fusion#History ').title, 'Jazz fusion');
  same('mobile link with tracking query', parseInput('https://en.m.wikipedia.org/wiki/AC/DC?wprov=sfla1').title, 'AC/DC');
  same('index.php link', parseInput('https://en.wikipedia.org/w/index.php?title=Jazz&oldid=1').title, 'Jazz');
  same('malformed percent in a link', parseInput('en.wikipedia.org/wiki/100%_Design').title, '100% Design');
  check('rejects another language edition', !!parseInput('de.wikipedia.org/wiki/Philosophie').error);
  check('rejects a non-Wikipedia link', !!parseInput('https://example.com/wiki/Jazz').error);
  check('rejects markup', !!parseInput('<img src=x onerror=alert(1)>').error);
  check('rejects empty input', !!parseInput('   ').error);
  check('rejects non-article pages', !!parseInput('Special:Random').error);
});

await group('Share links', async () => {
  same('drops markup, bad encoding and repeats',
    titlesFromHash('#q=Jazz|%3Cimg%20src%3Dx%3E|Banana|jazz|%E0%A4%A'), ['Jazz', 'Banana']);
  same('round trip', titlesFromHash(hashFromTitles(['Tallahassee, Florida', 'AC/DC'])), ['Tallahassee, Florida', 'AC/DC']);
  same('empty hash', titlesFromHash(''), []);
  same('loop label is the same from either side', [loopLabel(['Reality', 'Existence']), loopLabel(['Existence', 'Reality'])],
    ['Existence ↔ Reality', 'Existence ↔ Reality']);
});

await group('Path engine', async () => {
  const fast = { hopDelay: 0, cachedHopDelay: 0 };

  let store = createStore(fakeWiki({ A: 'B', B: 'Philosophy', Philosophy: 'X' }), fast);
  let chain = store.add('A');
  await chain.done;
  same('reaches Philosophy and stops', [chain.status, chain.steps.map((s) => s.title)], ['philosophy', ['A', 'B', 'Philosophy']]);

  store = createStore(fakeWiki({ A: 'B', B: 'C', C: 'B' }), fast);
  chain = store.add('A');
  await chain.done;
  same('detects a loop', [chain.status, chain.loopAt, chain.steps.length], ['loop', 1, 3]);
  const loopGraph = store.graph();
  same('loop is drawn closed', [loopGraph.nodes.length, loopGraph.links.length, loopGraph.nodes.filter((n) => n.inLoop).length], [3, 3, 2]);
  same('loop ending is named', store.outcomes().rows[0].label, 'Loop: B ↔ C');

  store = createStore(fakeWiki({ A: null }), fast);
  chain = store.add('A');
  await chain.done;
  same('dead end', chain.status, 'deadend');

  store = createStore(fakeWiki({}), fast);
  chain = store.add('Zzz');
  await chain.done;
  same('missing start', [chain.status, chain.steps.length], ['missing', 0]);

  store = createStore(fakeWiki((title) => ({ title, next: title + 'x', viaList: false, kind: 'article', cached: false })), fast);
  chain = store.add('A');
  await chain.done;
  same('hop limit has its own label, not "loop"', [chain.status, chain.steps.length], ['limit', MAX_HOPS]);

  store = createStore({ lookup: () => Promise.reject(new Error('boom')) }, fast);
  chain = store.add('A');
  await chain.done;
  same('a failed lookup ends the path cleanly', [chain.status, chain.detail, store.running()], ['error', 'boom', 0]);

  store = createStore(fakeWiki({ A: 'B', B: 'Philosophy' }), fast);
  store.subscribe(() => { throw new Error('listener blew up (expected in this test)'); });
  chain = store.add('A');
  await chain.done;
  same('a render error cannot stall a path', [chain.status, store.running()], ['philosophy', 0]);
});

await group('Removing a path while it runs', async () => {
  const table = {};
  for (let i = 0; i < 30; i++) table['N' + i] = 'N' + (i + 1);
  table.N30 = 'Philosophy';
  const wiki = fakeWiki(table, 25);
  const store = createStore(wiki, { hopDelay: 5, cachedHopDelay: 5 });
  const graph = createGraph(document.getElementById('test-graph'), window.d3);
  let renders = 0;
  store.subscribe(() => { renders++; graph.update(store.graph()); });

  const doomed = store.add('N0');
  await sleep(140);
  const stepsAtRemoval = doomed.steps.length;
  store.remove(doomed.id);
  const rendersAtRemoval = renders;
  const callsAtRemoval = wiki.calls.length;
  await sleep(400);

  check('it was removed mid-run', stepsAtRemoval > 0 && stepsAtRemoval < 31, `steps ${stepsAtRemoval}`);
  same('no paths, nodes or links are left', [store.chains.length, store.graph().nodes.length, store.graph().links.length], [0, 0, 0]);
  same('the map is empty', graph.counts(), { nodes: 0, links: 0, drawnNodes: 0, drawnLinks: 0 });
  same('the removed path stops rendering', renders, rendersAtRemoval);
  check('the removed path stops asking for pages', wiki.calls.length <= callsAtRemoval + 1, `${wiki.calls.length - callsAtRemoval} extra`);
  same('nothing is counted as running', store.running(), 0);

  const next = store.add('N25');
  await withTimeout(next.done, 5000);
  same('a new path still runs afterwards', next.status, 'philosophy');
  same('map matches the new path', [graph.counts().drawnNodes, graph.counts().drawnLinks], [next.steps.length, next.steps.length - 1]);

  const a = store.add('N10');
  const b = store.add('N10');
  await sleep(10);
  store.remove(a.id);
  await withTimeout(b.done, 8000);
  same('removing one path leaves a twin on the same article alone', b.status, 'philosophy');

  let threw = false;
  try {
    graph.update({
      nodes: [{ id: 'A', chains: new Set([1]), isStart: true, inLoop: false, isPhilosophy: false }],
      links: [{ key: 'A\nGhost', source: 'A', target: 'Ghost', chains: new Set([1]) }],
    });
  } catch { threw = true; }
  same('a link to a missing node is dropped, not thrown', [threw, graph.counts().links], [false, 0]);
  store.clear();
});

await group('Markup in titles stays text', async () => {
  const evil = '<img src=x onerror="window.__pwned=1">';
  const evil2 = '"><script>window.__pwned=1<\/script>';
  const store = createStore(fakeWiki({ [evil]: evil2, [evil2]: 'Philosophy', Philosophy: null }), { hopDelay: 0, cachedHopDelay: 0 });
  const host = document.getElementById('test-sidebar');
  const parts = {
    listEl: host.querySelector('.chains'), emptyEl: host.querySelector('.empty'),
    outcomesEl: host.querySelector('.outcomes'), statsEl: host.querySelector('.stats'),
  };
  const sidebar = createSidebar(parts, { onRemove() {}, onRetry() {}, onFocus() {} });
  const graph = createGraph(document.getElementById('test-graph-2'), window.d3);
  const chain = store.add(evil);
  await chain.done;
  sidebar.render(store, null);
  graph.update(store.graph());
  await sleep(50);
  same('sidebar holds no injected elements', host.querySelectorAll('img, script').length, 0);
  same('map holds no injected elements', document.getElementById('test-graph-2').querySelectorAll('img, script, foreignObject').length, 0);
  check('the title is shown as written', host.textContent.includes(evil));
  same('no injected script ran', window.__pwned, undefined);
});

await group('Wikipedia client (fake network)', async () => {
  const opts = { minGapMs: 0, retryBaseMs: 5, storage: memoryStorage() };

  let net = fakeFetch([{ status: 429 }, { status: 503 }, { body: parseReply('Jazz', '<p><a href="/wiki/Music">m</a></p>') }]);
  let wiki = createWiki({ ...opts, storage: memoryStorage(), fetchImpl: net.impl });
  let info = await wiki.lookup('Jazz');
  same('retries after 429 and 503', [info.next, wiki.stats.retries, wiki.stats.requests], ['Music', 2, 3]);

  net = fakeFetch(() => ({ body: parseReply('Jazz', '<p><a href="/wiki/Music">m</a></p>') }));
  const storage = memoryStorage();
  wiki = createWiki({ ...opts, storage, fetchImpl: net.impl });
  const [one, two] = await Promise.all([wiki.lookup('Jazz'), wiki.lookup('jazz')]);
  same('identical lookups share one request', [net.log.urls.length, one.next, two.next], [1, 'Music', 'Music']);
  info = await wiki.lookup('Jazz');
  same('a repeat is answered from memory', [net.log.urls.length, info.cached], [1, true]);
  same('only the lead section is requested', new URL(net.log.urls[0]).searchParams.get('section'), '0');

  wiki.flush();
  const offline = createWiki({ ...opts, storage, fetchImpl: async () => { throw new Error('offline'); } });
  info = await offline.lookup('Jazz');
  same('answers survive a reload', [info.next, info.cached], ['Music', true]);

  net = fakeFetch([{ body: parseReply('Stub', '<p>No links in the lead.</p>') }, { body: parseReply('Stub', '<p>No links.</p><p><a href="/wiki/Deep">d</a></p>') }]);
  wiki = createWiki({ ...opts, storage: memoryStorage(), fetchImpl: net.impl });
  info = await wiki.lookup('Stub');
  const asked = net.log.urls.map((url) => new URL(url).searchParams.get('section'));
  same('reads the whole page only when the lead has no link', [info.next, asked], ['Deep', ['0', null]]);

  net = fakeFetch([{ body: JSON.stringify({ error: { code: 'missingtitle', info: '<img src=x>' } }) }]);
  wiki = createWiki({ ...opts, storage: memoryStorage(), fetchImpl: net.impl });
  info = await wiki.lookup('Nope');
  same('a missing page is a result, not a crash', info.kind, 'missing');

  let n = 0;
  net = fakeFetch(() => (++n <= 2 ? new Error('down') : { body: parseReply('Up', '<p><a href="/wiki/Ok">o</a></p>') }));
  wiki = createWiki({ ...opts, maxTries: 2, storage: memoryStorage(), fetchImpl: net.impl });
  let code = null;
  try { await wiki.lookup('Down'); } catch (err) { code = err.code; }
  info = await wiki.lookup('Up');
  same('a dead connection reports once and the queue recovers', [code, info.next], ['network', 'Ok']);

  net = fakeFetch((url) => ({ body: parseReply(new URL(url).searchParams.get('page'), '<p><a href="/wiki/Next">n</a></p>') }));
  wiki = createWiki({ ...opts, storage: memoryStorage(), fetchImpl: net.impl });
  await Promise.all(['A', 'B', 'C', 'D', 'E'].map((title) => wiki.lookup(title)));
  same('requests go out one at a time', net.log.maxActive, 1);
});

await group('Live Wikipedia', async () => {
  const wiki = createWiki({ storage: memoryStorage() });

  let info = await withTimeout(wiki.lookup('Mercury'), 20000);
  check('disambiguation page "Mercury" yields a link', info.kind === 'article' && !!info.next && info.viaList === true, JSON.stringify(info));

  info = await withTimeout(wiki.lookup('Asdfqwerzxcv123'), 20000);
  same('a made-up title is reported missing', info.kind, 'missing');

  info = await withTimeout(wiki.lookup('jazz#History'), 20000);
  same('a section link resolves to its article', info.title, 'Jazz');

  const before = wiki.stats.chars;
  await withTimeout(wiki.lookup('United States'), 20000);
  const cost = wiki.stats.chars - before;
  check('"United States" costs under 300 KB (the old site pulled 1.66 MB)', cost > 0 && cost < 300000, `${cost} chars`);

  const store = createStore(wiki);
  const graph = createGraph(document.getElementById('test-graph-3'), window.d3);
  store.subscribe(() => graph.update(store.graph()));

  const doomed = store.add('Florida');
  await sleep(1500);
  const had = doomed.steps.length;
  store.remove(doomed.id);
  await sleep(2500);
  same(`live path removed mid-run (after ${had} articles) leaves nothing behind`,
    [store.chains.length, store.running(), graph.counts().drawnNodes, graph.counts().drawnLinks], [0, 0, 0, 0]);

  const banana = store.add('Banana');
  await withTimeout(banana.done, 90000);
  check('"Banana" runs to a real ending after that removal', ['philosophy', 'loop'].includes(banana.status),
    `${banana.status}: ${banana.detail}`);
  same('map matches the finished path', graph.counts().drawnNodes, banana.steps.length);

  const requests = wiki.stats.requests;
  const again = createStore(wiki, { hopDelay: 0, cachedHopDelay: 0 }).add('Banana');
  await withTimeout(again.done, 20000);
  same('tracing the same article again makes no new requests', [wiki.stats.requests - requests, again.status], [0, banana.status]);

  const random = await withTimeout(wiki.randomTitles(3), 20000);
  check('random articles arrive for wander mode', random.length === 3 && random.every((t) => typeof t === 'string' && t.length > 0), JSON.stringify(random));

  const li = document.createElement('li');
  li.className = 'note';
  li.textContent = `Banana path: ${banana.steps.map((s) => s.title).join(' > ')} (${banana.status})`;
  listEl.append(li);
});

await sleep(300);
heading('Page health');
same('no uncaught errors or rejections during the run', uncaught, []);
same('nothing was blocked by the Content Security Policy', [blocked.length, [...new Set(blocked)].slice(0, 3)], [0, []]);

summaryEl.textContent = `${passed} passed, ${failed} failed`;
summaryEl.className = failed ? 'fail' : 'pass';
document.title = `TESTS ${failed ? 'FAILED' : 'OK'}: ${passed} passed, ${failed} failed`;
