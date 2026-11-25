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
