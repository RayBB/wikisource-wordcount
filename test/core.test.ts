import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  countWords,
  decodeEntities,
  expandInclude,
  normalizeSections,
  pageText,
  parsePagesAttrs,
  parseTarget,
  reduceLinks,
  reduceTables,
  reduceTemplates,
  isDropLine,
  SPACELESS_SCRIPT,
  selectPages,
  selectSection,
} from '../src/core.ts';

const words = (wt: string, sel?: Parameters<typeof pageText>[1]) => {
  const p = pageText(wt, sel);
  return { body: countWords(p.body), notes: countWords(p.notes), text: p.body.replace(/\s+/g, ' ').trim() };
};

test('parseTarget accepts /wiki/ URLs, index.php URLs, other languages and bare titles', () => {
  assert.deepEqual(parseTarget('https://en.wikisource.org/wiki/The_Saturday_Evening_Post/Charcoal'), {
    api: 'https://en.wikisource.org/w/api.php',
    title: 'The Saturday Evening Post/Charcoal',
  });
  assert.equal(parseTarget('https://en.wikisource.org/w/index.php?title=Foo_Bar&action=view').title, 'Foo Bar');
  assert.equal(parseTarget('https://fr.wikisource.org/wiki/X').api, 'https://fr.wikisource.org/w/api.php');
  assert.deepEqual(parseTarget('He Man'), { api: 'https://en.wikisource.org/w/api.php', title: 'He Man' });
});

test('<pages> attributes: quoted, single-quoted and unquoted values', () => {
  assert.deepEqual(parsePagesAttrs(` index="A B.djvu" from=48 to='50' onlysection="Waiting for a Train" `), {
    index: 'A B.djvu',
    from: '48',
    to: '50',
    onlysection: 'Waiting for a Train',
  });
  assert.deepEqual(expandInclude('18,19, 90-92'), [18, 19, 90, 91, 92]);
});

test('page selection: from/to with step, include added, exclude removed, header options ignored', () => {
  assert.deepEqual(selectPages({ index: 'x', from: '10', to: '20', step: '5' }).pages, [10, 15, 20]);
  assert.deepEqual(selectPages({ index: 'x', from: '1', to: '5', exclude: '2-3', include: '9' }).pages, [1, 4, 5, 9]);
  assert.deepEqual(selectPages({ index: 'x', include: '18,19,90' }).pages, [18, 19, 90]);
  assert.deepEqual(selectPages({ index: 'x', from: '1', to: '2', header: '1', prev: 'a', next: 'b' }).unhandled, []);
  assert.deepEqual(selectPages({ index: 'x', from: '1', to: '2', titre: 'y' }).unhandled, []);
});

test('sections: onlysection, fromsection on the first page, tosection on the last, ## shorthand', () => {
  const p = 'A one. <section begin="s1" />B two three.<section end="s1" /> <section begin="s2" />C four.<section end="s2" />';
  assert.equal(countWords(selectSection(p, { only: 's1' }).replace(/<[^>]+>/g, ' ')), 3);
  assert.equal(countWords(selectSection(p, { from: 's2' }).replace(/<[^>]+>/g, ' ')), 2);
  assert.equal(countWords(selectSection(p, { to: 's1' }).replace(/<[^>]+>/g, ' ')), 5);
  const sh = 'end of chapter eight\n## s2 ##\nstart of chapter nine';
  assert.equal(words(sh, { from: 's2' }).body, 4);
  assert.match(normalizeSections(sh), /<section begin="s2" \/>/);
});

test('titles, bylines, captions, images and noinclude are dropped; formatting is unwrapped', () => {
  const wt = [
    '<noinclude><pagequality level="3" user="X" />{{RunningHeader|16|POST|1930}}</noinclude>',
    '<section begin="Charcoal" />{{c|{{x-larger|\'\'\'CHARCOAL\'\'\'}}}}',
    '',
    '{{c|By {{sc|Marjory Stoneman Douglas}}}}',
    '',
    '{{FI|file=X.jpg|width=500px}}',
    "{{center|'''''A Caption'''''}}",
    '',
    "{{di|T}}{{sc|he two}} men ''walked''—slowly—home. {{hws|bow|bowsprit}}<noinclude>",
    "{{c|''(Continued on Page 88)''}}",
    '</noinclude><section end="Charcoal" />',
  ].join('\n');
  const r = words(wt, 'Charcoal');
  assert.equal(r.text, 'The two men walked—slowly—home. bowsprit');
  assert.equal(r.body, 7);
});

test('multi-line image templates and HTML comments are not counted', () => {
  assert.equal(words('Text here.\n{{FI\n|file=A.jpg\n|caption=Lots of caption words here\n}}\n<!-- {{FI|file=B.jpg|caption=hidden words}} -->').body, 2);
});

test('footnotes are counted separately and in the total', () => {
  const r = words('Main text here.<ref>A note of five words.</ref> More.<ref name="x" /> {{smallrefs}}');
  assert.equal(r.body, 4);
  assert.equal(r.notes, 5);
});

test('links show their text; files and categories are dropped', () => {
  assert.equal(
    reduceLinks('[[w:Cato the Younger|Cato]] and [[Rome]] [[File:X.jpg|thumb|a cap]] [[Category:Y]] [https://x.org site]').replace(/\s+/g, ' ').trim(),
    'Cato and Rome site',
  );
});

