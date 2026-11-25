// Wires the page together: form, wander mode, share links, map and sidebar.

import { createWiki, parseInput, titleKey } from './wiki.js';
import { createStore, titlesFromHash, hashFromTitles, MAX_CHAINS, MAX_RUNNING } from './chains.js';
import { createGraph } from './graph.js';
import { createSidebar } from './sidebar.js';

const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const wiki = createWiki();
const store = createStore(wiki);

const messageEl = $('message');
let messageTimer = null;
function say(text, { sticky = false } = {}) {
  messageEl.textContent = text;
  clearTimeout(messageTimer);
  if (text && !sticky) messageTimer = setTimeout(() => { messageEl.textContent = ''; }, 6000);
}

// The map needs D3 from the CDN. If that is blocked, the paths still work
// and are listed in the sidebar.
let graph = null;
if (window.d3) {
  try { graph = createGraph($('graph'), window.d3); }
  catch (err) { console.error('Map failed to start:', err); }
}
if (!graph) {
  $('stage').classList.add('no-map');
  $('map-fallback').hidden = false;
}

let focused = null;
const sidebar = createSidebar(
  { listEl: $('chains'), emptyEl: $('empty'), outcomesEl: $('outcomes'), statsEl: null },
  {
    onRemove: (chain) => store.remove(chain.id),
    onRetry: (chain) => { store.remove(chain.id); store.add(chain.start, { auto: chain.auto }); },
    onFocus: (chain) => {
      focused = chain ? chain.id : null;
      if (graph) graph.setFocus(focused, null);
    },
  },
);

let lastHash = location.hash;
function syncHash() {
  const hash = hashFromTitles(store.chains.map((chain) => chain.start));
  if (hash === lastHash) return;
  lastHash = hash;
  try { history.replaceState(null, '', hash || location.pathname + location.search); } catch { /* not allowed here */ }
}

store.subscribe(() => {
  if (focused !== null && !store.chains.some((chain) => chain.id === focused)) {
    focused = null;
    if (graph) graph.setFocus(null, null);
  }
  if (graph) graph.update(store.graph());
  sidebar.render(store, wiki.stats);
  $('clear').disabled = store.chains.length === 0;
  $('copy-link').disabled = store.chains.length === 0;
  syncHash();
});

// Drops the oldest finished path when the map is full. Returns false when
// every path is still running and nothing can be dropped.
function makeRoom() {
  while (store.chains.length >= MAX_CHAINS) {
    const oldest = store.chains.find((chain) => chain.status !== 'running' && chain.auto) ||
                   store.chains.find((chain) => chain.status !== 'running');
    if (!oldest) return false;
    store.remove(oldest.id);
  }
  return true;
}

function trace(raw) {
  const parsed = parseInput(raw);
  if (parsed.error) { say(parsed.error); return false; }
  if (store.has(parsed.title)) { say(`"${parsed.title}" is already on the map.`); return false; }
  if (store.running() >= MAX_RUNNING) { say('A few paths are still running. Give them a moment.'); return false; }
  if (!makeRoom()) { say('The map is full. Remove a path first.'); return false; }
  say('');
  store.add(parsed.title);
  return true;
}

$('run-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const input = $('article');
  if (trace(input.value)) input.value = '';
  input.focus();
});

for (const button of document.querySelectorAll('[data-example]')) {
  button.addEventListener('click', () => trace(button.dataset.example));
}

// Wander: one random article at a time, each started only after the last
// one has finished. It never touches the text box.
let wandering = false;
let wanderRun = 0;

function setWander(on) {
  wandering = on;
  const button = $('wander');
  button.setAttribute('aria-pressed', String(on));
  button.textContent = on ? 'Stop wandering' : 'Wander';
  if (on) wander(++wanderRun);
}

async function wander(run) {
  let pool = [];
  while (wandering && run === wanderRun) {
    try {
      if (document.hidden) { await sleep(1000); continue; }
      if (pool.length === 0) pool = await wiki.randomTitles(8);
      const title = pool.shift();
      if (!title) { await sleep(2000); continue; }
      if (store.has(title)) continue;
      if (store.running() >= MAX_RUNNING || !makeRoom()) { await sleep(1000); continue; }
      const chain = store.add(title, { auto: true });
      await chain.done;
      await sleep(1400);
    } catch (err) {
      say(`Wandering stopped: ${err && err.message ? err.message : 'something went wrong.'}`, { sticky: true });
      setWander(false);
    }
  }
}

$('wander').addEventListener('click', () => setWander(!wandering));

$('clear').addEventListener('click', () => {
  setWander(false);
  store.clear();
  say('');
});

$('copy-link').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(location.href);
    say('Link copied. It reopens this exact set of paths.');
  } catch {
    say('Copy the address bar to share this set of paths.');
  }
});

if (graph) {
  $('zoom-in').addEventListener('click', () => graph.zoomBy(1.3));
  $('zoom-out').addEventListener('click', () => graph.zoomBy(1 / 1.3));
  $('zoom-fit').addEventListener('click', () => graph.fit());
}

// Appearance: Automatic follows the device, Light and Dark are remembered.
for (const radio of document.querySelectorAll('input[name="theme"]')) {
  radio.checked = radio.value === (document.documentElement.dataset.theme || 'os');
  radio.addEventListener('change', () => {
    if (!radio.checked) return;
    document.documentElement.dataset.theme = radio.value;
    try { localStorage.setItem('first-link-theme', radio.value); } catch { /* not remembered, still applied */ }
  });
}

window.addEventListener('pagehide', () => wiki.flush());

// A share link opens with its paths already running.
const shared = titlesFromHash(location.hash);
const seen = new Set();
for (const title of shared) {
  const key = titleKey(title);
  if (seen.has(key)) continue;
  seen.add(key);
  store.add(title);
}
if (shared.length === 0) sidebar.render(store, wiki.stats);
