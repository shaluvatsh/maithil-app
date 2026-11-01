#!/usr/bin/env node
/**
 * Prove the email provider actually delivers, before a devotee depends on it.
 *
 * WHY THIS EXISTS. `HttpEmailChannel` has been in the tree, correct-looking and
 * fully typed, without ever having sent a single real message — there was no
 * account to send from. Its own comment said so. The failure mode that creates is
 * the worst available one: the one email this product sends is a password reset,
 * and the only person who finds out it does not work is someone already locked out.
 * `requestPasswordReset` deliberately swallows send failures so a provider outage
 * cannot take sign-in down with it, which means nothing surfaces either.
 *
 * So the first real send should be deliberate, and should happen the hour the key
 * arrives rather than the day someone forgets their password.
 *
 * USAGE, from the repo root:
 *
 *   EMAIL_API_URL=https://api.resend.com/emails \
 *   EMAIL_API_KEY=re_xxx \
 *   EMAIL_FROM='TheMaithil <no-reply@themaithil.in>' \
 *   node apps/api/src/scripts/smoke-email.mjs you@example.com
 *
 * It sends ONE message, shaped exactly as the real reset mail is — same envelope,
 * same text part, same HTML part, same clickable link — so what lands in the inbox
 * is what a devotee would receive, not an approximation of it.
 *
 * WHAT TO CHECK IN THE INBOX, because a 200 only proves the provider accepted it:
 *   1. It arrived at all, and in Inbox rather than Spam. A brand-new sending domain
 *      with no reputation lands in Spam until SPF and DKIM verify — if it does,
 *      the DNS records are not right yet, and that is the actual work.
 *   2. The link is CLICKABLE. That is the whole purpose of the HTML part.
 *   3. The From name and address read as TheMaithil, not as the provider.
 */

const [, , to] = process.argv;
const { EMAIL_API_URL, EMAIL_API_KEY, EMAIL_FROM } = process.env;

if (!to || !EMAIL_API_URL || !EMAIL_API_KEY || !EMAIL_FROM) {
  console.error(
    'usage: EMAIL_API_URL=... EMAIL_API_KEY=... EMAIL_FROM=... '
    + 'node apps/api/src/scripts/smoke-email.mjs <recipient@example.com>',
  );
  process.exit(2);
}

/*
 * The real reset body, verbatim from `AuthService.requestPasswordReset`, with a
 * token that goes nowhere. A smoke test that sends "hello world" proves the
 * provider works and tells you nothing about whether YOUR mail works: it is the
 * long URL, the wrapping and the link that get mangled or filtered.
 */
const resetUrl = 'https://themaithil.in/reset-password?token=smoke-test-not-a-real-token';
const body = 'We received a request to reset your TheMaithil password.\n\n'
  + `Open this link within 30 minutes to choose a new one:\n${resetUrl}\n\n`
  + 'If you did not ask for this, you can ignore this email — your '
  + 'password will not change.';

/** Kept in step with `htmlFromText` in email-channel.ts — escape, then linkify. */
const html = (() => {
  const escaped = body
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const linked = escaped.replace(/https?:\/\/[^\s<]+/g, (u) => `<a href="${u}">${u}</a>`);
  return '<div style="font-family:system-ui,sans-serif;font-size:15px;line-height:1.5">'
    + linked.replace(/\n/g, '<br>') + '</div>';
})();

const res = await fetch(EMAIL_API_URL, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${EMAIL_API_KEY}` },
  body: JSON.stringify({
    from: EMAIL_FROM,
    to,
    subject: 'Reset your TheMaithil password',
    text: body,
    html,
  }),
});

const raw = await res.text();
if (!res.ok) {
  console.error(`FAILED ${res.status}\n${raw.slice(0, 500)}`);
  /*
   * The two that actually happen, and what each means — both are configuration,
   * not code, and both are invisible from the status line alone.
   */
  if (res.status === 401 || res.status === 403) {
    console.error('\n→ the API key is wrong, revoked, or for a different environment');
  }
  if (res.status === 422 || res.status === 400) {
    console.error(
      '\n→ usually the sending DOMAIN in EMAIL_FROM is not verified with the '
      + 'provider yet. Add their SPF and DKIM records to the domain and wait for '
      + 'them to verify, then run this again',
    );
  }
  process.exit(1);
}

console.log(`SENT → ${to}`);
console.log(raw.slice(0, 200));
console.log(
  '\nA 200 only means the provider ACCEPTED it. Now open the inbox and check:'
  + '\n  1. it arrived, and in Inbox rather than Spam (Spam = SPF/DKIM not verified yet)'
  + '\n  2. the reset link is clickable'
  + '\n  3. the sender reads as TheMaithil',
);
