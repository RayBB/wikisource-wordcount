#!/usr/bin/env node

// src/core.ts
var METHOD = "wikisource-wordcount";
var VERSION = "1.0";
var RULES = "section text only; centred/right-aligned blocks, images and noinclude dropped; words split on whitespace and em/en dashes; a word contains a letter or digit";
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
    if (part.includes("-")) {
      const [a, b] = part.split("-").map((x) => parseInt(x, 10));
      for (let n = a; n <= b; n++) out.push(n);
    } else {
      out.push(parseInt(part, 10));
    }
  }
  return out;
}
function parsePagesAttrs(tag) {
  const attrs = {};
  for (const m of tag.matchAll(/(\w+)=(?:"([^"]*)"|([^\s"/>]+))/g)) {
    attrs[m[1]] = m[2] !== void 0 && m[2] !== "" ? m[2] : m[3] ?? "";
  }
  return attrs;
}
var UNWRAP = [
  [/\{\{hws\|[^|}]*\|([^}]*)\}\}/g, "$1"],
  [/\{\{hwe\|[^}]*\}\}/g, ""],
  [/\{\{(?:sc|small-caps|di|dropinitial|larger|smaller|x-larger|uc|lc)\|([^{}]*)\}\}/g, "$1"],
  [/\{\{SIC\|([^|}]*)(\|[^}]*)?\}\}/g, "$1"],
  [/\{\{gap(\|[^}]*)?\}\}/g, " "],
  [/\{\{nop\}\}/g, ""],
  [/\{\{block center\|/g, ""],
  [/\{\{(?:float right|right)\|[^{}]*\}\}/g, ""],
  [/\{\{dhr(\|[^}]*)?\}\}/g, ""],
  [/\{\{'\}\}/g, "'"],
  [/<\/?poem>/g, "\n"],
  [/'''''|'''|''/g, ""],
  [/<br\s*\/?>/g, " "]
];
var DROP_LINE = /^\s*(\{\{(?:c|center|FI|missing image|smaller|float right|right)\|.*\}\}|\[\[(?:File|Image):.*\]\])\s*$/i;
function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function pageText(wikitext, section) {
  let t = wikitext.replace(/<noinclude>[\s\S]*?<\/noinclude>/g, "");
  if (section) {
    const s = escapeRegExp(section);
    const m = new RegExp(`<section begin="${s}"\\s*/>([\\s\\S]*?)<section end="${s}"\\s*/>`).exec(t);
    t = m ? m[1] : "";
  }
  t = t.replace(/<section[^>]*\/>/g, "");
  t = t.split("\n").filter((line) => !DROP_LINE.test(line)).join("\n");
  for (let pass = 0; pass < 3; pass++) {
    for (const [re, rep] of UNWRAP) t = t.replace(re, rep);
  }
  return t;
}
function countWords(text) {
  return text.split(/[\s—–]+/).filter((w) => /[A-Za-z0-9]/.test(w)).length;
}
function leftoverTemplates(text) {
  return [...text.matchAll(/\{\{[^}|]*/g)].map((m) => m[0]);
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
  const tags = [...rev.slots.main.content.matchAll(/<pages([^>]*)\/>/g)].map((m) => m[1]);
  if (!tags.length) return { title: main2, error: "no <pages> tag on this page: the work is not transcluded from scan pages" };
  let text = "";
  let scanPages = 0;
  const leftovers = /* @__PURE__ */ new Set();
  for (const tag of tags) {
    const attrs = parsePagesAttrs(tag);
    const section = attrs.onlysection || void 0;
    const nums = attrs.include ? expandInclude(attrs.include) : expandInclude(`${attrs.from}-${attrs.to}`);
    const names = nums.map((n) => `Page:${attrs.index}/${n}`);
    const texts = await wikitexts(api, names, opts);
    for (const name of names) {
      const pt = pageText(texts.get(name) ?? "", section);
      leftoverTemplates(pt).forEach((x) => leftovers.add(x));
      text += "\n" + pt;
      scanPages++;
    }
  }
  const host = new URL(api).hostname;
  return {
    title: main2,
    url: `https://${host}/wiki/${encodeURI(main2.replace(/ /g, "_"))}`,
    words: countWords(text),
    status: leftovers.size ? "unchecked" : "ok",
    unhandledTemplates: [...leftovers].sort(),
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
  let s = `${r.title}
  ${r.words.toLocaleString("en-US")} words  (${r.status}; ${r.scanPages} scan pages; revision ${r.revision} of ${r.revisionTimestamp})
  method: ${r.method} ${r.version}`;
  if (r.unhandledTemplates.length) s += `
  UNHANDLED TEMPLATES: ${r.unhandledTemplates.join(", ")}`;
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
