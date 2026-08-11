import { VZ_SYMBOL_HTML } from './symbol';

const BTN_ID = 'vaporzr-top-button';

const SEARCH_SELECTORS = ['[data-testid="sidebar-search"]', '[data-testid="search-input"]', 'a[aria-label="Search"]'];

let observer: MutationObserver | null = null;

function findSearchTarget(): HTMLElement | null {
  for (const selector of SEARCH_SELECTORS) {
    const el = document.querySelector<HTMLElement>(selector);
    if (el) return el;
  }
  return null;
}

function injectButton(): boolean {
  if (document.getElementById(BTN_ID)) return true;

  const target = findSearchTarget();
  if (!target) return false;

  const host = (target.closest('li') ?? target) as HTMLElement;

  const btn = document.createElement('button');
  btn.id = BTN_ID;
  btn.type = 'button';
  btn.className = 'vaporzr-top-btn';
  btn.title = 'Vaporzr';
  btn.setAttribute('aria-label', 'Vaporzr');
  btn.innerHTML = VZ_SYMBOL_HTML;
  btn.addEventListener('click', () => {
    Spicetify.Platform.History.push('/vaporzr');
  });

  host.insertAdjacentElement('afterend', btn);
  return true;
}

export function ensureTopButton(): void {
  if (observer) return;
  injectButton();
  observer = new MutationObserver(() => {
    injectButton();
  });
  observer.observe(document.body, { childList: true, subtree: true });
}
