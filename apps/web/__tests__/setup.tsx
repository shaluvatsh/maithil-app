import '@testing-library/jest-dom/vitest';
import { vi, afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

/**
 * Node 20.13+ defines its own global `localStorage` accessor, unusable without
 * `--localstorage-file`. In this jsdom environment `window === globalThis`, so
 * `window.localStorage` is not jsdom's storage at all - it IS Node's broken
 * accessor, and `localStorage.clear()` throws "Cannot read properties of undefined"
 * on whichever Node version happens to define it (20.13+). The descriptor is
 * `configurable: true`, so it can be replaced outright with a real in-memory
 * Storage implementation rather than routed through jsdom, whose own storage
 * backend has the identical collision problem for the same reason.
 */
class MemoryStorage implements Storage {
  private store = new Map<string, string>();
  get length() { return this.store.size; }
  clear() { this.store.clear(); }
  getItem(key: string) { return this.store.has(key) ? this.store.get(key)! : null; }
  key(index: number) { return [...this.store.keys()][index] ?? null; }
  removeItem(key: string) { this.store.delete(key); }
  setItem(key: string, value: string) { this.store.set(key, String(value)); }
}
for (const prop of ['localStorage', 'sessionStorage'] as const) {
  Object.defineProperty(globalThis, prop, { value: new MemoryStorage(), configurable: true, writable: true });
}

afterEach(() => { cleanup(); search = ''; path = '/'; });

/** next/navigation is not available outside the Next runtime. */
export const pushed: string[] = [];

/**
 * Query string for the component under test. Mutable because /book now branches on
 * it: with nothing set it opens on the occasion picker, and `browse=1` goes straight
 * to the catalogue. A test that wants the catalogue has to say so.
 */
export let search = '';
export const setSearch = (v: string) => { search = v; };

/** Current route. Mutable because the role gate branches on it. */
export let path = '/';
export const setPath = (v: string) => { path = v; };
vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: (url: string) => { pushed.push(url); },
    replace: (url: string) => { pushed.push(url); },
    prefetch: () => {},
  }),
  usePathname: () => path,
  useSearchParams: () => new URLSearchParams(search),
}));

/** next/link renders a plain anchor so nesting assertions see real DOM. */
vi.mock('next/link', () => ({
  default: ({ children, href, ...rest }: React.ComponentProps<'a'>) =>
    <a href={String(href)} {...rest}>{children}</a>,
}));

/** No network in unit tests: every fetch resolves to an empty list. */
global.fetch = vi.fn(async () => new Response('[]', {
  status: 200, headers: { 'content-type': 'application/json' },
})) as unknown as typeof fetch;

if (!global.matchMedia) {
  global.matchMedia = ((q: string) => ({
    matches: false, media: q, onchange: null,
    addListener: () => {}, removeListener: () => {},
    addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
  })) as unknown as typeof matchMedia;
}

/**
 * jsdom does not implement layout, so `Element.scrollIntoView` is simply absent -
 * every call the app makes to it (see `revealNext` in app/book/page.tsx) throws
 * "scrollIntoView is not a function" the instant a test actually drives the flow
 * far enough to trigger one, rather than failing at the call site cleanly: it
 * throws from inside a `requestAnimationFrame` callback, outside the test's own
 * call stack, so vitest reports it as an unhandled exception unconnected to the
 * assertion that was actually running.
 */
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}
