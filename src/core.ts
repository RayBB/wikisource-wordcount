/**
 * wikisource-wordcount core: a deterministic word count for a Wikisource work that is transcluded from scan pages
 * with ProofreadPage's <pages> tag. Runs anywhere `fetch` exists (Node 18+, browsers, Wikisource gadgets).
 *
 * Which pages and sections (from the <pages> tag):
 *  - pages = from..to (every `step`-th page) plus `include`, minus `exclude`, in page order;
 *  - `onlysection` keeps only that section on every page; `fromsection` starts the first page at that section and
 *    `tosection` ends the last page with that section. Sections may be marked <section begin/end> or "## name ##".
 *  - Every other attribute only fills in the generated header box, so it is ignored.
 *
 * Rules (applied to the wikitext of every selected Page: page, in order):
 *  1. Drop <noinclude>...</noinclude> and HTML comments; keep only the selected section text.
 *  2. Footnotes: the text of every <ref>...</ref> is taken out and counted separately (it is included in `words`
 *     and also reported as `footnoteWords`). <references/> and empty refs are dropped.
 *  3. Drop whole lines that are only a centred or right-aligned block ({{c}}, {{center}}, {{right}},
 *     {{float right}}, {{smaller}}) - title, byline, signature, illustrator credit, captions, "Continued" notes - and
 *     image lines ([[File:...]]). Images ({{FI}}, {{FIS}}, {{missing image}}) are dropped wherever they are.
 *  4. Links show their text: [[a|b]] -> b, [[a]] -> a, [url text] -> text; [[File:]] and [[Category:]] are dropped.
 *  5. Templates, innermost first: a fixed list is dropped (spacing, rules, anchors, images, signatures), hyphenation
 *     templates keep the whole word once ({{hws|a|b}} -> b, {{hwe}} -> ""), and formatting wrappers keep their text.
 *     Any other template keeps its first unnamed argument, is reported, and makes the result "unchecked".
 *  6. HTML tags are removed and their content kept (<math>, <score> and similar are dropped); table markup is
 *     reduced to cell text; '' and ''' are removed; HTML entities are decoded.
 *  7. Count words: split on whitespace and em/en dashes; a token is a word if it contains a letter or digit
 *     (any script). So hyphenated compounds and contractions are one word; dashes and ". . ." are not words.
 */

export const METHOD = 'wikisource-wordcount';
export const VERSION = '1.1';
export const RULES =
  'pages/sections as the <pages> tag selects them (from, to, step, include, exclude, onlysection, fromsection, ' +
  'tosection); noinclude, comments, titles/bylines/captions (centred or right-aligned lines) and images dropped; ' +
  'footnotes counted and also reported separately; links, templates, HTML and entities reduced to their text; ' +
  'words split on whitespace and em/en dashes; a word contains a letter or digit';

export interface CountResult {
  title: string;
  url: string;
  /** All words, footnotes included. */
  words: number;
  /** Words in footnotes (<ref>), already included in `words`. */
  footnoteWords: number;
  status: 'ok' | 'unchecked';
  unhandledTemplates: string[];
  /** <pages> attribute values the tool could not interpret (each makes the result "unchecked"). */
  unhandledAttributes: string[];
  /** Other reasons the count may not be meaningful (each makes the result "unchecked"). */
  warnings: string[];
  scanPages: number;
  /** Revision of the work's own page (the <pages> tags). */
  revision: number;
  revisionTimestamp: string;
  /** Time of the most recent edit to any of the counted scan pages. */
  scanPagesLatestEdit: string;
  /** SHA-256 of the exact text that was counted, so two counts can be compared. */
  textSha256: string;
  method: string;
  version: string;
  rules: string;
}

export interface CountError {
  title: string;
  error: string;
}

export interface Options {
  /** Identifies the client to Wikimedia. Browsers send it as Api-User-Agent; Node also sets User-Agent. */
  userAgent?: string;
  /** Override fetch (for tests). */
  fetch?: typeof fetch;
}

