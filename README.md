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

## Rules (version 1.1)

**Which text.** The scan pages and sections are chosen exactly as the `<pages>` tag chooses them: `from`..`to`
(every `step`-th page), plus `include`, minus `exclude`; `onlysection` on every page, `fromsection` on the first page
and `tosection` on the last. Sections can be marked with `<section begin/end>` or `## name ##`. Other attributes only
fill in the generated header box, so they are ignored.

Then, on each page, in order:

1. Drop `<noinclude>` and HTML comments; keep only the selected section text.
2. **Footnotes** (`<ref>…</ref>`) are counted: they are part of the printed text. Their words are included in
   `words` and also reported on their own as `footnoteWords`.
3. Drop whole lines that are only a centred or right-aligned block (`{{c}}`, `{{center}}`, `{{right}}`,
   `{{float right}}`, `{{smaller}}`) - title, byline, signature, illustrator credit, captions, "Continued" notes.
   Images (`{{FI}}`, `{{FIS}}`, `{{missing image}}`, `[[File:...]]`) and their captions are dropped wherever they are.
4. Links show their text (`[[a|b]]` -> b); files and categories are dropped.
5. Templates are reduced innermost first: spacing, rules, anchors, images and signatures are dropped; hyphenation
   templates count the word once (`{{hws|a|b}}` -> b, `{{hwe}}` -> ""); formatting wrappers keep their text.
   **Any other template keeps its first unnamed argument, is reported, and makes the result `unchecked`.**
6. HTML tags are removed with their content kept, table markup is reduced to cell text, `''`/`'''` are removed and
   HTML entities are decoded.
7. Count words: split on whitespace and em/en dashes; a token is a word if it contains a letter or digit (any script).
   Hyphenated compounds and contractions are one word; dashes and `. . .` are not words.

Known limits:
- Anything set as a centred line is not counted. That is what keeps titles, bylines and captions out, but it also
  leaves out text that a work sets centred for other reasons, such as speaker names in some plays (about 3% of
  *Riders to the Sea*) or centred verse.
- Figure captions are not counted.
- Editorial text inside the work's section (e.g. a magazine's introduction to a reprinted poem) is counted.
- Works not built with `<pages>` return an error; a work split into chapter subpages is counted per subpage.

## Related

[Prosesize](https://prosesize.toolforge.org) counts readable prose on Wikimedia wikis but returns 0 for
Wikisource works built with `<pages>`, because their paragraphs sit inside the ProofreadPage output rather than
directly under the page's sections. Reported as [T446117](https://phabricator.wikimedia.org/T446117).

## Development

```
npm install
npm run typecheck
npm test          # offline unit tests for the rules
npm run build     # writes dist/cli.js, dist/web.js, dist/gadget.js
```

Checked against an independent Python implementation of the same rules on 15 works (all identical), and against
Prosesize's whitespace counting of `.prp-pages-output > p` (identical on prose without dashes; within 0.6% otherwise).
