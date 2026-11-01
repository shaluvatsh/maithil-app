// REPL driver for driving the themaithil web app (apps/web) against the real API
// (apps/api) with Playwright chromium. Run under tmux and `send-keys` one command
// at a time for interactive debugging, or pipe a whole script to stdin for a
// one-shot run - see SKILL.md.
//
// Install once: `npm install` in this directory (self-contained, not part of the
// pnpm workspace - see package.json).
import { chromium } from 'playwright';
import * as readline from 'node:readline';
import * as fs from 'node:fs';
import * as path from 'node:path';

const API = process.env.THEMAITHIL_API ?? 'http://localhost:3000';
const WEB = process.env.THEMAITHIL_WEB ?? 'http://localhost:3001';
const SHOT_DIR = process.env.SCREENSHOT_DIR || '/tmp/shots';
fs.mkdirSync(SHOT_DIR, { recursive: true });

let browser = null;
let page = null;

const COMMANDS = {
  async launch() {
    if (browser) return console.log('already launched');
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    page = await context.newPage();
    page.on('console', (msg) => {
      if (msg.type() === 'error') console.log('[console.error]', msg.text());
    });
    page.on('pageerror', (err) => console.log('[pageerror]', err.message));
    console.log('launched.');
  },

  async nav(url) {
    if (!page) return console.log('ERROR: launch first');
    const full = /^https?:\/\//.test(url) ? url : `${WEB}${url}`;
    await page.goto(full, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    console.log('nav →', full);
  },

  /**
   * viewport <width> [height] - resize, so a layout can be reviewed at the width
   * it will actually be used at. Most devotees book on a phone; a screenshot at
   * 1280 says nothing about whether the same screen works at 390.
   */
  async viewport(argStr) {
    if (!page) return console.log('ERROR: launch first');
    const [w, h] = String(argStr).split(' ');
    const width = Number(w);
    const height = h ? Number(h) : 844;
    if (!Number.isFinite(width) || !Number.isFinite(height)) {
      return console.log('ERROR: viewport <width> [height]');
    }
    await page.setViewportSize({ width, height });
    console.log(`viewport → ${width}x${height}`);
  },

  /** Full-page screenshot, for reviewing a whole scrolling layout at once. */
  async ssfull(name = String(Date.now())) {
    if (!page) return console.log('ERROR: launch first');
    const file = `${SHOT_DIR}/${name}.png`;
    await page.screenshot({ path: file, fullPage: true });
    console.log('screenshot:', file);
  },

  /**
   * login <phone> - the fast path for authenticated flows.
   *
   * Does the OTP request+verify directly against the API (bypassing the OTP
   * input UI - the app only accepts the dev-bypass code anyway when
   * OTP_DEV_BYPASS=true), then injects the resulting tokens into localStorage
   * and reloads. localStorage is origin-scoped, so this navigates to WEB first
   * if nothing is loaded yet.
   */
  async login(argStr) {
    const [phone] = argStr.split(' ');
    if (!phone) return console.log('usage: login <phone>   e.g. login 9830012345');
    if (!page) return console.log('ERROR: launch first');
    if (!page.url().startsWith(WEB)) await page.goto(WEB, { waitUntil: 'domcontentloaded' });

    const reqRes = await fetch(`${API}/v1/auth/otp/request`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ phone }),
    });
    const reqBody = await reqRes.json();
    if (!reqRes.ok) return console.log('login: OTP request failed —', JSON.stringify(reqBody));
    const otp = reqBody.devOtp ?? '123456';

    const verifyRes = await fetch(`${API}/v1/auth/otp/verify`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ requestId: reqBody.requestId, phone, otp }),
    });
    const verifyBody = await verifyRes.json();
    if (!verifyRes.ok) return console.log('login: OTP verify failed —', JSON.stringify(verifyBody));

    const { accessToken, refreshToken } = verifyBody.tokens;
    const user = verifyBody.user;
    await page.evaluate(([access, refresh, role, name]) => {
      localStorage.setItem('themaithil.token', access);
      localStorage.setItem('themaithil.refresh', refresh);
      localStorage.setItem('themaithil.role', role);
      localStorage.setItem('themaithil.name', name);
    }, [accessToken, refreshToken, user.role, user.name ?? user.role]);
    await page.reload({ waitUntil: 'domcontentloaded' });
    console.log(`login: signed in as ${user.name ?? phone} (${user.role})`);
  },

  async ss(name) {
    if (!page) return console.log('ERROR: launch first');
    const f = path.join(SHOT_DIR, (name || `ss-${Date.now()}`) + '.png');
    await page.screenshot({ path: f, fullPage: false });
    console.log('screenshot:', f);
  },

  async click(sel) {
    if (!page) return console.log('ERROR: launch first');
    try { await page.click(sel, { timeout: 5000 }); console.log('click', sel, '→ OK'); }
    catch (e) { console.log('click', sel, '→ ERROR:', e.message.split('\n')[0]); }
  },

  async 'click-text'(text) {
    if (!page) return console.log('ERROR: launch first');
    try {
      await page.getByText(text, { exact: false }).first().click({ timeout: 5000 });
      console.log('click-text', JSON.stringify(text), '→ OK');
    } catch (e) { console.log('click-text', JSON.stringify(text), '→ ERROR:', e.message.split('\n')[0]); }
  },

  /** click-role <role> <name-regex>  e.g.  click-role button ^Select$ */
  async 'click-role'(argStr) {
    if (!page) return console.log('ERROR: launch first');
    const [role, ...rest] = argStr.split(' ');
    const name = rest.join(' ');
    try {
      await page.getByRole(role, { name: new RegExp(name, 'i') }).first().click({ timeout: 5000 });
      console.log('click-role', role, name, '→ OK');
    } catch (e) { console.log('click-role', role, name, '→ ERROR:', e.message.split('\n')[0]); }
  },

  async type(text)  { if (page) await page.keyboard.type(text, { delay: 20 }); },
  async press(key)  { if (page) await page.keyboard.press(key); },

  /** fill <css-selector> <value> */
  async fill(argStr) {
    if (!page) return console.log('ERROR: launch first');
    const sp = argStr.indexOf(' ');
    const sel = argStr.slice(0, sp), value = argStr.slice(sp + 1);
    try { await page.fill(sel, value, { timeout: 5000 }); console.log('fill', sel, '→ OK'); }
    catch (e) { console.log('fill', sel, '→ ERROR:', e.message.split('\n')[0]); }
  },

  async wait(sel) {
    if (!page) return console.log('ERROR: launch first');
    try { await page.waitForSelector(sel, { timeout: 15_000 }); console.log('found:', sel); }
    catch { console.log('TIMEOUT:', sel); }
  },

  async 'wait-text'(text) {
    if (!page) return console.log('ERROR: launch first');
    try {
      await page.getByText(text, { exact: false }).first().waitFor({ timeout: 15_000 });
      console.log('found text:', text);
    } catch { console.log('TIMEOUT waiting for text:', text); }
  },

  async eval(expr) {
    if (!page) return console.log('ERROR: launch first');
    try { console.log(JSON.stringify(await page.evaluate(expr))); }
    catch (e) { console.log('ERROR:', e.message); }
  },

  async text(sel) {
    if (!page) return console.log('ERROR: launch first');
    console.log(await page.evaluate(
      (s) => (s ? document.querySelector(s) : document.body)?.innerText ?? '(null)',
      sel || null,
    ));
  },

  async url() { if (page) console.log(page.url()); },

  async quit() { if (browser) await browser.close().catch(() => {}); browser = null; page = null; },
  help() { console.log('commands:', Object.keys(COMMANDS).join(', ')); },
};

// A piped-in script (heredoc, file redirect) has every line already buffered, so
// readline's 'line' events fire back-to-back regardless of whether the previous
// async command finished - queue commands and run them strictly one at a time
// instead of relying on event-emission order to imply completion order.
const stdin = fs.createReadStream(null, { fd: fs.openSync('/dev/stdin', 'r') });
const rl = readline.createInterface({ input: stdin, output: process.stdout, prompt: 'driver> ' });

let chain = Promise.resolve();

rl.on('line', (line) => {
  chain = chain.then(async () => {
    const [cmd, ...rest] = line.trim().split(/\s+/);
    if (!cmd) return;
    const fn = COMMANDS[cmd];
    if (!fn) { console.log('unknown:', cmd, '— try: help'); return; }
    try { await fn(rest.join(' ')); } catch (e) { console.log('ERROR:', e.message); }
    if (cmd === 'quit') { rl.close(); process.exit(0); }
  });
});
rl.on('close', async () => { await chain.catch(() => {}); await COMMANDS.quit(); process.exit(0); });

console.log('themaithil driver — "help" for commands, "launch" to start');
rl.prompt();
