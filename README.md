# wikisource-wordcount

A deterministic word count for Wikisource works that are transcluded from scan pages with ProofreadPage's
`<pages>` tag. Give it a Wikisource URL (or page title); it reads the work's `<pages>` tags, fetches the scan pages'
wikitext from the public API, applies fixed rules and returns the count, plus the method, version and the revision it
counted, so the number can be cited (for example as Wikidata's "number of words", P6570, with "determination
method" stated).

**Try it:** https://raybb.github.io/wikisource-wordcount/

## What is counted

| Counted | Not counted |
|---|---|
| The text of the work, as it reads on the page | Titles, bylines, headings and "Continued on page…" lines |
| Footnotes (also reported separately) | Illustrator credits, captions and images |
| Verse, including centred or right-aligned lines inside `<poem>` | Signatures and dates at the foot of a letter or story |
| Words in tables | Running heads, page numbers and anything else outside the work's section |
| Hyphenated words and contractions, as one word each | Dashes and ellipses on their own |

## How it works

1. **Find the text.** It reads the work's page on Wikisource and its `<pages>` tags, which say which scan pages
   (and which sections of them) make up the work.
2. **Fetch the scan pages.** It gets their wikitext from the public Wikisource API, in batches of up to 50.
3. **Reduce it to plain text.** Fixed rules (below) remove markup, templates and the parts listed under "Not
   counted", keeping the words a reader sees.
4. **Count.** A word is anything between spaces or dashes that contains a letter or digit.
5. **Report.** It returns the count, how many of those words are in footnotes, and `ok` or `unchecked`. Each
   result also records the work-page revision, the time of the latest scan-page edit and a fingerprint (SHA-256)
   of the text, so a count can be cited and checked later.

A result is `unchecked` when the tool met something its rules don't cover, such as a template it doesn't know. It
still gives its best count, but you should look before citing it.

## Ways to run it

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
(every `step`-th page; a missing `from` is page 1 and a missing `to` the last page of the scan), plus `include`,
minus `exclude`; `onlysection` on every page (every block with that name), `fromsection` on the first page and
`tosection` on the last. Sections can be marked with `<section begin/end>` or `## name ##`; names are
case-sensitive. Other attributes only fill in the generated header box, so they are ignored.

Then, on each page, in order:

1. Drop `<noinclude>` and HTML comments; keep only the selected section text.
2. **Footnotes** (`<ref>…</ref>`) are counted: they are part of the printed text. Their words are included in
   `words` and also reported on their own as `footnoteWords`.
3. Drop whole lines that are only one centred or right-aligned block (`{{c}}`, `{{center}}`, `{{right}}`,
   `{{float right}}`, `{{smaller}}`; spacing templates such as `{{nop}}` on the line are ignored) - title, byline,
   heading, signature, illustrator credit, captions, "Continued" notes - except inside `<poem>`, where such lines are
   verse. A `{{float right}}`/`{{right}}` block that ends a line with no line break after it (a signature or date at
   the foot of a paragraph) is dropped too; elsewhere, e.g. verse refrains, its text is kept.
   Images (`{{FI}}`, `{{FIS}}`, `{{missing image}}`, `[[File:...]]`) and their captions are dropped wherever they are.
4. Links show their text (`[[a|b]]` -> b); files and categories are dropped.
5. Templates are reduced innermost first: spacing, rules, anchors, images and signatures are dropped; hyphenation
   templates count the word once (`{{hws|a|b}}` -> b, `{{hwe}}` -> ""); formatting wrappers keep their text.
   **Any other template keeps its longest argument (its text, rather than a size or flag), is reported, and makes
   the result `unchecked`.**
6. HTML tags are removed with their content kept, table markup is reduced to cell text, `''`/`'''` are removed and
   HTML entities are decoded.
7. Count words: split on whitespace (including zero-width spaces) and em/en dashes; a token is a word if it contains
   a letter or digit (any script). Hyphenated compounds and contractions are one word; dashes and `. . .` are not
   words. Text in a script written without spaces (Chinese, Japanese, Thai...) makes the result `unchecked`.

Each result also records the revision of the work's page, the time of the latest edit to any counted scan page, and
a SHA-256 of the exact text counted, so two counts can be compared.

Known limits:
- Anything set as a centred line outside `<poem>` is not counted. That is what keeps titles, bylines, headings and
  captions out, but it also leaves out text that a work sets centred for other reasons, such as speaker names in
  some plays (about 3% of *Riders to the Sea*).
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

Version 1.1 was checked by two independent reviews: a code review, and field tests on 41 works (Saturday Evening
Post stories, novels, poems, plays, letters, speeches, statutes, encyclopedia and magazine articles, works with
footnotes and tables, and works on French, German and Italian Wikisource), each compared with a count made by hand
from the rendered page. Results marked `ok` agreed within 0.4%; larger differences came only with `unchecked`
results (unknown templates) or the documented limits above.