const DEFAULT_API = 'https://en.wikisource.org/w/api.php';

/** Accept a Wikisource URL (/wiki/Title or index.php?title=Title) or a bare title; return the API URL and title. */
export function parseTarget(arg: string): { api: string; title: string } {
  const input = arg.trim();
  let u: URL | null = null;
  try {
    u = new URL(input);
  } catch {
    u = null;
  }
  if (u && (u.protocol === 'http:' || u.protocol === 'https:') && u.hostname.endsWith('wikisource.org')) {
    const api = `https://${u.hostname}/w/api.php`;
    let title = '';
    if (u.pathname.startsWith('/wiki/')) {
      title = decodeURIComponent(u.pathname.slice('/wiki/'.length));
    } else {
      title = u.searchParams.get('title') ?? '';
    }
    return { api, title: title.replace(/_/g, ' ') };
  }
  return { api: DEFAULT_API, title: input.replace(/_/g, ' ') };
}

/** "18,19, 90-92" -> [18, 19, 90, 91, 92] */
export function expandInclude(spec: string): number[] {
  const out: number[] = [];
  for (const raw of spec.split(',')) {
    const part = raw.trim();
    if (!part) continue;
    const m = /^(\d+)\s*-\s*(\d+)$/.exec(part);
    if (m) {
      for (let n = parseInt(m[1], 10); n <= parseInt(m[2], 10); n++) out.push(n);
    } else if (/^\d+$/.test(part)) {
      out.push(parseInt(part, 10));
    }
  }
  return out;
}

