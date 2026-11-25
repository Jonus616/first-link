// Force-directed map of the paths, drawn with D3. It only ever receives a
// complete snapshot { nodes, links } built from the same list of paths, so
// every link end is guaranteed to exist as a node.

import { articleUrl } from './wiki.js';

const LABEL_MAX = 24;

function radius(node) {
  if (node.isPhilosophy) return 11;
  return Math.min(6 + (node.chains.size - 1) * 1.5, 11);
}

function shortLabel(title) {
  return title.length > LABEL_MAX ? title.slice(0, LABEL_MAX - 1) + '…' : title;
}

export function createGraph(svgElement, d3) {
  const svg = d3.select(svgElement);
  const defs = svg.append('defs');
  defs.append('marker')
    .attr('id', 'arrow').attr('viewBox', '0 0 10 10')
    .attr('refX', 9).attr('refY', 5)
    .attr('markerWidth', 7).attr('markerHeight', 7)
    .attr('orient', 'auto-start-reverse')
    .append('path').attr('class', 'arrow-head').attr('d', 'M0,1 L9,5 L0,9 Z');

  const viewport = svg.append('g').attr('class', 'viewport');
  const linkLayer = viewport.append('g').attr('class', 'links');
  const nodeLayer = viewport.append('g').attr('class', 'nodes');

  const placed = new Map();   // title -> simulation node, kept so positions survive updates
  let simNodes = [];
  let simLinks = [];
  let linkSel = linkLayer.selectAll('line');
  let nodeSel = nodeLayer.selectAll('g');
  let size = { width: 800, height: 600 };
  let follow = true;          // camera keeps the whole map in view until the visitor moves it
  let focusId = null;

  // The page scrolls, so a plain wheel must scroll it. Zooming takes Ctrl or
  // Cmd plus the wheel (which is also what a trackpad pinch sends).
  const zoom = d3.zoom()
    .scaleExtent([0.12, 4])
    .filter((event) => !event.button && (event.type !== 'wheel' || event.ctrlKey || event.metaKey))
    .on('zoom', (event) => {
      if (event.sourceEvent) follow = false;
      viewport.attr('transform', event.transform);
    });
  svg.call(zoom).on('dblclick.zoom', null);

  const simulation = d3.forceSimulation()
    .force('link', d3.forceLink().id((d) => d.id).distance(62).strength(0.55))
    .force('charge', d3.forceManyBody().strength(-260).distanceMax(460))
    .force('collide', d3.forceCollide().radius((d) => radius(d.data) + 12))
    .force('x', d3.forceX(0).strength(0.045))
    .force('y', d3.forceY(0).strength(0.045))
    .on('tick', tick);
  simulation.stop();

  function measure() {
    const box = svgElement.getBoundingClientRect();
    if (box.width > 0 && box.height > 0) size = { width: box.width, height: box.height };
  }

  function fitTransform() {
    if (simNodes.length === 0) return d3.zoomIdentity.translate(size.width / 2, size.height / 2);
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const node of simNodes) {
      if (node.x < minX) minX = node.x;
      if (node.x > maxX) maxX = node.x;
      if (node.y < minY) minY = node.y;
      if (node.y > maxY) maxY = node.y;
    }
    const pad = 90;
    const scale = Math.max(0.12, Math.min(
      size.width / (maxX - minX + pad * 2),
      size.height / (maxY - minY + pad * 2),
      1.4,
    ));
    return d3.zoomIdentity
      .translate(size.width / 2, size.height / 2)
      .scale(scale)
      .translate(-(minX + maxX) / 2, -(minY + maxY) / 2);
  }

  function tick() {
    linkSel
      .attr('x1', (d) => d.source.x)
      .attr('y1', (d) => d.source.y)
      .each(function shorten(d) {
        // Stop the line at the edge of the target so the arrowhead shows.
        const dx = d.target.x - d.source.x;
        const dy = d.target.y - d.source.y;
        const length = Math.hypot(dx, dy) || 1;
        const gap = radius(d.target.data) + 3;
        this.setAttribute('x2', d.target.x - (dx / length) * gap);
        this.setAttribute('y2', d.target.y - (dy / length) * gap);
      });
    nodeSel.attr('transform', (d) => `translate(${d.x},${d.y})`);

    if (follow) {
      const now = d3.zoomTransform(svgElement);
      const goal = fitTransform();
      const ease = 0.12;
      svg.call(zoom.transform, d3.zoomIdentity
        .translate(now.x + (goal.x - now.x) * ease, now.y + (goal.y - now.y) * ease)
        .scale(now.k + (goal.k - now.k) * ease));
    }
  }

  function applyFocus() {
    svg.classed('has-focus', focusId !== null);
    nodeSel.classed('is-hot', (d) => focusId !== null && d.data.chains.has(focusId));
    linkSel.classed('is-hot', (d) => focusId !== null && d.chains.has(focusId));
  }

  function update(snapshot) {
    measure();

    // Neighbours, so a new article appears beside the one that led to it.
    const neighbours = new Map();
    for (const link of snapshot.links) {
      if (!neighbours.has(link.target)) neighbours.set(link.target, []);
      if (!neighbours.has(link.source)) neighbours.set(link.source, []);
      neighbours.get(link.target).push(link.source);
      neighbours.get(link.source).push(link.target);
    }

    const live = new Set();
    simNodes = snapshot.nodes.map((data) => {
      live.add(data.id);
      let node = placed.get(data.id);
      if (!node) {
        const anchor = (neighbours.get(data.id) || []).map((id) => placed.get(id)).find(Boolean);
        const angle = Math.random() * Math.PI * 2;
        const reach = anchor ? 30 : 170 + Math.random() * 60;
        node = {
          id: data.id,
          x: (anchor ? anchor.x : 0) + Math.cos(angle) * reach,
          y: (anchor ? anchor.y : 0) + Math.sin(angle) * reach,
        };
        placed.set(data.id, node);
      }
      node.data = data;
      return node;
    });
    for (const id of [...placed.keys()]) if (!live.has(id)) placed.delete(id);

    // Only links whose two ends are present are handed to D3.
    simLinks = snapshot.links
      .filter((link) => placed.has(link.source) && placed.has(link.target))
      .map((link) => ({ key: link.key, source: link.source, target: link.target, chains: link.chains }));

    simulation.nodes(simNodes);
    simulation.force('link').links(simLinks);

    linkSel = linkLayer.selectAll('line')
      .data(simLinks, (d) => d.key)
      .join((enter) => enter.append('line').attr('class', 'link').attr('marker-end', 'url(#arrow)'));

    nodeSel = nodeLayer.selectAll('g.node')
      .data(simNodes, (d) => d.id)
      .join((enter) => {
        const group = enter.append('g').attr('class', 'node');
        group.append('circle').attr('class', 'halo');
        group.append('circle').attr('class', 'dot');
        group.append('text').attr('class', 'label').attr('text-anchor', 'middle');
        group.append('title');
        group.on('click', (event, d) => {
          if (event.defaultPrevented) return;   // the end of a drag, not a click
          window.open(articleUrl(d.id), '_blank', 'noopener');
        });
        group.call(d3.drag()
          .on('start', (event, d) => {
            if (!event.active) simulation.alphaTarget(0.25).restart();
            d.fx = d.x; d.fy = d.y;
          })
          .on('drag', (event, d) => { d.fx = event.x; d.fy = event.y; })
          .on('end', (event, d) => {
            if (!event.active) simulation.alphaTarget(0);
            d.fx = null; d.fy = null;
          }));
        return group;
      });

    nodeSel
      .classed('is-philosophy', (d) => d.data.isPhilosophy)
      .classed('is-loop', (d) => d.data.inLoop)
      .classed('is-start', (d) => d.data.isStart)
      .classed('is-shared', (d) => d.data.chains.size > 1);
    nodeSel.select('.dot').attr('r', (d) => radius(d.data));
    nodeSel.select('.halo').attr('r', (d) => radius(d.data) + 5);
    nodeSel.select('.label').attr('dy', (d) => radius(d.data) + 14).text((d) => shortLabel(d.id));
    nodeSel.select('title').text((d) => {
      const count = d.data.chains.size;
      return `${d.id}\n${count} ${count === 1 ? 'path passes' : 'paths pass'} through here. Click to open the article.`;
    });

    applyFocus();

    if (simNodes.length === 0) {
      simulation.stop();
      follow = true;
      svg.call(zoom.transform, fitTransform());
      return;
    }
    simulation.alpha(Math.max(simulation.alpha(), 0.45)).restart();
  }

  function setFocus(chainId, color) {
    focusId = chainId;
    if (color) svgElement.style.setProperty('--focus', color);
    applyFocus();
  }

  function zoomBy(factor) {
    follow = false;
    svg.transition().duration(180).call(zoom.scaleBy, factor);
  }

  function fit() {
    follow = true;
    measure();
    if (simulation.alpha() < 0.05) svg.transition().duration(300).call(zoom.transform, fitTransform());
  }

  if (typeof ResizeObserver === 'function') {
    new ResizeObserver(() => {
      measure();
      if (follow) svg.call(zoom.transform, fitTransform());
    }).observe(svgElement);
  }
  measure();
  svg.call(zoom.transform, fitTransform());

  return {
    update, setFocus, zoomBy, fit,
    counts() {
      return {
        nodes: simNodes.length,
        links: simLinks.length,
        drawnNodes: nodeLayer.selectAll('g.node').size(),
        drawnLinks: linkLayer.selectAll('line').size(),
      };
    },
  };
}
