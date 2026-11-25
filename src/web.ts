import { count, formatResult, isError } from './core.js';

const form = document.getElementById('form') as HTMLFormElement;
const input = document.getElementById('target') as HTMLInputElement;
const out = document.getElementById('out') as HTMLPreElement;
const button = form.querySelector('button') as HTMLButtonElement;

async function run(target: string): Promise<void> {
  button.disabled = true;
  out.textContent = 'Counting…';
  try {
    const r = await count(target);
    out.textContent = formatResult(r) + (isError(r) ? '' : `\n\n${JSON.stringify(r, null, 2)}`);
  } catch (e) {
    out.textContent = `ERROR - ${(e as Error).message}`;
  } finally {
    button.disabled = false;
  }
}

form.addEventListener('submit', (ev) => {
  ev.preventDefault();
  const t = input.value.trim();
  if (!t) return;
  const u = new URL(location.href);
  u.searchParams.set('url', t);
  history.replaceState(null, '', u);
  void run(t);
});

// Allow ?url=<Wikisource URL> so a count can be linked or bookmarked.
const preset = new URLSearchParams(location.search).get('url');
if (preset) {
  input.value = preset;
  void run(preset);
}