test('HTML tags removed with content kept; entities decoded; table markup reduced', () => {
  assert.equal(words('<div style="margin-left:2em"><span class="x">NORA</span> sea-sick&mdash;grow</div>').body, 3);
  assert.equal(decodeEntities('a&nbsp;b&#8212;c&#x2014;d'), 'a b—c—d');
  assert.equal(countWords(reduceTables('{| class="wikitable"\n|-\n! Name !! Age\n|-\n| style="x" | Ann || 30\n|}')), 4);
});

test('unknown templates keep their first argument and are reported; known ones are not', () => {
  const unknown = new Set<string>();
  const t = reduceTemplates(
    '{{rule|3em}} {{ppoem|start=follow|Line one\nline two}} {{mystery|kept text|other}} {{tiret|con|continue}}{{tiret2|tinue|continue}} {{Mme}}',
    unknown,
  );
  assert.equal(t.replace(/\s+/g, ' ').trim(), 'Line one line two kept text continue Mme');
  assert.deepEqual([...unknown], ['mystery']);
});

test('countWords: compounds and contractions are one word; dashes and ellipses are not words; any script', () => {
  assert.equal(countWords("sun-pinked di'n't — —— . . . anything—anything"), 4);
  assert.equal(countWords('à la fin, « Ô »'), 4);
});

test('signatures in {{float right}} and {{dhr}} spacing are not counted', () => {
  assert.equal(words("Last words. {{float right|—''M. Stoneman'', '08.}}\n{{dhr|2em}}").body, 2);
});

// Findings from the v1.1 code review
test('from alone runs to the end of the scan, to alone starts at page 1; non-numeric values are reported', () => {
  assert.deepEqual(selectPages({ index: 'x', from: '5' }, 7).pages, [5, 6, 7]);
  assert.deepEqual(selectPages({ index: 'x', to: '3' }).pages, [1, 2, 3]);
  assert.deepEqual(selectPages({ index: 'x', from: '5' }).unhandled, ['to (page count of the scan unknown)']);
  assert.deepEqual(selectPages({ index: 'x', from: 'iv', to: 'ix' }).unhandled, ['from=iv', 'to=ix']);
});

test('a "|" produced by an inner template does not split the outer template', () => {
  assert.equal(countWords(reduceTemplates('x {{larger|a {{!}} b c}}', new Set())), 4);
});

test('text that looks like key=value, and named text= arguments, are kept', () => {
  assert.equal(countWords(reduceTemplates('{{larger|E=mc now}}', new Set())), 2);
  assert.equal(countWords(reduceTemplates('{{ppoem|text=one two three}} {{blockquote|text=a b c}}', new Set())), 6);
  assert.equal(countWords(reduceTemplates('{{c|style=color:red|kept words}}', new Set())), 2);
});

test('a line is dropped only if one centred template spans all of it', () => {
  assert.equal(isDropLine('{{c|a b}} middle words {{c|c d}}'), false);
  assert.equal(isDropLine('{{c|{{x-larger|TITLE}}}}'), true);
  assert.equal(isDropLine('{{center|{{larger|open'), false);
  assert.equal(words('{{c|a b}} middle words {{c|c d}}').body, 6);
});

test('onlysection joins every block with that name; section names are case-sensitive', () => {
  const p = '<section begin="a"/>x1<section end="a"/> mid <section begin="a"/>x2<section end="a"/> <section begin="A"/>no<section end="A"/>';
  assert.equal(countWords(selectSection(p, { only: 'a' })), 2);
});

test('zero-width spaces separate words; scripts without spaces are detected', () => {
  assert.equal(countWords('a\u200Bb c'), 3);
  assert.equal(SPACELESS_SCRIPT.test('日本語の文章です'), true);
  assert.equal(SPACELESS_SCRIPT.test('plain English'), false);
});

test('links: pipe trick, extra pipes and visible category links', () => {
  assert.equal(reduceLinks('[[w:Foo (bar)|]]'), 'Foo');
  assert.equal(reduceLinks('[[a|b|c]]'), 'b|c');
  assert.equal(reduceLinks('[[:Category:X]]'), 'Category:X');
});

test('parser functions are reported by name only', () => {
  const unknown = new Set<string>();
  reduceTemplates('{{#if:x|yes there|no}}', unknown);
  assert.deepEqual([...unknown], ['#if']);
});

test('a footnote on a dropped caption line is dropped with it', () => {
  const r = words('{{c|A caption}}<ref>n1 n2</ref>\nBody text.');
  assert.equal(r.notes, 0);
});

test('a caption line followed by {{nop}} is still a caption line', () => {
  assert.equal(words("{{center|'''''A Long Caption Here'''''}}{{nop}}\nBody text.").body, 2);
});

// Findings from the v1.1 field test
test('verse refrains in {{float right}} are counted; a signature ending a paragraph is not', () => {
  assert.equal(words('Quoth the Raven, {{float right|Only this and nothing more.}}<br>\nNext line here.').body, 11);
  assert.equal(words("Last words. {{float right|—''M. Stoneman'', '08.}}").body, 2);
  assert.equal(words('<poem>\n{{c|A centred verse line}}\nand more\n</poem>').body, 6);
});

test('dent, largeinitial, French M. and roi; unknown templates keep their longest argument', () => {
  const u = new Set<string>();
  assert.equal(reduceTemplates('{{dent|2em|0em|the indented text}}', u).trim(), 'the indented text');
  assert.equal(reduceTemplates('{{li|T}}he {{M.}} {{MM.}} {{roi|Charles|X}}', u).trim(), 'The M. MM. Charles X');
  assert.equal(reduceTemplates('{{usstatsidenote2|L|A marginal note here}}', u).trim(), 'A marginal note here');
  assert.deepEqual([...u], ['usstatsidenote2']);
});