export function parsePagesAttrs(tag: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const m of tag.matchAll(/(\w+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'/>]+))/g)) {
    attrs[m[1].toLowerCase()] = m[2] ?? m[3] ?? m[4] ?? '';
  }
  return attrs;
}


export interface PageSelection {
  pages: number[];
  onlysection?: string;
  fromsection?: string;
  tosection?: string;
  unhandled: string[];
}

/** Work out which scan pages and sections a <pages> tag selects. */
export function selectPages(attrs: Record<string, string>, pageCount?: number): PageSelection {
  const set = new Set<number>();
  // ProofreadPage passes every attribute other than the content ones to the generated header box, so those cannot
  // change the text. Values it cannot interpret are reported.
  const unhandled: string[] = [];
  const num = (k: string): number | undefined => {
    if (attrs[k] === undefined || attrs[k] === '') return undefined;
    if (!/^\s*\d+\s*$/.test(attrs[k])) {
      unhandled.push(`${k}=${attrs[k]}`);
      return undefined;
    }
    return parseInt(attrs[k], 10);
  };
  const fromN = num('from');
  const toN = num('to');
  if (attrs.from !== undefined || attrs.to !== undefined) {
    // As in ProofreadPage: a missing `from` means the first page, a missing `to` the last page of the scan.
    const from = fromN ?? 1;
    let to = toN;
    if (to === undefined && attrs.to === undefined) {
      if (pageCount) to = pageCount;
      else unhandled.push('to (page count of the scan unknown)');
    }
    const step = Math.max(1, parseInt(attrs.step ?? '1', 10) || 1);
    if (to !== undefined && (fromN !== undefined || attrs.from === undefined)) {
      for (let n = from; n <= to; n += step) set.add(n);
    }
  }
  if (attrs.include) expandInclude(attrs.include).forEach((n) => set.add(n));
  if (attrs.exclude) expandInclude(attrs.exclude).forEach((n) => set.delete(n));
  return {
    pages: [...set].sort((a, b) => a - b),
    onlysection: attrs.onlysection || undefined,
    fromsection: attrs.fromsection || undefined,
    tosection: attrs.tosection || undefined,
    unhandled,
  };
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Turn "## name ##" section lines into <section begin/end> tags (each marker ends the previous section). */
export function normalizeSections(t: string): string {
  if (!/^##\s*[^#\n]+?\s*##\s*$/m.test(t)) return t;
  let open: string | null = null;
  const lines = t.split('\n').map((line) => {
    const m = /^##\s*([^#\n]+?)\s*##\s*$/.exec(line);
    if (!m) return line;
    const out = (open ? `<section end="${open}" />` : '') + `<section begin="${m[1]}" />`;
    open = m[1];
    return out;
  });
  let s = lines.join('\n');
  if (open) s += `<section end="${open}" />`;
  return s;
}

// Section names are case-sensitive, as in labelled section transclusion; the tag and attribute names are not.
const secTag = (kind: 'begin' | 'end', name: string, flags = '') =>
  new RegExp(
    `<[Ss][Ee][Cc][Tt][Ii][Oo][Nn]\\s+${kind.replace(/./g, (c) => `[${c}${c.toUpperCase()}]`)}\\s*=\\s*` +
      `(?:"${escapeRegExp(name)}"|'${escapeRegExp(name)}'|${escapeRegExp(name)}(?=[\\s/>]))\\s*/?>`,
    flags,
  );

/** Rule 1 section selection on one page. */
export function selectSection(t: string, sel: { only?: string; from?: string; to?: string }): string {
  if (sel.only) {
    // Every begin..end pair with this name, joined, as labelled section transclusion does.
    const parts: string[] = [];
    let rest = t;
    for (;;) {
      const b = secTag('begin', sel.only).exec(rest);
      if (!b) break;
      rest = rest.slice(b.index + b[0].length);
      const e = secTag('end', sel.only).exec(rest);
      if (!e) {
        parts.push(rest);
        break;
      }
      parts.push(rest.slice(0, e.index));
      rest = rest.slice(e.index + e[0].length);
    }
    return parts.join('\n');
  }
  if (sel.from) {
    const b = secTag('begin', sel.from).exec(t);
    t = b ? t.slice(b.index) : '';
  }
  if (sel.to) {
    const e = secTag('end', sel.to).exec(t);
    t = e ? t.slice(0, e.index + e[0].length) : t;
  }
  return t;
}

/** Templates that produce no countable text. */
const DROP_TEMPLATES = new Set([
  'nop', 'gap', 'dhr', 'dhr2', 'rule', 'custom rule', 'separator', 'anchor', 'anchor+', 'fi', 'fis', 'fit', 'fim',
  'missing image', 'ts', 'clear', 'clear left', 'clear right', '-', 'pb', 'pagebreak',
  'runningheader', 'rh', 'em', 'hwe', 'hyphenated word end', 'tiret2', 'astérisme', 'asterism', 'outdent', 'brace',
  'brace2', 'img float', 'pps2', 'defaultsort', 'header', 'license', 'pd-old', 'smallrefs', 'reflist',
]);
/** Formatting wrappers: the text is this unnamed argument (1-based), or the named `text`/`content` argument. */
const WRAPPERS: Record<string, number> = Object.fromEntries([
  ...['c', 'center', 'centre', 'sc', 'small-caps', 'smallcaps', 'small caps', 'larger', 'large', 'x-larger',
    'xx-larger', 'xxx-larger', 'smaller', 'small', 'x-smaller', 'xx-smaller', 'uc', 'lc', 'di', 'dropinitial',
    'drop initial', 'bold', 'b', 'i', 'italic', 'fine', 'fine block', 't1', 't2', 't3', 't4', 't5', 't6', 'fs70',
    'fs75', 'fs80', 'fs85', 'fs90', 'fs95', 'fs110', 'fs115', 'fs120', 'fs125', 'hi', 'hi/s', 'hanging indent', 'sp',
    'spaced', 'nowrap', 'nobr', 'u', 'underline', 'overline', 'block center', 'block centre', 'block left', 'ppoem',
    'left', 'right block', 'smaller block', 'larger block', 'x-larger block', 'sup', 'sub', 'ditto', 'sic', 'lps',
    'gothic', 'blackletter', 'red', 'span', 'indent', 'quote', 'blockquote', 'cl-act-h', 'csc', 'roman',
    'float right', 'right', 'li', 'largeinitial', 'large initial'].map((n) => [n, 1]),
  ['dent', 3],
  ...['lang', 'hws', 'hyphenated word start', 'tiret', 'font-size', 'fs', 'color', 'pad', 'letter-spacing', 'ls'].map((n) => [n, 2]),
]);
/** Templates that stand for a fixed piece of text. */
const LITERAL: Record<string, string> = {
  "'": "'", '"': '"', longdash: '—', 'long dash': '—', '—': '—', 'em dash': '—', mdash: '—', 'en dash': '–',
  ndash: '–', '...': '...', '…': '…', mme: 'Mme', mlle: 'Mlle', mmes: 'Mmes', mlles: 'Mlles', mgr: 'Mgr',
  ier: 'Ier', 'm.': 'M.', 'mm.': 'MM.', '!': '|', '=': '=',
};
/** Templates whose unnamed arguments are all shown, joined by spaces. */
const JOIN = new Set(['roi', 'souverain', 'pape', 'empereur']);
/** Named parameters that format or place things; any other `key=` inside a template is treated as text. */
const OPTION_PARAMS = new Set([
  'style', 'class', 'width', 'height', 'align', 'float', 'size', 'lang', 'dir', 'id', 'file', 'image', 'caption',
  'alt', 'link', 'upright', 'start', 'end', 'margin', 'indent', 'top', 'bottom', 'left', 'right', 'font', 'color',
  'colour', 'display', 'type', 'title', 'cstyle', 'tstyle', 'pstyle', 'imgstyle', 'max-width', 'line-height', 'pad',
  'padding', 'pos', 'position', 'num', 'anchor', 'border', 'brace', 'sep', 'name', 'format', 'mode', 'source', 'ref',
]);
/** Tags whose content is not text. */
const DROP_TAG_CONTENT = /<(math|score|syntaxhighlight|timeline|graph|chem|ce|templatestyles|mapframe|gallery)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;

// Output of an inner template is shielded so its "|" and "=" can't split or rename the outer template's arguments.
const PIPE = '\u0001';
const EQ = '\u0002';
const shield = (s: string) => s.replace(/\|/g, PIPE).replace(/=/g, EQ);
const unshield = (s: string) => s.replace(/\u0001/g, '|').replace(/\u0002/g, '=');

function splitArgs(inner: string): { name: string; unnamed: string[]; text?: string } {
  const parts = inner.split('|');
  let name = parts[0].trim().replace(/_/g, ' ').toLowerCase().replace(/^template:/, '');
  if (name.startsWith('#')) name = name.split(':')[0]; // parser function: report "#if", not its condition
  const unnamed: string[] = [];
  let text: string | undefined;
  for (const p of parts.slice(1)) {
    const m = /^\s*([^=]{1,40}?)\s*=([\s\S]*)$/.exec(p);
    if (m) {
      const key = m[1].toLowerCase();
      if (/^\d+$/.test(key)) unnamed[parseInt(key, 10) - 1] = m[2];
      else if (key === 'text' || key === 'content') text = m[2];
      else if (!OPTION_PARAMS.has(key)) unnamed.push(p); // "E=mc" is text, not a parameter
      continue;
    }
    unnamed.push(p);
  }
  return { name, unnamed: unnamed.filter((x) => x !== undefined), text };
}

/** Rule 5: reduce every template, innermost first. Unknown template names are added to `unknown`. */
export function reduceTemplates(t: string, unknown: Set<string>): string {
  const inner = /\{\{(?!\{)((?:(?!\{\{|\}\})[\s\S])*?)\}\}/g;
  for (let guard = 0; guard < 50 && t.includes('{{'); guard++) {
    const before = t;
    t = t.replace(inner, (_m, body: string) => {
      const { name, unnamed, text } = splitArgs(body);
      let out: string;
      if (DROP_TEMPLATES.has(name) || /\/(s|e|start|end)$/.test(name)) out = '';
      else if (name in LITERAL) out = LITERAL[name];
      else if (JOIN.has(name)) out = unnamed.join(' ');
      else if (name in WRAPPERS) out = unnamed[WRAPPERS[name] - 1] ?? text ?? unnamed[0] ?? '';
      else {
        // Unknown: keep the longest argument (the text, rather than a size, side or flag), and report it.
        unknown.add(name);
        out = text ?? unnamed.reduce((a, b) => (b.trim().length > a.trim().length ? b : a), '');
      }
      return shield(out);
    });
    if (t === before) break;
  }
  return unshield(t);
}

const DROP_LINE_TEMPLATES = new Set(['c', 'center', 'centre', 'smaller', 'float right', 'right']);

/** True if the whole line is one centred/right-aligned template (or one [[File:]] link) and nothing else. */
export function isDropLine(line: string): boolean {
  const s = line.trim();
  const open = s.startsWith('{{') ? '{{' : s.startsWith('[[') ? '[[' : '';
  if (!open) return false;
  const close = open === '{{' ? '}}' : ']]';
  let depth = 0;
  for (let i = 0; i < s.length - 1; i++) {
    const two = s.slice(i, i + 2);
    if (two === open) {
      depth++;
      i++;
    } else if (two === close) {
      depth--;
      i++;
      if (depth === 0) {
        if (s.slice(i + 1).trim() !== '') return false; // the first block closes before the end of the line
        break;
      }
    }
  }
  if (depth !== 0) return false;
  if (open === '[[') return /^\[\[\s*(file|image)\s*:/i.test(s);
  const name = /^\{\{\s*([^|}]+?)\s*[|}]/.exec(s)?.[1].toLowerCase().replace(/_/g, ' ') ?? '';
  return DROP_LINE_TEMPLATES.has(name) && s.includes('|');
}

/** Templates that add no text; ignored when deciding whether a line is only a title or caption. */
const NO_TEXT = /\{\{\s*(?:nop|dhr|dhr2|gap|clear|anchor)\s*(?:\|[^{}]*)?\}\}/gi;

/**
 * A {{float right}}/{{right}} block at the very end of a line (no <br> after it) is a signature or date, as at the
 * foot of a letter or story: drop it. Elsewhere (e.g. verse refrains followed by <br>) it is kept as text.
 */
export function dropTrailingRight(line: string): string {
  const m = /\{\{\s*(?:float right|right)\s*\|/i.exec(line);
  if (!m) return line;
  // find the start of the last right-aligned template on the line and check it closes exactly at the end
  let start = -1;
  for (const mm of line.matchAll(/\{\{\s*(?:float right|right)\s*\|/gi)) start = mm.index;
  let depth = 0;
  for (let i = start; i < line.length - 1; i++) {
    const two = line.slice(i, i + 2);
    if (two === '{{') {
      depth++;
      i++;
    } else if (two === '}}') {
      depth--;
      i++;
      if (depth === 0) return line.slice(i + 1).trim() === '' ? line.slice(0, start) : line;
    }
  }
  return line;
}

/** Split text into lines, telling which are inside <poem>...</poem>. */
function linesWithPoem(t: string): Array<{ line: string; poem: boolean }> {
  let inPoem = false;
  return t.split('\n').map((line) => {
    const startsIn = inPoem;
    const opens = (line.match(/<poem\b/gi) ?? []).length;
    const closes = (line.match(/<\/poem\s*>/gi) ?? []).length;
    if (opens > closes) inPoem = true;
    else if (closes > opens) inPoem = false;
    return { line, poem: startsIn || opens > 0 };
  });
}

/** Rules 2 (extract) and 3-6 for one page's selected text. Returns body text and footnote text. */
export function cleanText(t: string, unknown: Set<string>): { body: string; notes: string } {
  const notes: string[] = [];
  // Title/caption lines go first, so a footnote attached to one is dropped with it.
  // Title/caption lines are never taken from inside <poem>, where centred or right-aligned lines are verse.
  t = linesWithPoem(t)
    .filter(({ line, poem }) => poem || !isDropLine(line.replace(/<ref\b[^>]*\/>|<ref\b[^>]*>[\s\S]*?<\/ref\s*>/gi, '').replace(NO_TEXT, '')))
    .map(({ line, poem }) => (poem ? line : dropTrailingRight(line)))
    .join('\n');
  t = t.replace(/<ref\b[^>]*\/>/gi, '');
  t = t.replace(/<ref\b[^>]*>([\s\S]*?)<\/ref\s*>/gi, (_m, n: string) => {
    notes.push(n);
    return ' ';
  });
  t = t.replace(/<references\b[^>]*\/>|<references\b[^>]*>[\s\S]*?<\/references\s*>/gi, '');
  const run = (s: string) => {
    s = s.replace(DROP_TAG_CONTENT, ' ');
    s = reduceLinks(s);
    s = reduceTemplates(s, unknown);
    s = reduceTables(s);
    s = s.replace(/<br\s*\/?>/gi, ' ').replace(/<\/?[a-zA-Z][^>]*>/g, ' ');
    s = s.replace(/'''''|'''|''/g, '');
    return decodeEntities(s);
  };
  return { body: run(t), notes: run(notes.join('\n')) };
}

/** Rule 4: links show the text MediaWiki would show. */
export function reduceLinks(t: string): string {
  for (let guard = 0; guard < 10 && t.includes('[['); guard++) {
    const before = t;
    t = t.replace(/\[\[([^\[\]]*)\]\]/g, (_m, body: string) => {
      const bar = body.indexOf('|');
      const target = (bar < 0 ? body : body.slice(0, bar)).trim();
      // [[File:]], [[Image:]], [[Category:]] are not text; a leading colon ([[:Category:X]]) makes it a visible link.
      if (/^\s*(file|image|category|media)\s*:/i.test(target)) return '';
      if (bar < 0) return target.replace(/^:/, '');
      const label = body.slice(bar + 1);
      if (label.trim() === '') {
        // pipe trick: [[w:Foo (bar)|]] shows "Foo"
        return target.replace(/^:/, '').replace(/^[^:]*:/, '').replace(/\s*\([^)]*\)\s*$/, '');
      }
      return label.trim(); // [[a|b|c]] shows "b|c"
    });
    if (t === before) break;
  }
  return t.replace(/\[(?:https?:)?\/\/[^\s\]]+(?:\s+([^\]]*))?\]/g, (_m, text?: string) => text ?? '');
}

/** Reduce wiki table markup to cell text. */
export function reduceTables(t: string): string {
  return t
    .split('\n')
    .map((line) => {
      const s = line.trim();
      if (/^\{\||^\|\}|^\|-|^\|\+/.test(s)) return s.startsWith('|+') ? s.slice(2) : '';
      if (/^[|!]/.test(s)) {
        return s
          .slice(1)
          .split(/\|\||!!/)
          .map((cell) => {
            const i = cell.indexOf('|');
            return i >= 0 && /=/.test(cell.slice(0, i)) ? cell.slice(i + 1) : cell;
          })
          .join(' ');
      }
      return line;
    })
    .join('\n');
}

const ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', thinsp: ' ', ensp: ' ', emsp: ' ', hairsp: ' ',
  mdash: '—', ndash: '–', hellip: '…', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', shy: '', zwj: '', zwnj: '',
  middot: '·', deg: '°', para: '¶', sect: '§', dagger: '†', Dagger: '‡', laquo: '«', raquo: '»', minus: '−',
};
export function decodeEntities(t: string): string {
  return t.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e] ?? ENTITIES[e.toLowerCase()] ?? m;
  });
}

/** Rule 7. Zero-width spaces count as spaces. */
export function countWords(text: string): number {
  return text.split(/[\s​—–]+/u).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
}

/** Scripts written without spaces between words, which this whitespace-based count cannot measure. */
export const SPACELESS_SCRIPT =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}\p{Script=Tibetan}]/u;

/** All per-page rules for one Page: page, used by `count` and by tests. */
export function pageText(
  wikitext: string,
  sel: { only?: string; from?: string; to?: string } | string | undefined,
  unknown: Set<string> = new Set(),
): { body: string; notes: string } {
  const s = typeof sel === 'string' ? { only: sel } : (sel ?? {});
  let t = wikitext.replace(/<noinclude>[\s\S]*?<\/noinclude>/gi, '').replace(/<!--[\s\S]*?-->/g, '');
  t = normalizeSections(t);
  t = selectSection(t, s);
  t = t.replace(/<section\b[^>]*\/?>/gi, '');
  return cleanText(t, unknown);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const isNode = typeof process !== 'undefined' && !!process.versions?.node;

async function apiGet(api: string, params: Record<string, string>, opts: Options): Promise<any> {
  const f = opts.fetch ?? fetch;
  const q = new URLSearchParams({ ...params, format: 'json', formatversion: '2', maxlag: '5', origin: '*' });
  const ua = opts.userAgent ?? `${METHOD}/${VERSION}`;
  const headers: Record<string, string> = { 'Api-User-Agent': ua };
  if (isNode) headers['User-Agent'] = ua;
  for (let attempt = 0; attempt < 6; attempt++) {
    const res = await f(`${api}?${q}`, { headers });
    if (res.status === 429 || res.status === 503) {
      await sleep(5000 * (attempt + 1));
      continue;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${api}`);
    const data = await res.json();
    if (data?.error?.code === 'maxlag') {
      await sleep(5000 * (attempt + 1));
      continue;
    }
    if (data?.error) throw new Error(`API error: ${data.error.code}: ${data.error.info}`);
    return data;
  }
  throw new Error('still throttled after 6 attempts');
}

interface PageRev {
  content: string;
  revid: number;
  timestamp: string;
}

async function wikitexts(api: string, titles: string[], opts: Options): Promise<Map<string, PageRev>> {
  const out = new Map<string, PageRev>();
  for (let i = 0; i < titles.length; i += 50) {
    const batch = titles.slice(i, i + 50);
    const r = await apiGet(api, { action: 'query', prop: 'revisions', rvprop: 'content|ids|timestamp', rvslots: 'main', titles: batch.join('|') }, opts);
    const norm = new Map<string, string>((r.query.normalized ?? []).map((n: any) => [n.to, n.from]));
    for (const p of r.query.pages) {
      const rv = p.revisions?.[0];
      const content = rv?.slots?.main?.content;
      if (content !== undefined) out.set(norm.get(p.title) ?? p.title, { content, revid: rv.revid, timestamp: rv.timestamp });
    }
    if (i + 50 < titles.length) await sleep(1000);
  }
  return out;
}

/** Number of pages in a multi-page scan (DjVu/PDF), for a <pages> tag with `from` but no `to`. */
async function scanPageCount(api: string, index: string, opts: Options): Promise<number | undefined> {
  const r = await apiGet(api, { action: 'query', prop: 'imageinfo', iiprop: 'size', titles: `File:${index}` }, opts);
  const n = r.query.pages?.[0]?.imageinfo?.[0]?.pagecount;
  return typeof n === 'number' ? n : undefined;
}

async function sha256(text: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Count the words of one work, given a Wikisource URL or page title. */
export async function count(target: string, opts: Options = {}): Promise<CountResult | CountError> {
  const { api, title } = parseTarget(target);
  if (!title) return { title: target, error: 'no page title in that URL' };
  const r = await apiGet(api, { action: 'query', prop: 'revisions', rvprop: 'content|ids|timestamp', rvslots: 'main', titles: title, redirects: '1' }, opts);
  const pg = r.query.pages[0];
  if (pg.missing !== undefined || pg.invalid !== undefined) return { title, error: 'page not found' };
  const main: string = pg.title;
  const rev = pg.revisions[0];
  const source = (rev.slots.main.content as string).replace(/<!--[\s\S]*?-->/g, '');
  const tags = [...source.matchAll(/<pages\b([^>]*?)\/?>/gi)].map((m) => m[1]);
  if (!tags.length) return { title: main, error: 'no <pages> tag on this page: the work is not transcluded from scan pages' };

  let body = '';
  let notes = '';
  let scanPages = 0;
  const unknown = new Set<string>();
  const badAttrs = new Set<string>();
  let latest: PageRev | undefined;
  for (const tag of tags) {
    const attrs = parsePagesAttrs(tag);
    if (!attrs.index) {
      badAttrs.add('(no index)');
      continue;
    }
    const needCount = attrs.from !== undefined && attrs.to === undefined;
    const sel = selectPages(attrs, needCount ? await scanPageCount(api, attrs.index, opts) : undefined);
    sel.unhandled.forEach((a) => badAttrs.add(a));
    const names = sel.pages.map((n) => `Page:${attrs.index}/${n}`);
    const texts = await wikitexts(api, names, opts);
    names.forEach((name, i) => {
      const s = {
        only: sel.onlysection,
        from: i === 0 ? sel.fromsection : undefined,
        to: i === names.length - 1 ? sel.tosection : undefined,
      };
      const pr = texts.get(name);
      if (pr && (!latest || pr.timestamp > latest.timestamp)) latest = pr;
      const pt = pageText(pr?.content ?? '', s, unknown);
      body += '\n' + pt.body;
      notes += '\n' + pt.notes;
      scanPages++;
    });
  }
  const footnoteWords = countWords(notes);
  const warnings: string[] = [];
  if (SPACELESS_SCRIPT.test(body + notes)) warnings.push('text in a script written without spaces (e.g. Chinese, Japanese, Thai): the count is not meaningful');
  const host = new URL(api).hostname;
  return {
    title: main,
    url: `https://${host}/wiki/${encodeURI(main.replace(/ /g, '_'))}`,
    words: countWords(body) + footnoteWords,
    footnoteWords,
    status: unknown.size || badAttrs.size || warnings.length ? 'unchecked' : 'ok',
    unhandledTemplates: [...unknown].sort(),
    unhandledAttributes: [...badAttrs].sort(),
    warnings,
    scanPages,
    revision: rev.revid,
    revisionTimestamp: rev.timestamp,
    scanPagesLatestEdit: latest?.timestamp ?? '',
    textSha256: await sha256(body + '\u0000' + notes),
    method: METHOD,
    version: VERSION,
    rules: RULES,
  };
}

export function isError(r: CountResult | CountError): r is CountError {
  return (r as CountError).error !== undefined;
}

/** One-paragraph plain-text summary, shared by the CLI, web page and gadget. */
export function formatResult(r: CountResult | CountError): string {
  if (isError(r)) return `${r.title}: ERROR - ${r.error}`;
  const fn = r.footnoteWords ? `, of which ${r.footnoteWords.toLocaleString('en-US')} in footnotes` : '';
  let s =
    `${r.title}\n  ${r.words.toLocaleString('en-US')} words${fn}  (${r.status}; ${r.scanPages} scan pages; ` +
    `work page revision ${r.revision}; scan pages last edited ${r.scanPagesLatestEdit})\n  method: ${r.method} ${r.version}`;
  if (r.unhandledTemplates.length) s += `\n  UNHANDLED TEMPLATES: ${r.unhandledTemplates.join(', ')}`;
  if (r.unhandledAttributes.length) s += `\n  UNHANDLED <pages> ATTRIBUTES: ${r.unhandledAttributes.join(', ')}`;
  for (const w of r.warnings) s += `\n  WARNING: ${w}`;
  return s;
}
