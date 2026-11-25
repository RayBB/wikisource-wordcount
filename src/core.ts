/**
 * wikisource-wordcount core: a deterministic word count for a Wikisource work that is transcluded from scan pages
 * with ProofreadPage's <pages> tag. Runs anywhere `fetch` exists (Node 18+, browsers, Wikisource gadgets).
 *
 * Rules (applied to the wikitext of every transcluded Page: page, in order):
 *  1. Keep only the text between <section begin="S" /> and <section end="S" /> (S = onlysection), or the whole page
 *     body if the <pages> tag has no onlysection. Drop everything inside <noinclude>...</noinclude>.
 *  2. Drop whole lines that are only a centred or right-aligned block ({{c}}, {{center}}, {{right}}, {{float right}},
 *     {{smaller}}) - title, byline, signature, illustrator credit, captions, "Continued" notes - and image lines
 *     ({{FI}}, {{missing image}}, [[File:...]]).
 *  3. Unwrap formatting templates to their text: {{hws|a|b}} -> b, {{hwe|...}} -> "", {{sc|x}}, {{di|x}},
 *     {{larger|x}}, {{smaller|x}} -> x, {{gap}}, {{nop}}, {{dhr}} -> "", {{'}} -> ', {{SIC|a|b}} -> a,
 *     "{{block center|" -> "", {{float right|...}} / {{right|...}} anywhere (signatures) -> ""; strip '' and '''
 *     and <poem> tags. Any other template left over is reported and the count is marked "unchecked".
 *  4. Count words: split on whitespace and em/en dashes; a token is a word if it contains a letter or digit.
 *     So hyphenated compounds and contractions are one word; dashes and ". . ." are not words.
 */

export const METHOD = 'wikisource-wordcount';
export const VERSION = '1.0';
export const RULES =
  'section text only; centred/right-aligned blocks, images and noinclude dropped; ' +
  'words split on whitespace and em/en dashes; a word contains a letter or digit';

export interface CountResult {
  title: string;
  url: string;
  words: number;
  status: 'ok' | 'unchecked';
  unhandledTemplates: string[];
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

export function expandInclude(spec: string): number[] {
  const out: number[] = [];
  for (const raw of spec.split(',')) {
    const part = raw.trim();
    if (!part) continue;
    if (part.includes('-')) {
      const [a, b] = part.split('-').map((x) => parseInt(x, 10));
      for (let n = a; n <= b; n++) out.push(n);
    } else {
      out.push(parseInt(part, 10));
    }
  }
  return out;
}

export function parsePagesAttrs(tag: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const m of tag.matchAll(/(\w+)=(?:"([^"]*)"|([^\s"/>]+))/g)) {
    attrs[m[1]] = m[2] !== undefined && m[2] !== '' ? m[2] : (m[3] ?? '');
  }
  return attrs;
}

const UNWRAP: Array<[RegExp, string]> = [
  [/\{\{hws\|[^|}]*\|([^}]*)\}\}/g, '$1'],
  [/\{\{hwe\|[^}]*\}\}/g, ''],
  [/\{\{(?:sc|small-caps|di|dropinitial|larger|smaller|x-larger|uc|lc)\|([^{}]*)\}\}/g, '$1'],
  [/\{\{SIC\|([^|}]*)(\|[^}]*)?\}\}/g, '$1'],
  [/\{\{gap(\|[^}]*)?\}\}/g, ' '],
  [/\{\{nop\}\}/g, ''],
  [/\{\{block center\|/g, ''],
  [/\{\{(?:float right|right)\|[^{}]*\}\}/g, ''],
  [/\{\{dhr(\|[^}]*)?\}\}/g, ''],
  [/\{\{'\}\}/g, "'"],
  [/<\/?poem>/g, '\n'],
  [/'''''|'''|''/g, ''],
  [/<br\s*\/?>/g, ' '],
];

const DROP_LINE =
  /^\s*(\{\{(?:c|center|FI|missing image|smaller|float right|right)\|.*\}\}|\[\[(?:File|Image):.*\]\])\s*$/i;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Apply rules 1-3 to one Page: page's wikitext. */
export function pageText(wikitext: string, section: string | undefined): string {
  let t = wikitext.replace(/<noinclude>[\s\S]*?<\/noinclude>/g, '');
  if (section) {
    const s = escapeRegExp(section);
    const m = new RegExp(`<section begin="${s}"\\s*/>([\\s\\S]*?)<section end="${s}"\\s*/>`).exec(t);
    t = m ? m[1] : '';
  }
  t = t.replace(/<section[^>]*\/>/g, '');
  t = t
    .split('\n')
    .filter((line) => !DROP_LINE.test(line))
    .join('\n');
  for (let pass = 0; pass < 3; pass++) {
    for (const [re, rep] of UNWRAP) t = t.replace(re, rep);
  }
  return t;
}

/** Rule 4. */
export function countWords(text: string): number {
  return text.split(/[\s—–]+/).filter((w) => /[A-Za-z0-9]/.test(w)).length;
}

export function leftoverTemplates(text: string): string[] {
  return [...text.matchAll(/\{\{[^}|]*/g)].map((m) => m[0]);
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
  const tags = [...(rev.slots.main.content as string).matchAll(/<pages([^>]*)\/>/g)].map((m) => m[1]);
  if (!tags.length) return { title: main, error: 'no <pages> tag on this page: the work is not transcluded from scan pages' };

  let text = '';
  let scanPages = 0;
  const leftovers = new Set<string>();
  for (const tag of tags) {
    const attrs = parsePagesAttrs(tag);
    const section = attrs.onlysection || undefined;
    const nums = attrs.include ? expandInclude(attrs.include) : expandInclude(`${attrs.from}-${attrs.to}`);
    const names = nums.map((n) => `Page:${attrs.index}/${n}`);
    const texts = await wikitexts(api, names, opts);
    for (const name of names) {
      const pt = pageText(texts.get(name) ?? '', section);
      leftoverTemplates(pt).forEach((x) => leftovers.add(x));
      text += '\n' + pt;
      scanPages++;
    }
  }
  const host = new URL(api).hostname;
  return {
    title: main,
    url: `https://${host}/wiki/${encodeURI(main.replace(/ /g, '_'))}`,
    words: countWords(text),
    status: leftovers.size ? 'unchecked' : 'ok',
    unhandledTemplates: [...leftovers].sort(),
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
  let s =
    `${r.title}\n  ${r.words.toLocaleString('en-US')} words  (${r.status}; ${r.scanPages} scan pages; ` +
    `revision ${r.revision} of ${r.revisionTimestamp})\n  method: ${r.method} ${r.version}`;
  if (r.unhandledTemplates.length) s += `\n  UNHANDLED TEMPLATES: ${r.unhandledTemplates.join(', ')}`;
  return s;
}
