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
  /** <pages> attributes the tool does not understand (each makes the result "unchecked"). */
  unhandledAttributes: string[];
  scanPages: number;
  revision: number;
  revisionTimestamp: string;
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

/** <pages> attributes that choose the text. */
const CONTENT_ATTRS = new Set(['index', 'from', 'to', 'step', 'include', 'exclude', 'onlysection', 'fromsection', 'tosection']);

export interface PageSelection {
  pages: number[];
  onlysection?: string;
  fromsection?: string;
  tosection?: string;
  unhandled: string[];
}

/** Work out which scan pages and sections a <pages> tag selects. */
export function selectPages(attrs: Record<string, string>): PageSelection {
  const set = new Set<number>();
  if (attrs.from || attrs.to) {
    const from = parseInt(attrs.from ?? attrs.to, 10);
    const to = parseInt(attrs.to ?? attrs.from, 10);
    const step = Math.max(1, parseInt(attrs.step ?? '1', 10) || 1);
    for (let n = from; n <= to; n += step) set.add(n);
  }
  if (attrs.include) expandInclude(attrs.include).forEach((n) => set.add(n));
  if (attrs.exclude) expandInclude(attrs.exclude).forEach((n) => set.delete(n));
  // ProofreadPage passes every other attribute to the generated header box, so it cannot change the text.
  const unhandled: string[] = [];
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

const secTag = (kind: 'begin' | 'end', name: string) =>
  new RegExp(`<section\\s+${kind}\\s*=\\s*(?:"${escapeRegExp(name)}"|'${escapeRegExp(name)}'|${escapeRegExp(name)})\\s*/?>`, 'i');

/** Rule 1 section selection on one page. */
export function selectSection(t: string, sel: { only?: string; from?: string; to?: string }): string {
  if (sel.only) {
    const b = secTag('begin', sel.only).exec(t);
    if (!b) return '';
    const rest = t.slice(b.index + b[0].length);
    const e = secTag('end', sel.only).exec(rest);
    return e ? rest.slice(0, e.index) : rest;
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
  'missing image', 'float right', 'right', 'ts', 'clear', 'clear left', 'clear right', '-', 'pb', 'pagebreak',
  'runningheader', 'rh', 'em', 'hwe', 'hyphenated word end', 'tiret2', 'astérisme', 'asterism', 'outdent', 'brace',
  'brace2', 'img float', 'ppoem/end', 'pps2', 'defaultsort', 'header', 'license', 'pd-old', 'smallrefs', 'reflist',
]);
/** Templates whose single text argument is kept (formatting wrappers). Arg index is 1-based among unnamed args. */
const WRAPPERS: Record<string, number> = Object.fromEntries([
  ...['c', 'center', 'centre', 'sc', 'small-caps', 'smallcaps', 'larger', 'large', 'x-larger', 'xx-larger',
    'xxx-larger', 'smaller', 'small', 'x-smaller', 'xx-smaller', 'uc', 'lc', 'di', 'dropinitial', 'drop initial',
    'bold', 'b', 'i', 'italic', 'fine', 't1', 't2', 't3', 't4', 't5', 't6', 'fine block', 'fs70', 'fs75', 'fs80', 'fs85', 'fs90', 'fs95', 'fs110',
    'fs115', 'fs120', 'fs125', 'hi', 'hanging indent', 'sp', 'spaced', 'nowrap', 'u', 'underline', 'overline',
    'block center', 'block centre', 'ppoem', 'left', 'right block', 'smaller block', 'larger block', 'x-larger block',
    'fs', 'font-size', 'sup', 'sub', 'ditto', 'sic', 'lps', 'hi/s', 'gothic', 'blackletter', 'red', 'color',
    'nobr', 'span', 'block left', 'indent', 'pad', 'em dash', 'quote', 'blockquote', 'small caps', 'ls',
    'letter-spacing', 'hws', 'hyphenated word start', 'tiret', 'cl-act-h', 'csc', 'roman'].map((n) => [n, 1]),
  ['lang', 2], ['hws', 2], ['hyphenated word start', 2], ['tiret', 2], ['font-size', 2], ['fs', 2], ['color', 2],
  ['red', 1], ['pad', 2], ['letter-spacing', 2], ['ls', 2],
]);
/** Templates that stand for a fixed piece of text. */
const LITERAL: Record<string, string> = {
  "'": "'", '"': '"', longdash: '—', '—': '—', 'em dash': '—', 'en dash': '–', ndash: '–', mdash: '—', '...': '...', '…': '…',
  'long dash': '—', mme: 'Mme', mlle: 'Mlle', mmes: 'Mmes', mlles: 'Mlles', mgr: 'Mgr', 'ier': 'Ier', '!': '|',
  '=': '=',
};
/** Tags whose content is not text. */
const DROP_TAG_CONTENT = /<(math|score|syntaxhighlight|timeline|graph|chem|ce|templatestyles|mapframe|gallery)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;

function splitArgs(inner: string): { name: string; unnamed: string[] } {
  const parts = inner.split('|');
  const name = parts[0].trim().replace(/_/g, ' ').toLowerCase().replace(/^template:/, '');
  const unnamed: string[] = [];
  for (const p of parts.slice(1)) {
    if (/^\s*[\w -]+\s*=/.test(p) && !/^\s*\d+\s*=/.test(p)) continue; // named argument
    unnamed.push(p.replace(/^\s*\d+\s*=/, ''));
  }
  return { name, unnamed };
}

/** Rule 5: reduce every template, innermost first. Unknown template names are added to `unknown`. */
export function reduceTemplates(t: string, unknown: Set<string>): string {
  const inner = /\{\{(?!\{)((?:(?!\{\{|\}\})[\s\S])*?)\}\}/g;
  for (let guard = 0; guard < 50 && t.includes('{{'); guard++) {
    const before = t;
    t = t.replace(inner, (_m, body: string) => {
      const { name, unnamed } = splitArgs(body);
      if (DROP_TEMPLATES.has(name) || /\/(s|e|start|end)$/.test(name)) return '';
      if (name in LITERAL) return LITERAL[name];
      if (name in WRAPPERS) return unnamed[WRAPPERS[name] - 1] ?? unnamed[0] ?? '';
      unknown.add(name);
      return unnamed[0] ?? '';
    });
    if (t === before) break;
  }
  return t;
}

const balanced = (line: string) => (line.match(/\{\{/g) ?? []).length === (line.match(/\}\}/g) ?? []).length;

const DROP_LINE = /^\s*(\{\{\s*(?:c|center|centre|smaller|float right|right)\s*\|.*\}\}|\[\[(?:File|Image):.*\]\])\s*$/i;

/** Rules 2 (extract) and 3-6 for one page's selected text. Returns body text and footnote text. */
export function cleanText(t: string, unknown: Set<string>): { body: string; notes: string } {
  const notes: string[] = [];
  t = t.replace(/<ref\b[^>]*\/>/gi, '');
  t = t.replace(/<ref\b[^>]*>([\s\S]*?)<\/ref\s*>/gi, (_m, n: string) => {
    notes.push(n);
    return ' ';
  });
  t = t.replace(/<references\b[^>]*\/>|<references\b[^>]*>[\s\S]*?<\/references\s*>/gi, '');
  const run = (s: string, dropLines: boolean) => {
    if (dropLines) s = s.split('\n').filter((line) => !(DROP_LINE.test(line) && balanced(line))).join('\n');
    s = s.replace(DROP_TAG_CONTENT, ' ');
    s = reduceLinks(s);
    s = reduceTemplates(s, unknown);
    s = reduceTables(s);
    s = s.replace(/<br\s*\/?>/gi, ' ').replace(/<\/?[a-zA-Z][^>]*>/g, ' ');
    s = s.replace(/'''''|'''|''/g, '');
    return decodeEntities(s);
  };
  return { body: run(t, true), notes: run(notes.join('\n'), false) };
}

/** Rule 4. */
export function reduceLinks(t: string): string {
  for (let guard = 0; guard < 10 && t.includes('[['); guard++) {
    const before = t;
    t = t.replace(/\[\[([^\[\]]*)\]\]/g, (_m, body: string) => {
      const target = body.split('|')[0].trim();
      if (/^:?\s*(file|image|category|media)\s*:/i.test(target)) return '';
      const parts = body.split('|');
      return (parts.length > 1 ? parts[parts.length - 1] : parts[0]).trim();
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

/** Rule 7. */
export function countWords(text: string): number {
  return text.split(/[\s—–]+/u).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
}

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

async function wikitexts(api: string, titles: string[], opts: Options): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (let i = 0; i < titles.length; i += 50) {
    const batch = titles.slice(i, i + 50);
    const r = await apiGet(api, { action: 'query', prop: 'revisions', rvprop: 'content', rvslots: 'main', titles: batch.join('|') }, opts);
    const norm = new Map<string, string>((r.query.normalized ?? []).map((n: any) => [n.to, n.from]));
    for (const p of r.query.pages) {
      const content = p.revisions?.[0]?.slots?.main?.content;
      if (content !== undefined) out.set(norm.get(p.title) ?? p.title, content);
    }
    if (i + 50 < titles.length) await sleep(1000);
  }
  return out;
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
  for (const tag of tags) {
    const attrs = parsePagesAttrs(tag);
    const sel = selectPages(attrs);
    sel.unhandled.forEach((a) => badAttrs.add(a));
    if (!attrs.index) {
      badAttrs.add('(no index)');
      continue;
    }
    const names = sel.pages.map((n) => `Page:${attrs.index}/${n}`);
    const texts = await wikitexts(api, names, opts);
    names.forEach((name, i) => {
      const s = {
        only: sel.onlysection,
        from: i === 0 ? sel.fromsection : undefined,
        to: i === names.length - 1 ? sel.tosection : undefined,
      };
      const pt = pageText(texts.get(name) ?? '', s, unknown);
      body += '\n' + pt.body;
      notes += '\n' + pt.notes;
      scanPages++;
    });
  }
  const footnoteWords = countWords(notes);
  const host = new URL(api).hostname;
  return {
    title: main,
    url: `https://${host}/wiki/${encodeURI(main.replace(/ /g, '_'))}`,
    words: countWords(body) + footnoteWords,
    footnoteWords,
    status: unknown.size || badAttrs.size ? 'unchecked' : 'ok',
    unhandledTemplates: [...unknown].sort(),
    unhandledAttributes: [...badAttrs].sort(),
    scanPages,
    revision: rev.revid,
    revisionTimestamp: rev.timestamp,
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
    `revision ${r.revision} of ${r.revisionTimestamp})\n  method: ${r.method} ${r.version}`;
  if (r.unhandledTemplates.length) s += `\n  UNHANDLED TEMPLATES: ${r.unhandledTemplates.join(', ')}`;
  if (r.unhandledAttributes.length) s += `\n  UNHANDLED <pages> ATTRIBUTES: ${r.unhandledAttributes.join(', ')}`;
  return s;
}
