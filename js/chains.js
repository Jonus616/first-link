// Path state and the runner that follows first links. The graph and the
// sidebar are both drawn from this one list of paths, so there is no second
// copy of nodes or edges that could fall out of step with it.

import { PHILOSOPHY, titleKey, parseInput } from './wiki.js';

export const MAX_HOPS = 80;
export const MAX_CHAINS = 12;
export const MAX_RUNNING = 4;

const COLORS = ['#3b6fd4', '#1f8a70', '#7a4fd0', '#d9722b', '#4e9a2e', '#cf4f8f', '#2390b5', '#8d6a3b'];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function abortError() {
  return new DOMException('Path removed', 'AbortError');
}

// Lets one path stop waiting without cancelling work other paths share.
function abortable(promise, signal) {
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(abortError());
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => { signal.removeEventListener('abort', onAbort); resolve(value); },
      (err) => { signal.removeEventListener('abort', onAbort); reject(err); },
    );
  });
}

// "Reality" + "Existence" -> "Existence ↔ Reality", stable whichever
// article a path entered the loop through.
export function loopLabel(titles) {
  if (titles.length === 1) return `${titles[0]} links back to itself`;
  let best = 0;
  for (let i = 1; i < titles.length; i++) if (titles[i] < titles[best]) best = i;
  const turned = titles.slice(best).concat(titles.slice(0, best));
  return turned.length === 2 ? turned.join(' ↔ ') : turned.join(' → ') + ' → ' + turned[0];
}

export function createStore(wiki, { hopDelay = 220, cachedHopDelay = 70 } = {}) {
  const chains = [];
  const listeners = new Set();
  let nextId = 1;

  // A listener that throws must never stop a path or the other listeners.
  function emit() {
    for (const listener of listeners) {
      try { listener(); } catch (err) { console.error('Render failed:', err); }
    }
  }

  function finish(chain, status, detail = '') {
    if (chain.controller.signal.aborted) return;
    chain.status = status;
    chain.detail = detail;
    emit();
  }

  async function run(chain) {
    const { signal } = chain.controller;
    let current = chain.start;
    try {
      for (let hop = 0; ; hop++) {
        if (hop >= MAX_HOPS) return finish(chain, 'limit', `Stopped after ${MAX_HOPS} articles without an ending.`);
        if (titleKey(current) === PHILOSOPHY) {
          // The destination needs no lookup of its own.
          chain.steps.push({ title: PHILOSOPHY, viaList: false });
          return finish(chain, 'philosophy');
        }
        const info = await abortable(wiki.lookup(current), signal);
        if (info.kind === 'invalid') return finish(chain, 'missing', `"${current}" is not a valid article title.`);
        if (info.kind !== 'article') return finish(chain, 'missing', `Wikipedia has no article called "${current}".`);

        const loopAt = chain.steps.findIndex((step) => step.title === info.title);
        if (loopAt !== -1) {
          chain.loopAt = loopAt;
          return finish(chain, 'loop');
        }
        chain.steps.push({ title: info.title, viaList: info.viaList });
        if (info.title === PHILOSOPHY) return finish(chain, 'philosophy');
        if (!info.next) return finish(chain, 'deadend', `"${info.title}" has no usable first link.`);

        emit();
        current = info.next;
        await abortable(sleep(info.cached ? cachedHopDelay : hopDelay), signal);
      }
    } catch (err) {
      if (signal.aborted) return undefined;   // removed by the visitor: nothing left to update
      return finish(chain, 'error', err && err.message ? err.message : 'Something went wrong.');
    }
  }

  function add(title, { auto = false } = {}) {
    const chain = {
      id: nextId,
      start: title,
      auto,
      color: COLORS[(nextId - 1) % COLORS.length],
      steps: [],        // [{ title, viaList }]
      status: 'running',
      detail: '',
      loopAt: -1,       // index in steps where the loop begins
      controller: new AbortController(),
      done: null,
    };
    nextId++;
    chains.push(chain);
    chain.done = run(chain);
    emit();
    return chain;
  }

  function remove(id) {
    const index = chains.findIndex((chain) => chain.id === id);
    if (index === -1) return false;
    chains[index].controller.abort();
    chains.splice(index, 1);
    emit();
    return true;
  }

  function clear() {
    for (const chain of chains) chain.controller.abort();
    chains.length = 0;
    emit();
  }

  function has(title) {
    const key = titleKey(title);
    return chains.some((chain) => titleKey(chain.start) === key ||
      (chain.steps.length > 0 && titleKey(chain.steps[0].title) === key));
  }

  const running = () => chains.filter((chain) => chain.status === 'running').length;

  // Nodes and links, rebuilt from the paths every time.
  function graph() {
    const nodes = new Map();
    const links = new Map();
    const link = (source, target, id) => {
      if (source === target) return;
      const key = source + '\n' + target;
      let row = links.get(key);
      if (!row) links.set(key, row = { key, source, target, chains: new Set() });
      row.chains.add(id);
    };
    for (const chain of chains) {
      chain.steps.forEach((step, i) => {
        let node = nodes.get(step.title);
        if (!node) {
          nodes.set(step.title, node = {
            id: step.title, chains: new Set(), isStart: false, inLoop: false,
            isPhilosophy: step.title === PHILOSOPHY,
          });
        }
        node.chains.add(chain.id);
        if (i === 0) node.isStart = true;
        if (chain.loopAt !== -1 && i >= chain.loopAt) node.inLoop = true;
        if (i > 0) link(chain.steps[i - 1].title, step.title, chain.id);
      });
      if (chain.loopAt !== -1) {
        link(chain.steps[chain.steps.length - 1].title, chain.steps[chain.loopAt].title, chain.id);
      }
    }
    return { nodes: [...nodes.values()], links: [...links.values()] };
  }

  function ending(chain) {
    switch (chain.status) {
      case 'philosophy': return 'Philosophy';
      case 'loop': return 'Loop: ' + loopLabel(chain.steps.slice(chain.loopAt).map((step) => step.title));
      case 'deadend': return 'Dead end';
      case 'missing': return 'No such article';
      case 'limit': return 'Too long to finish';
      case 'error': return 'Could not load';
      default: return null;
    }
  }

  // How the finished paths ended, biggest group first.
  function outcomes() {
    const tally = new Map();
    let finished = 0;
    let philosophy = 0;
    for (const chain of chains) {
      const label = ending(chain);
      if (!label) continue;
      finished++;
      if (chain.status === 'philosophy') philosophy++;
      const row = tally.get(label) || { label, status: chain.status, count: 0 };
      row.count++;
      tally.set(label, row);
    }
    const rows = [...tally.values()].sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
    return { finished, philosophy, rows };
  }

  return {
    chains, add, remove, clear, has, running, graph, outcomes, ending,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
  };
}

// Share links: #q=Jazz|Banana. Every title goes back through parseInput, so
// a hand-made link can only ever produce plain article titles.
export function titlesFromHash(hash) {
  const match = /^#?q=(.*)$/.exec(String(hash || ''));
  if (!match) return [];
  const seen = new Set();
  const titles = [];
  for (const part of match[1].split('|')) {
    let text;
    try { text = decodeURIComponent(part); } catch { continue; }
    const parsed = parseInput(text);
    if (!parsed.title) continue;
    const key = titleKey(parsed.title);
    if (seen.has(key)) continue;
    seen.add(key);
    titles.push(parsed.title);
    if (titles.length >= MAX_CHAINS) break;
  }
  return titles;
}

export function hashFromTitles(titles) {
  return titles.length ? '#q=' + titles.map((title) => encodeURIComponent(title)).join('|') : '';
}
