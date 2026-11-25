# First Link

Follow the first real link of any Wikipedia article, again and again, and see
where the path ends: Philosophy, a loop, or a dead end.

Live: https://jonus616.github.io/first-link/

## How it works

- A static site with no build step and no server code. It reads English
  Wikipedia's public API from your browser.
- The rule: first link in the running text that is outside parentheses and
  italics, is not a link to the page itself, is not a red link, and is not a
  Help or File style page. Disambiguation pages use their first list entry.
- Only the lead section of each article is fetched. Answers are kept in
  memory and for 3 days in localStorage, requests go out one at a time, and
  rate-limit answers are retried with backoff.
- Every ending is named and tallied: Philosophy, which loop, dead end, or no
  such article.
- Share a set of paths with a link like `#q=Jazz|Banana`.
- Article text is never written as HTML, and a Content Security Policy blocks
  inline script.

## Run it locally

    python -m http.server 8801

Then open http://localhost:8801 . Checks live at `/tests.html`.

## Files

- `index.html`, `css/styles.css`: the page.
- `js/wiki.js`: input parsing, the first-link rule, the Wikipedia client.
- `js/chains.js`: path state, the runner, share links.
- `js/graph.js`: the D3 map.
- `js/sidebar.js`: the path list and the tally of endings.
- `js/main.js`: wiring and wander mode.
- `tests.html`, `js/tests.js`, `css/tests.css`: in-browser checks.

Article data comes from Wikipedia and is available under CC BY-SA.
