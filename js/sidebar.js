// Sidebar rendering. Every piece of article text is written with textContent
// or as an attribute through the DOM API. Nothing here builds HTML strings,
// so a title can never be read as markup.

import { PHILOSOPHY, articleUrl } from './wiki.js';
import { loopLabel } from './chains.js';

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function plural(count, one, many) {
  return `${count} ${count === 1 ? one : many}`;
}

function statusLine(chain) {
  const count = chain.steps.length;
  switch (chain.status) {
    case 'running': return count === 0 ? 'Looking it up…' : 'Following first links…';
    case 'philosophy': return count === 1 ? 'This is Philosophy itself.' : `Reached Philosophy in ${plural(count - 1, 'click', 'clicks')}.`;
    case 'loop': return `Stuck in a loop: ${loopLabel(chain.steps.slice(chain.loopAt).map((step) => step.title))}.`;
    default: return chain.detail || 'Stopped.';
  }
}

export function createSidebar({ listEl, emptyEl, outcomesEl, statsEl }, handlers) {
  const cards = new Map();   // chain id -> { root, meta, status, steps, shown, retry, tail }

  function buildCard(chain) {
    // Laid out like an article section: heading, then a bracketed action
    // where an encyclopedia would put its edit link.
    const root = el('li', 'chain');
    const head = el('h3', 'chain-head');
    const title = el('span', 'chain-title', chain.start);
    const action = el('span', 'editsection');
    const remove = el('button', 'chain-remove', 'remove');
    remove.type = 'button';
    remove.setAttribute('aria-label', `Remove the path from ${chain.start}`);
    remove.addEventListener('click', () => handlers.onRemove(chain));
    action.append(remove);
    head.append(title, action);

    const status = el('p', 'chain-status');
    const retry = el('button', 'chain-retry', 'retry');
    retry.type = 'button';
    retry.hidden = true;
    retry.addEventListener('click', () => handlers.onRetry(chain));
    const steps = el('ol', 'steps');
    const tail = el('p', 'chain-tail');
    tail.hidden = true;

    root.append(head, status, retry, steps, tail);
    root.addEventListener('mouseenter', () => handlers.onFocus(chain));
    root.addEventListener('mouseleave', () => handlers.onFocus(null));
    root.addEventListener('focusin', () => handlers.onFocus(chain));
    root.addEventListener('focusout', () => handlers.onFocus(null));
    return { root, status, steps, retry, tail, shown: 0 };
  }

  function updateCard(card, chain) {
    card.root.dataset.status = chain.status;
    card.status.textContent = statusLine(chain);
    card.retry.hidden = chain.status !== 'error';

    // Steps only ever grow, so add the new ones instead of redrawing.
    for (; card.shown < chain.steps.length; card.shown++) {
      const step = chain.steps[card.shown];
      const item = el('li', 'step');
      const link = el('a', null, step.title);
      link.href = articleUrl(step.title);
      link.target = '_blank';
      link.rel = 'noopener';
      if (step.title === PHILOSOPHY) item.classList.add('is-philosophy');
      item.append(link);
      card.steps.append(item);
    }
    const items = card.steps.children;
    for (let i = 0; i < items.length; i++) {
      items[i].classList.toggle('in-loop', chain.loopAt !== -1 && i >= chain.loopAt);
      items[i].classList.toggle('via-list', chain.steps[i].viaList === true);
    }
    if (chain.status === 'loop') {
      card.tail.textContent = `↺ back to ${chain.steps[chain.loopAt].title}`;
      card.tail.hidden = false;
    } else {
      card.tail.hidden = true;
    }
  }

  function renderOutcomes(store) {
    const { finished, philosophy, rows } = store.outcomes();
    outcomesEl.hidden = finished === 0;
    outcomesEl.replaceChildren();
    if (finished === 0) return;
    const table = el('table', 'tally');
    const body = el('tbody');
    for (const row of rows) {
      const line = el('tr');
      line.dataset.status = row.status;
      const label = el('th', null, row.label);
      label.scope = 'row';
      line.append(label, el('td', null, String(row.count)));
      body.append(line);
    }
    const total = el('tr', 'tally-total');
    const totalLabel = el('th', null, 'Reached Philosophy');
    totalLabel.scope = 'row';
    total.append(totalLabel, el('td', null, `${philosophy} of ${finished}`));
    body.append(total);
    table.append(body);
    outcomesEl.append(el('div', 'infobox-header', 'Endings'), table);
  }

  function render(store, wikiStats) {
    const seen = new Set();
    for (const chain of store.chains) {
      seen.add(chain.id);
      let card = cards.get(chain.id);
      if (!card) {
        card = buildCard(chain);
        cards.set(chain.id, card);
        listEl.prepend(card.root);   // newest on top
      }
      updateCard(card, chain);
    }
    for (const [id, card] of cards) {
      if (!seen.has(id)) { card.root.remove(); cards.delete(id); }
    }
    emptyEl.hidden = store.chains.length > 0;
    renderOutcomes(store);

    if (statsEl) {
      const { nodes } = store.graph();
      const shared = nodes.filter((node) => node.chains.size > 1).length;
      const parts = [
        plural(store.chains.length, 'path', 'paths'),
        plural(nodes.length, 'article', 'articles'),
        `${shared} shared`,
      ];
      if (wikiStats) parts.push(`${plural(wikiStats.requests, 'request', 'requests')} to Wikipedia`, `${wikiStats.cacheHits} answered from memory`);
      statsEl.textContent = parts.join(' · ');
    }
  }

  return { render };
}
