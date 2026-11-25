import { test } from 'node:test';
import assert from 'node:assert/strict';
import { countWords, expandInclude, pageText, parsePagesAttrs, parseTarget } from '../src/core.ts';

test('parseTarget accepts /wiki/ URLs, index.php URLs, other languages and bare titles', () => {
  assert.deepEqual(parseTarget('https://en.wikisource.org/wiki/The_Saturday_Evening_Post/Charcoal'), {
    api: 'https://en.wikisource.org/w/api.php',
    title: 'The Saturday Evening Post/Charcoal',
  });
  assert.deepEqual(parseTarget('https://en.wikisource.org/w/index.php?title=Foo_Bar&action=view').title, 'Foo Bar');
  assert.equal(parseTarget('https://fr.wikisource.org/wiki/X').api, 'https://fr.wikisource.org/w/api.php');
  assert.deepEqual(parseTarget('He Man'), { api: 'https://en.wikisource.org/w/api.php', title: 'He Man' });
});

test('expandInclude and parsePagesAttrs handle ranges and unquoted attributes', () => {
  assert.deepEqual(expandInclude('18,19, 90-92'), [18, 19, 90, 91, 92]);
  assert.deepEqual(parsePagesAttrs(' index="A B.djvu" from=48 to=48 onlysection="Waiting for a Train" '), {
    index: 'A B.djvu',
    from: '48',
    to: '48',
    onlysection: 'Waiting for a Train',
  });
});

test('pageText keeps only the section and drops titles, captions, images and noinclude', () => {
  const wt = [
    '<noinclude><pagequality level="3" user="X" />{{RunningHeader|16|POST|1930}}</noinclude>',
    'Ad text outside.',
    '<section begin="Charcoal" />{{c|{{x-larger|\'\'\'CHARCOAL\'\'\'}}}}',
    '',
    '{{c|By {{sc|Marjory Stoneman Douglas}}}}',
    '',
    '{{FI|file=X.jpg|width=500px}}',
    "{{center|'''''A Caption'''''}}",
    '',
    "{{di|T}}{{sc|he two}} men ''walked''—slowly—home. {{hws|bow|bowsprit}}<noinclude>",
    '',
    "{{c|''(Continued on Page 88)''}}",
    '',
    '</noinclude><section end="Charcoal" />',
  ].join('\n');
  const t = pageText(wt, 'Charcoal');
  assert.equal(t.trim(), 'The two men walked—slowly—home. bowsprit');
  assert.equal(countWords(t), 7);
});

test('countWords: hyphenated compounds and contractions are one word, dashes and ellipses are not words', () => {
  assert.equal(countWords("sun-pinked di'n't — —— . . . anything—anything"), 4);
});

test('signatures in {{float right}} and {{dhr}} spacing are not counted', () => {
  assert.equal(countWords(pageText("Last words. {{float right|—''M. Stoneman'', '08.}}\n{{dhr|2em}}", undefined)), 2);
});
