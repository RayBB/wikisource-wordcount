#!/usr/bin/env node

// src/core.ts
var METHOD = "wikisource-wordcount";
var VERSION = "1.1";
var RULES = "pages/sections as the <pages> tag selects them (from, to, step, include, exclude, onlysection, fromsection, tosection); noinclude, comments, titles/bylines/captions (centred or right-aligned lines) and images dropped; footnotes counted and also reported separately; links, templates, HTML and entities reduced to their text; words split on whitespace and em/en dashes; a word contains a letter or digit";
var DEFAULT_API = "https://en.wikisource.org/w/api.php";
function parseTarget(arg) {
  const input = arg.trim();
  let u = null;
  try {
    u = new URL(input);
  } catch {
    u = null;
  }
  if (u && (u.protocol === "http:" || u.protocol === "https:") && u.hostname.endsWith("wikisource.org")) {
    const api = `https://${u.hostname}/w/api.php`;
    let title = "";
    if (u.pathname.startsWith("/wiki/")) {
      title = decodeURIComponent(u.pathname.slice("/wiki/".length));
    } else {
      title = u.searchParams.get("title") ?? "";
    }
    return { api, title: title.replace(/_/g, " ") };
  }
  return { api: DEFAULT_API, title: input.replace(/_/g, " ") };
}
function expandInclude(spec) {
  const out = [];
  for (const raw of spec.split(",")) {
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
function parsePagesAttrs(tag) {
  const attrs = {};
  for (const m of tag.matchAll(/(\w+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'/>]+))/g)) {
    attrs[m[1].toLowerCase()] = m[2] ?? m[3] ?? m[4] ?? "";
  }
  return attrs;
}
function selectPages(attrs) {
  const set = /* @__PURE__ */ new Set();
  if (attrs.from || attrs.to) {
    const from = parseInt(attrs.from ?? attrs.to, 10);
    const to = parseInt(attrs.to ?? attrs.from, 10);
    const step = Math.max(1, parseInt(attrs.step ?? "1", 10) || 1);
    for (let n = from; n <= to; n += step) set.add(n);
  }
  if (attrs.include) expandInclude(attrs.include).forEach((n) => set.add(n));
  if (attrs.exclude) expandInclude(attrs.exclude).forEach((n) => set.delete(n));
  const unhandled = [];
  return {
    pages: [...set].sort((a, b) => a - b),
    onlysection: attrs.onlysection || void 0,
    fromsection: attrs.fromsection || void 0,
    tosection: attrs.tosection || void 0,
    unhandled
  };
}
function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function normalizeSections(t) {
  if (!/^##\s*[^#\n]+?\s*##\s*$/m.test(t)) return t;
  let open = null;
  const lines = t.split("\n").map((line) => {
    const m = /^##\s*([^#\n]+?)\s*##\s*$/.exec(line);
    if (!m) return line;
    const out = (open ? `<section end="${open}" />` : "") + `<section begin="${m[1]}" />`;
    open = m[1];
    return out;
  });
  let s = lines.join("\n");
  if (open) s += `<section end="${open}" />`;
  return s;
}
var secTag = (kind, name) => new RegExp(`<section\\s+${kind}\\s*=\\s*(?:"${escapeRegExp(name)}"|'${escapeRegExp(name)}'|${escapeRegExp(name)})\\s*/?>`, "i");
function selectSection(t, sel) {
  if (sel.only) {
    const b = secTag("begin", sel.only).exec(t);
    if (!b) return "";
    const rest = t.slice(b.index + b[0].length);
    const e = secTag("end", sel.only).exec(rest);
    return e ? rest.slice(0, e.index) : rest;
  }
  if (sel.from) {
    const b = secTag("begin", sel.from).exec(t);
    t = b ? t.slice(b.index) : "";
  }
  if (sel.to) {
    const e = secTag("end", sel.to).exec(t);
    t = e ? t.slice(0, e.index + e[0].length) : t;
  }
  return t;
}
var DROP_TEMPLATES = /* @__PURE__ */ new Set([
  "nop",
  "gap",
  "dhr",
  "dhr2",
  "rule",
  "custom rule",
  "separator",
  "anchor",
  "anchor+",
  "fi",
  "fis",
  "fit",
  "fim",
  "missing image",
  "float right",
  "right",
  "ts",
  "clear",
  "clear left",
  "clear right",
  "-",
  "pb",
  "pagebreak",
  "runningheader",
  "rh",
  "em",
  "hwe",
  "hyphenated word end",
  "tiret2",
  "ast\xE9risme",
  "asterism",
  "outdent",
  "brace",
  "brace2",
  "img float",
  "ppoem/end",
  "pps2",
  "defaultsort",
  "header",
  "license",
  "pd-old",
  "smallrefs",
  "reflist"
]);
var WRAPPERS = Object.fromEntries([
  ...[
    "c",
    "center",
    "centre",
    "sc",
    "small-caps",
    "smallcaps",
    "larger",
    "large",
    "x-larger",
    "xx-larger",
    "xxx-larger",
    "smaller",
    "small",
    "x-smaller",
    "xx-smaller",
    "uc",
    "lc",
    "di",
    "dropinitial",
    "drop initial",
    "bold",
    "b",
    "i",
    "italic",
    "fine",
    "t1",
    "t2",
    "t3",
    "t4",
    "t5",
    "t6",
    "fine block",
    "fs70",
    "fs75",
    "fs80",
    "fs85",
    "fs90",
    "fs95",
    "fs110",
    "fs115",
    "fs120",
    "fs125",
    "hi",
    "hanging indent",
    "sp",
    "spaced",
    "nowrap",
    "u",
    "underline",
    "overline",
    "block center",
    "block centre",
    "ppoem",
    "left",
    "right block",
    "smaller block",
    "larger block",
    "x-larger block",
    "fs",
    "font-size",
    "sup",
    "sub",
    "ditto",
    "sic",
    "lps",
    "hi/s",
    "gothic",
    "blackletter",
    "red",
    "color",
    "nobr",
    "span",
    "block left",
    "indent",
    "pad",
    "em dash",
    "quote",
    "blockquote",
    "small caps",
    "ls",
    "letter-spacing",
    "hws",
    "hyphenated word start",
    "tiret",
    "cl-act-h",
    "csc",
    "roman"
  ].map((n) => [n, 1]),
  ["lang", 2],
  ["hws", 2],
  ["hyphenated word start", 2],
  ["tiret", 2],
  ["font-size", 2],
  ["fs", 2],
  ["color", 2],
  ["red", 1],
  ["pad", 2],
  ["letter-spacing", 2],
  ["ls", 2]
]);
var LITERAL = {
  "'": "'",
  '"': '"',
  longdash: "\u2014",
  "\u2014": "\u2014",
  "em dash": "\u2014",
  "en dash": "\u2013",
  ndash: "\u2013",
  mdash: "\u2014",
  "...": "...",
  "\u2026": "\u2026",
  "long dash": "\u2014",
  mme: "Mme",
  mlle: "Mlle",
  mmes: "Mmes",
  mlles: "Mlles",
  mgr: "Mgr",
  "ier": "Ier",
  "!": "|",
  "=": "="
};
var DROP_TAG_CONTENT = /<(math|score|syntaxhighlight|timeline|graph|chem|ce|templatestyles|mapframe|gallery)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;
function splitArgs(inner) {
  const parts = inner.split("|");
  const name = parts[0].trim().replace(/_/g, " ").toLowerCase().replace(/^template:/, "");
  const unnamed = [];
  for (const p of parts.slice(1)) {
    if (/^\s*[\w -]+\s*=/.test(p) && !/^\s*\d+\s*=/.test(p)) continue;
    unnamed.push(p.replace(/^\s*\d+\s*=/, ""));
  }
  return { name, unnamed };
}
function reduceTemplates(t, unknown) {
  const inner = /\{\{(?!\{)((?:(?!\{\{|\}\})[\s\S])*?)\}\}/g;
  for (let guard = 0; guard < 50 && t.includes("{{"); guard++) {
    const before = t;
    t = t.replace(inner, (_m, body) => {
      const { name, unnamed } = splitArgs(body);
      if (DROP_TEMPLATES.has(name) || /\/(s|e|start|end)$/.test(name)) return "";
      if (name in LITERAL) return LITERAL[name];
      if (name in WRAPPERS) return unnamed[WRAPPERS[name] - 1] ?? unnamed[0] ?? "";
      unknown.add(name);
      return unnamed[0] ?? "";
    });
    if (t === before) break;
  }
  return t;
}
var balanced = (line) => (line.match(/\{\{/g) ?? []).length === (line.match(/\}\}/g) ?? []).length;
var DROP_LINE = /^\s*(\{\{\s*(?:c|center|centre|smaller|float right|right)\s*\|.*\}\}|\[\[(?:File|Image):.*\]\])\s*$/i;
function cleanText(t, unknown) {
  const notes = [];
  t = t.replace(/<ref\b[^>]*\/>/gi, "");
  t = t.replace(/<ref\b[^>]*>([\s\S]*?)<\/ref\s*>/gi, (_m, n) => {
    notes.push(n);
    return " ";
  });
  t = t.replace(/<references\b[^>]*\/>|<references\b[^>]*>[\s\S]*?<\/references\s*>/gi, "");
  const run = (s, dropLines) => {
    if (dropLines) s = s.split("\n").filter((line) => !(DROP_LINE.test(line) && balanced(line))).join("\n");
    s = s.replace(DROP_TAG_CONTENT, " ");
    s = reduceLinks(s);
    s = reduceTemplates(s, unknown);
    s = reduceTables(s);
    s = s.replace(/<br\s*\/?>/gi, " ").replace(/<\/?[a-zA-Z][^>]*>/g, " ");
    s = s.replace(/'''''|'''|''/g, "");
    return decodeEntities(s);
  };
  return { body: run(t, true), notes: run(notes.join("\n"), false) };
}
function reduceLinks(t) {
  for (let guard = 0; guard < 10 && t.includes("[["); guard++) {
    const before = t;
    t = t.replace(/\[\[([^\[\]]*)\]\]/g, (_m, body) => {
      const target = body.split("|")[0].trim();
      if (/^:?\s*(file|image|category|media)\s*:/i.test(target)) return "";
      const parts = body.split("|");
      return (parts.length > 1 ? parts[parts.length - 1] : parts[0]).trim();
    });
    if (t === before) break;
  }
  return t.replace(/\[(?:https?:)?\/\/[^\s\]]+(?:\s+([^\]]*))?\]/g, (_m, text) => text ?? "");
}
function reduceTables(t) {
  return t.split("\n").map((line) => {
    const s = line.trim();
    if (/^\{\||^\|\}|^\|-|^\|\+/.test(s)) return s.startsWith("|+") ? s.slice(2) : "";
    if (/^[|!]/.test(s)) {
      return s.slice(1).split(/\|\||!!/).map((cell) => {
        const i = cell.indexOf("|");
        return i >= 0 && /=/.test(cell.slice(0, i)) ? cell.slice(i + 1) : cell;
      }).join(" ");
    }
    return line;
  }).join("\n");
}
var ENTITIES = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  thinsp: " ",
  ensp: " ",
  emsp: " ",
  hairsp: " ",
  mdash: "\u2014",
  ndash: "\u2013",
  hellip: "\u2026",
  lsquo: "\u2018",
  rsquo: "\u2019",
  ldquo: "\u201C",
  rdquo: "\u201D",
  shy: "",
  zwj: "",
  zwnj: "",
  middot: "\xB7",
  deg: "\xB0",
  para: "\xB6",
  sect: "\xA7",
  dagger: "\u2020",
  Dagger: "\u2021",
  laquo: "\xAB",
  raquo: "\xBB",
  minus: "\u2212"
};
function decodeEntities(t) {
  return t.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === "#") {
      const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e] ?? ENTITIES[e.toLowerCase()] ?? m;
  });
}
function countWords(text) {
  return text.split(/[\s—–]+/u).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
}
function pageText(wikitext, sel, unknown = /* @__PURE__ */ new Set()) {
  const s = typeof sel === "string" ? { only: sel } : sel ?? {};
  let t = wikitext.replace(/<noinclude>[\s\S]*?<\/noinclude>/gi, "").replace(/<!--[\s\S]*?-->/g, "");
  t = normalizeSections(t);
  t = selectSection(t, s);
  t = t.replace(/<section\b[^>]*\/?>/gi, "");
  return cleanText(t, unknown);
}
var sleep = (ms) => new Promise((r) => setTimeout(r, ms));
var isNode = typeof process !== "undefined" && !!process.versions?.node;
async function apiGet(api, params, opts) {
  const f = opts.fetch ?? fetch;
  const q = new URLSearchParams({ ...params, format: "json", formatversion: "2", maxlag: "5", origin: "*" });
  const ua = opts.userAgent ?? `${METHOD}/${VERSION}`;
  const headers = { "Api-User-Agent": ua };
  if (isNode) headers["User-Agent"] = ua;
  for (let attempt = 0; attempt < 6; attempt++) {
    const res = await f(`${api}?${q}`, { headers });
    if (res.status === 429 || res.status === 503) {
      await sleep(5e3 * (attempt + 1));
      continue;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${api}`);
    const data = await res.json();
    if (data?.error?.code === "maxlag") {
      await sleep(5e3 * (attempt + 1));
      continue;
    }
    if (data?.error) throw new Error(`API error: ${data.error.code}: ${data.error.info}`);
    return data;
  }
  throw new Error("still throttled after 6 attempts");
}
async function wikitexts(api, titles, opts) {
  const out = /* @__PURE__ */ new Map();
  for (let i = 0; i < titles.length; i += 50) {
    const batch = titles.slice(i, i + 50);
    const r = await apiGet(api, { action: "query", prop: "revisions", rvprop: "content", rvslots: "main", titles: batch.join("|") }, opts);
    const norm = new Map((r.query.normalized ?? []).map((n) => [n.to, n.from]));
    for (const p of r.query.pages) {
      const content = p.revisions?.[0]?.slots?.main?.content;
      if (content !== void 0) out.set(norm.get(p.title) ?? p.title, content);
    }
    if (i + 50 < titles.length) await sleep(1e3);
  }
  return out;
}
async function count(target, opts = {}) {
  const { api, title } = parseTarget(target);
  if (!title) return { title: target, error: "no page title in that URL" };
  const r = await apiGet(api, { action: "query", prop: "revisions", rvprop: "content|ids|timestamp", rvslots: "main", titles: title, redirects: "1" }, opts);
  const pg = r.query.pages[0];
  if (pg.missing !== void 0 || pg.invalid !== void 0) return { title, error: "page not found" };
  const main2 = pg.title;
  const rev = pg.revisions[0];
  const source = rev.slots.main.content.replace(/<!--[\s\S]*?-->/g, "");
  const tags = [...source.matchAll(/<pages\b([^>]*?)\/?>/gi)].map((m) => m[1]);
  if (!tags.length) return { title: main2, error: "no <pages> tag on this page: the work is not transcluded from scan pages" };
  let body = "";
  let notes = "";
  let scanPages = 0;
  const unknown = /* @__PURE__ */ new Set();
  const badAttrs = /* @__PURE__ */ new Set();
  for (const tag of tags) {
    const attrs = parsePagesAttrs(tag);
    const sel = selectPages(attrs);
    sel.unhandled.forEach((a) => badAttrs.add(a));
    if (!attrs.index) {
      badAttrs.add("(no index)");
      continue;
    }
    const names = sel.pages.map((n) => `Page:${attrs.index}/${n}`);
    const texts = await wikitexts(api, names, opts);
    names.forEach((name, i) => {
      const s = {
        only: sel.onlysection,
        from: i === 0 ? sel.fromsection : void 0,
        to: i === names.length - 1 ? sel.tosection : void 0
      };
      const pt = pageText(texts.get(name) ?? "", s, unknown);
      body += "\n" + pt.body;
      notes += "\n" + pt.notes;
      scanPages++;
    });
  }
  const footnoteWords = countWords(notes);
  const host = new URL(api).hostname;
  return {
    title: main2,
    url: `https://${host}/wiki/${encodeURI(main2.replace(/ /g, "_"))}`,
    words: countWords(body) + footnoteWords,
    footnoteWords,
    status: unknown.size || badAttrs.size ? "unchecked" : "ok",
    unhandledTemplates: [...unknown].sort(),
    unhandledAttributes: [...badAttrs].sort(),
    scanPages,
    revision: rev.revid,
    revisionTimestamp: rev.timestamp,
    method: METHOD,
    version: VERSION,
    rules: RULES
  };
}
function isError(r) {
  return r.error !== void 0;
}
function formatResult(r) {
  if (isError(r)) return `${r.title}: ERROR - ${r.error}`;
  const fn = r.footnoteWords ? `, of which ${r.footnoteWords.toLocaleString("en-US")} in footnotes` : "";
  let s = `${r.title}
  ${r.words.toLocaleString("en-US")} words${fn}  (${r.status}; ${r.scanPages} scan pages; revision ${r.revision} of ${r.revisionTimestamp})
  method: ${r.method} ${r.version}`;
  if (r.unhandledTemplates.length) s += `
  UNHANDLED TEMPLATES: ${r.unhandledTemplates.join(", ")}`;
  if (r.unhandledAttributes.length) s += `
  UNHANDLED <pages> ATTRIBUTES: ${r.unhandledAttributes.join(", ")}`;
  return s;
}

// src/cli.ts
var USAGE = `Usage: node dist/cli.js [--json] <Wikisource URL or page title> [...]
  e.g. node dist/cli.js https://en.wikisource.org/wiki/The_Saturday_Evening_Post/Charcoal`;
async function main() {
  const argv = process.argv.slice(2);
  const json = argv.includes("--json");
  const targets = argv.filter((a) => a !== "--json");
  if (!targets.length || argv.includes("--help") || argv.includes("-h")) {
    console.log(USAGE);
    return targets.length ? 0 : 1;
  }
  let failed = false;
  for (const t of targets) {
    try {
      const r = await count(t);
      if (isError(r)) failed = true;
      console.log(json ? JSON.stringify(r) : formatResult(r));
    } catch (e) {
      failed = true;
      console.error(`${t}: ERROR - ${e.message}`);
    }
  }
  return failed ? 2 : 0;
}
main().then((code) => process.exit(code));
