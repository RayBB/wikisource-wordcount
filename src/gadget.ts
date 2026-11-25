/**
 * Wikisource user script / gadget: adds a "Word count" link to the Tools menu on pages that transclude scan pages
 * with <pages>. Install by loading dist/gadget.js from your common.js (see README).
 */
import { count, formatResult, isError } from './core.js';

declare const mw: any;

function start(): void {
  if (mw.config.get('wgAction') !== 'view') return;
  if (!document.querySelector('.prp-pages-output')) return;
  const link = mw.util.addPortletLink('p-tb', '#', 'Word count', 't-wikisource-wordcount', 'Count the words of this work (wikisource-wordcount)');
  if (!link) return;
  link.addEventListener('click', async (ev: Event) => {
    ev.preventDefault();
    const url = `${location.origin}/wiki/${mw.config.get('wgPageName')}`;
    mw.notify('Counting words…', { tag: 'wikisource-wordcount' });
    try {
      const r = await count(url, { userAgent: 'wikisource-wordcount-gadget/1.0' });
      const text = formatResult(r);
      const pre = document.createElement('pre');
      pre.style.whiteSpace = 'pre-wrap';
      pre.textContent = text;
      mw.notify(pre, { tag: 'wikisource-wordcount', autoHide: false, type: isError(r) ? 'error' : 'info' });
    } catch (e) {
      mw.notify(`Word count failed: ${(e as Error).message}`, { tag: 'wikisource-wordcount', type: 'error' });
    }
  });
}

mw.loader.using(['mediawiki.util', 'mediawiki.notification']).then(start);
