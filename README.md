# wikisource-wordcount

A deterministic word count for Wikisource works that are transcluded from scan pages with ProofreadPage's
`<pages>` tag. Give it a Wikisource URL (or page title); it reads the work's `<pages>` tags, fetches the scan pages'
wikitext from the public API, applies fixed rules and returns the count, plus the method, version and the revision it
counted, so the number can be cited (for example as Wikidata's "number of words", P6570, with "determination
method" stated).

One TypeScript core (`src/core.ts`) is compiled to three entry points:

| Entry | File | How to run |
|---|---|---|
| Command line (Node 18+) | `dist/cli.js` | `node dist/cli.js <URL or title> [...]`, add `--json` for JSON |
| Web page | `index.html` + `dist/web.js` | serve the folder and open `index.html`, or add `?url=<Wikisource URL>` |
| Wikisource user script | `dist/gadget.js` | adds **Word count** to the Tools menu on works built with `<pages>` |

Everything runs client side. Browser requests use the MediaWiki API's anonymous CORS mode (`origin=*`) and identify
themselves with the `Api-User-Agent` header.

## Rules (version 1.0)

Applied to the wikitext of every transcluded `Page:` page, in order:

1. Keep only the text between `<section begin="S" />` and `<section end="S" />` (S = `onlysection`), or the whole
   page body if there is no `onlysection`. Drop everything inside `<noinclude>`.
2. Drop whole lines that are only a centred or right-aligned block (`{{c}}`, `{{center}}`, `{{right}}`,
   `{{float right}}`, `{{smaller}}`) - title, byline, signature, illustrator credit, captions, "Continued" notes - and
   image lines (`{{FI}}`, `{{missing image}}`, `[[File:...]]`).
3. Unwrap formatting templates to their text (`{{sc}}`, `{{di}}`, `{{larger}}`, `{{hws|a|b}}` -> b, `{{hwe}}` -> "",
   `{{SIC|a|b}}` -> a, ...), remove `{{nop}}`, `{{gap}}`, `{{dhr}}` and signatures in `{{float right}}`, and strip
   `''`/`'''` and `<poem>`. **Any other template left over is reported and the result is marked `unchecked`.**
4. Count words: split on whitespace and em/en dashes; a token is a word if it contains a letter or digit. Hyphenated
   compounds and contractions are one word; dashes and `. . .` are not words.

Known limits: titles and captions must be centred/right-aligned blocks to be excluded; works not built with `<pages>`
return an error; a work split into chapter subpages has to be counted per subpage; editorial text inside the work's
section (e.g. a magazine's introduction to a reprinted poem) is counted.

## Development

```
npm install
npm run typecheck
npm test          # offline unit tests for the rules
npm run build     # writes dist/cli.js, dist/web.js, dist/gadget.js
```

Checked against an independent Python implementation of the same rules on 15 works (all identical), and against
Prosesize's whitespace counting of `.prp-pages-output > p` (identical on prose without dashes; within 0.6% otherwise).
