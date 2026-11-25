"use strict";
(() => {
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
  function selectPages(attrs, pageCount) {
    const set = /* @__PURE__ */ new Set();
    const unhandled = [];
    const num = (k) => {
      if (attrs[k] === void 0 || attrs[k] === "") return void 0;
      if (!/^\s*\d+\s*$/.test(attrs[k])) {
        unhandled.push(`${k}=${attrs[k]}`);
        return void 0;
      }
      return parseInt(attrs[k], 10);
    };
    const fromN = num("from");
    const toN = num("to");
    if (attrs.from !== void 0 || attrs.to !== void 0) {
      const from = fromN ?? 1;
      let to = toN;
      if (to === void 0 && attrs.to === void 0) {
        if (pageCount) to = pageCount;
        else unhandled.push("to (page count of the scan unknown)");
      }
      const step = Math.max(1, parseInt(attrs.step ?? "1", 10) || 1);
      if (to !== void 0 && (fromN !== void 0 || attrs.from === void 0)) {
        for (let n = from; n <= to; n += step) set.add(n);
      }
    }
    if (attrs.include) expandInclude(attrs.include).forEach((n) => set.add(n));
    if (attrs.exclude) expandInclude(attrs.exclude).forEach((n) => set.delete(n));
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
  var secTag = (kind, name, flags = "") => new RegExp(
    `<[Ss][Ee][Cc][Tt][Ii][Oo][Nn]\\s+${kind.replace(/./g, (c) => `[${c}${c.toUpperCase()}]`)}\\s*=\\s*(?:"${escapeRegExp(name)}"|'${escapeRegExp(name)}'|${escapeRegExp(name)}(?=[\\s/>]))\\s*/?>`,
    flags
  );
  function selectSection(t, sel) {
    if (sel.only) {
      const parts = [];
      let rest = t;
      for (; ; ) {
        const b = secTag("begin", sel.only).exec(rest);
        if (!b) break;
        rest = rest.slice(b.index + b[0].length);
        const e = secTag("end", sel.only).exec(rest);
        if (!e) {
          parts.push(rest);
          break;
        }
        parts.push(rest.slice(0, e.index));
        rest = rest.slice(e.index + e[0].length);
      }
      return parts.join("\n");
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
      "small caps",
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
      "fine block",
      "t1",
      "t2",
      "t3",
      "t4",
      "t5",
      "t6",
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
      "hi/s",
      "hanging indent",
      "sp",
      "spaced",
      "nowrap",
      "nobr",
      "u",
      "underline",
      "overline",
      "block center",
      "block centre",
      "block left",
      "ppoem",
      "left",
      "right block",
      "smaller block",
      "larger block",
      "x-larger block",
      "sup",
      "sub",
      "ditto",
      "sic",
      "lps",
      "gothic",
      "blackletter",
      "red",
      "span",
      "indent",
      "quote",
      "blockquote",
      "cl-act-h",
      "csc",
      "roman",
      "float right",
      "right",
      "li",
      "largeinitial",
      "large initial"
    ].map((n) => [n, 1]),
    ["dent", 3],
    ...["lang", "hws", "hyphenated word start", "tiret", "font-size", "fs", "color", "pad", "letter-spacing", "ls"].map((n) => [n, 2])
  ]);
  var LITERAL = {
    "'": "'",
    '"': '"',
    longdash: "\u2014",
    "long dash": "\u2014",
    "\u2014": "\u2014",
    "em dash": "\u2014",
    mdash: "\u2014",
    "en dash": "\u2013",
    ndash: "\u2013",
    "...": "...",
    "\u2026": "\u2026",
    mme: "Mme",
    mlle: "Mlle",
    mmes: "Mmes",
    mlles: "Mlles",
    mgr: "Mgr",
    ier: "Ier",
    "m.": "M.",
    "mm.": "MM.",
    "!": "|",
    "=": "="
  };
  var JOIN = /* @__PURE__ */ new Set(["roi", "souverain", "pape", "empereur"]);
  var OPTION_PARAMS = /* @__PURE__ */ new Set([
    "style",
    "class",
    "width",
    "height",
    "align",
    "float",
    "size",
    "lang",
    "dir",
    "id",
    "file",
    "image",
    "caption",
    "alt",
    "link",
    "upright",
    "start",
    "end",
    "margin",
    "indent",
    "top",
    "bottom",
    "left",
    "right",
    "font",
    "color",
    "colour",
    "display",
    "type",
    "title",
    "cstyle",
    "tstyle",
    "pstyle",
    "imgstyle",
    "max-width",
    "line-height",
    "pad",
    "padding",
    "pos",
    "position",
    "num",
    "anchor",
    "border",
    "brace",
    "sep",
    "name",
    "format",
    "mode",
    "source",
    "ref"
  ]);
  var DROP_TAG_CONTENT = /<(math|score|syntaxhighlight|timeline|graph|chem|ce|templatestyles|mapframe|gallery)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;
  var PIPE = "";
  var EQ = "";
  var shield = (s) => s.replace(/\|/g, PIPE).replace(/=/g, EQ);
  var unshield = (s) => s.replace(/\u0001/g, "|").replace(/\u0002/g, "=");
  function splitArgs(inner) {
    const parts = inner.split("|");
    let name = parts[0].trim().replace(/_/g, " ").toLowerCase().replace(/^template:/, "");
    if (name.startsWith("#")) name = name.split(":")[0];
    const unnamed = [];
    let text;
    for (const p of parts.slice(1)) {
      const m = /^\s*([^=]{1,40}?)\s*=([\s\S]*)$/.exec(p);
      if (m) {
        const key = m[1].toLowerCase();
        if (/^\d+$/.test(key)) unnamed[parseInt(key, 10) - 1] = m[2];
        else if (key === "text" || key === "content") text = m[2];
        else if (!OPTION_PARAMS.has(key)) unnamed.push(p);
        continue;
      }
      unnamed.push(p);
    }
    return { name, unnamed: unnamed.filter((x) => x !== void 0), text };
  }
  function reduceTemplates(t, unknown) {
    const inner = /\{\{(?!\{)((?:(?!\{\{|\}\})[\s\S])*?)\}\}/g;
    for (let guard = 0; guard < 50 && t.includes("{{"); guard++) {
      const before = t;
      t = t.replace(inner, (_m, body) => {
        const { name, unnamed, text } = splitArgs(body);
        let out;
        if (DROP_TEMPLATES.has(name) || /\/(s|e|start|end)$/.test(name)) out = "";
        else if (name in LITERAL) out = LITERAL[name];
        else if (JOIN.has(name)) out = unnamed.join(" ");
        else if (name in WRAPPERS) out = unnamed[WRAPPERS[name] - 1] ?? text ?? unnamed[0] ?? "";
        else {
          unknown.add(name);
          out = text ?? unnamed.reduce((a, b) => b.trim().length > a.trim().length ? b : a, "");
        }
        return shield(out);
      });
      if (t === before) break;
    }
    return unshield(t);
  }
  var DROP_LINE_TEMPLATES = /* @__PURE__ */ new Set(["c", "center", "centre", "smaller", "float right", "right"]);
  function isDropLine(line) {
    const s = line.trim();
    const open = s.startsWith("{{") ? "{{" : s.startsWith("[[") ? "[[" : "";
    if (!open) return false;
    const close = open === "{{" ? "}}" : "]]";
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
          if (s.slice(i + 1).trim() !== "") return false;
          break;
        }
      }
    }
    if (depth !== 0) return false;
    if (open === "[[") return /^\[\[\s*(file|image)\s*:/i.test(s);
    const name = /^\{\{\s*([^|}]+?)\s*[|}]/.exec(s)?.[1].toLowerCase().replace(/_/g, " ") ?? "";
    return DROP_LINE_TEMPLATES.has(name) && s.includes("|");
  }
  var NO_TEXT = /\{\{\s*(?:nop|dhr|dhr2|gap|clear|anchor)\s*(?:\|[^{}]*)?\}\}/gi;
  function dropTrailingRight(line) {
    const m = /\{\{\s*(?:float right|right)\s*\|/i.exec(line);
    if (!m) return line;
    let start2 = -1;
    for (const mm of line.matchAll(/\{\{\s*(?:float right|right)\s*\|/gi)) start2 = mm.index;
    let depth = 0;
    for (let i = start2; i < line.length - 1; i++) {
      const two = line.slice(i, i + 2);
      if (two === "{{") {
        depth++;
        i++;
      } else if (two === "}}") {
        depth--;
        i++;
        if (depth === 0) return line.slice(i + 1).trim() === "" ? line.slice(0, start2) : line;
      }
    }
    return line;
  }
  function linesWithPoem(t) {
    let inPoem = false;
    return t.split("\n").map((line) => {
      const startsIn = inPoem;
      const opens = (line.match(/<poem\b/gi) ?? []).length;
      const closes = (line.match(/<\/poem\s*>/gi) ?? []).length;
      if (opens > closes) inPoem = true;
      else if (closes > opens) inPoem = false;
      return { line, poem: startsIn || opens > 0 };
    });
  }
  function cleanText(t, unknown) {
    const notes = [];
    t = linesWithPoem(t).filter(({ line, poem }) => poem || !isDropLine(line.replace(/<ref\b[^>]*\/>|<ref\b[^>]*>[\s\S]*?<\/ref\s*>/gi, "").replace(NO_TEXT, ""))).map(({ line, poem }) => poem ? line : dropTrailingRight(line)).join("\n");
    t = t.replace(/<ref\b[^>]*\/>/gi, "");
    t = t.replace(/<ref\b[^>]*>([\s\S]*?)<\/ref\s*>/gi, (_m, n) => {
      notes.push(n);
      return " ";
    });
    t = t.replace(/<references\b[^>]*\/>|<references\b[^>]*>[\s\S]*?<\/references\s*>/gi, "");
    const run = (s) => {
      s = s.replace(DROP_TAG_CONTENT, " ");
      s = reduceLinks(s);
      s = reduceTemplates(s, unknown);
      s = reduceTables(s);
      s = s.replace(/<br\s*\/?>/gi, " ").replace(/<\/?[a-zA-Z][^>]*>/g, " ");
      s = s.replace(/'''''|'''|''/g, "");
      return decodeEntities(s);
    };
    return { body: run(t), notes: run(notes.join("\n")) };
  }
  function reduceLinks(t) {
    for (let guard = 0; guard < 10 && t.includes("[["); guard++) {
      const before = t;
      t = t.replace(/\[\[([^\[\]]*)\]\]/g, (_m, body) => {
        const bar = body.indexOf("|");
        const target = (bar < 0 ? body : body.slice(0, bar)).trim();
        if (/^\s*(file|image|category|media)\s*:/i.test(target)) return "";
        if (bar < 0) return target.replace(/^:/, "");
        const label = body.slice(bar + 1);
        if (label.trim() === "") {
          return target.replace(/^:/, "").replace(/^[^:]*:/, "").replace(/\s*\([^)]*\)\s*$/, "");
        }
        return label.trim();
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
    return text.split(/[\s​—–]+/u).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
  }
  var SPACELESS_SCRIPT = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}\p{Script=Tibetan}]/u;
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
      const r = await apiGet(api, { action: "query", prop: "revisions", rvprop: "content|ids|timestamp", rvslots: "main", titles: batch.join("|") }, opts);
      const norm = new Map((r.query.normalized ?? []).map((n) => [n.to, n.from]));
      for (const p of r.query.pages) {
        const rv = p.revisions?.[0];
        const content = rv?.slots?.main?.content;
        if (content !== void 0) out.set(norm.get(p.title) ?? p.title, { content, revid: rv.revid, timestamp: rv.timestamp });
      }
      if (i + 50 < titles.length) await sleep(1e3);
    }
    return out;
  }
  async function scanPageCount(api, index, opts) {
    const r = await apiGet(api, { action: "query", prop: "imageinfo", iiprop: "size", titles: `File:${index}` }, opts);
    const n = r.query.pages?.[0]?.imageinfo?.[0]?.pagecount;
    return typeof n === "number" ? n : void 0;
  }
  async function sha256(text) {
    const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
    return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
  }
  async function count(target, opts = {}) {
    const { api, title } = parseTarget(target);
    if (!title) return { title: target, error: "no page title in that URL" };
    const r = await apiGet(api, { action: "query", prop: "revisions", rvprop: "content|ids|timestamp", rvslots: "main", titles: title, redirects: "1" }, opts);
    const pg = r.query.pages[0];
    if (pg.missing !== void 0 || pg.invalid !== void 0) return { title, error: "page not found" };
    const main = pg.title;
    const rev = pg.revisions[0];
    const source = rev.slots.main.content.replace(/<!--[\s\S]*?-->/g, "");
    const tags = [...source.matchAll(/<pages\b([^>]*?)\/?>/gi)].map((m) => m[1]);
    if (!tags.length) return { title: main, error: "no <pages> tag on this page: the work is not transcluded from scan pages" };
    let body = "";
    let notes = "";
    let scanPages = 0;
    const unknown = /* @__PURE__ */ new Set();
    const badAttrs = /* @__PURE__ */ new Set();
    let latest;
    for (const tag of tags) {
      const attrs = parsePagesAttrs(tag);
      if (!attrs.index) {
        badAttrs.add("(no index)");
        continue;
      }
      const needCount = attrs.from !== void 0 && attrs.to === void 0;
      const sel = selectPages(attrs, needCount ? await scanPageCount(api, attrs.index, opts) : void 0);
      sel.unhandled.forEach((a) => badAttrs.add(a));
      const names = sel.pages.map((n) => `Page:${attrs.index}/${n}`);
      const texts = await wikitexts(api, names, opts);
      names.forEach((name, i) => {
        const s = {
          only: sel.onlysection,
          from: i === 0 ? sel.fromsection : void 0,
          to: i === names.length - 1 ? sel.tosection : void 0
        };
        const pr = texts.get(name);
        if (pr && (!latest || pr.timestamp > latest.timestamp)) latest = pr;
        const pt = pageText(pr?.content ?? "", s, unknown);
        body += "\n" + pt.body;
        notes += "\n" + pt.notes;
        scanPages++;
      });
    }
    const footnoteWords = countWords(notes);
    const warnings = [];
    if (SPACELESS_SCRIPT.test(body + notes)) warnings.push("text in a script written without spaces (e.g. Chinese, Japanese, Thai): the count is not meaningful");
    const host = new URL(api).hostname;
    return {
      title: main,
      url: `https://${host}/wiki/${encodeURI(main.replace(/ /g, "_"))}`,
      words: countWords(body) + footnoteWords,
      footnoteWords,
      status: unknown.size || badAttrs.size || warnings.length ? "unchecked" : "ok",
      unhandledTemplates: [...unknown].sort(),
      unhandledAttributes: [...badAttrs].sort(),
      warnings,
      scanPages,
      revision: rev.revid,
      revisionTimestamp: rev.timestamp,
      scanPagesLatestEdit: latest?.timestamp ?? "",
      textSha256: await sha256(body + "\0" + notes),
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
  ${r.words.toLocaleString("en-US")} words${fn}  (${r.status}; ${r.scanPages} scan pages; work page revision ${r.revision}; scan pages last edited ${r.scanPagesLatestEdit})
  method: ${r.method} ${r.version}`;
    if (r.unhandledTemplates.length) s += `
  UNHANDLED TEMPLATES: ${r.unhandledTemplates.join(", ")}`;
    if (r.unhandledAttributes.length) s += `
  UNHANDLED <pages> ATTRIBUTES: ${r.unhandledAttributes.join(", ")}`;
    for (const w of r.warnings) s += `
  WARNING: ${w}`;
    return s;
  }

  // src/gadget.ts
  function start() {
    if (mw.config.get("wgAction") !== "view") return;
    if (!document.querySelector(".prp-pages-output")) return;
    const link = mw.util.addPortletLink("p-tb", "#", "Word count", "t-wikisource-wordcount", "Count the words of this work (wikisource-wordcount)");
    if (!link) return;
    link.addEventListener("click", async (ev) => {
      ev.preventDefault();
      const url = `${location.origin}/wiki/${mw.config.get("wgPageName")}`;
      mw.notify("Counting words\u2026", { tag: "wikisource-wordcount" });
      try {
        const r = await count(url, { userAgent: "wikisource-wordcount-gadget/1.0" });
        const text = formatResult(r);
        const pre = document.createElement("pre");
        pre.style.whiteSpace = "pre-wrap";
        pre.textContent = text;
        mw.notify(pre, { tag: "wikisource-wordcount", autoHide: false, type: isError(r) ? "error" : "info" });
      } catch (e) {
        mw.notify(`Word count failed: ${e.message}`, { tag: "wikisource-wordcount", type: "error" });
      }
    });
  }
  mw.loader.using(["mediawiki.util", "mediawiki.notification"]).then(start);
})();
