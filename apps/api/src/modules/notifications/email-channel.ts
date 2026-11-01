import { Logger } from '@nestjs/common';

export interface EmailSendResult { providerRef: string }

export interface EmailChannel {
  send(args: { to: string; subject: string; body: string }): Promise<EmailSendResult>;
}

/**
 * A minimal HTML part from our own plain text.
 *
 * ESCAPE FIRST, THEN LINKIFY — never the other way round. Escaping after inserting
 * the anchor would mangle the tag we just built; linkifying unescaped text would let
 * any `<` in the body open an element. The input is our own templates today, but a
 * mail body is exactly the place where "it is our own content" stops being true.
 *
 * Deliberately plain: no styling, no images, no tracking pixel. A reset mail that
 * looks like a newsletter is a reset mail that gets filtered like one.
 */
export function htmlFromText(text: string): string {
  const escaped = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
  const linked = escaped.replace(
    /https?:\/\/[^\s<]+/g,
    (url) => `<a href="${url}">${url}</a>`,
  );
  return `<div style="font-family:system-ui,sans-serif;font-size:15px;line-height:1.5">`
    + linked.replace(/\n/g, '<br>')
    + `</div>`;
}

/**
 * Transactional email via a generic HTTP provider.
 *
 * A plain POST to a configured endpoint rather than a vendor SDK — same reasoning
 * as `WhatsAppChannel`/`SmsChannel`: most transactional email APIs accept a JSON
 * POST close enough to this shape that pointing `EMAIL_API_URL` at the real one is
 * the whole integration.
 *
 * CHECKED AGAINST RESEND'S PUBLISHED API (29 Oct 2026), which this envelope already
 * matched field for field: `POST https://api.resend.com/emails`, an
 * `Authorization: Bearer` header, a body of `from` / `to` / `subject` / `text`, and
 * a `{ "id": "..." }` response. `to` accepts a bare string as well as an array, so
 * nothing here needed changing. The other candidates differ: SendGrid wants a
 * `personalizations` array, and SES's HTTP API wants SigV4 request signing rather
 * than a bearer token, so neither works without a channel of its own.
 *
 * Still unexercised against a live account — there is no key yet. `scripts/
 * smoke-email.mjs` exists to settle that in one command the moment there is one.
 */
export class HttpEmailChannel implements EmailChannel {
  constructor(
    private readonly apiUrl: string,
    private readonly apiKey: string,
    private readonly from: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async send(args: { to: string; subject: string; body: string }): Promise<EmailSendResult> {
    const res = await this.fetchImpl(this.apiUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify({
        from: this.from,
        to: args.to,
        subject: args.subject,
        text: args.body,
        /*
         * AN HTML PART AS WELL, for the one reason that decides whether this email
         * works at all: THE LINK HAS TO BE CLICKABLE.
         *
         * The only mail this product sends is a password reset, and its entire
         * payload is a URL. Plenty of clients do not auto-link a bare URL in a
         * text/plain body, which leaves the reader copying a 100-character link by
         * hand off a phone screen — on the one screen reached by someone already
         * locked out and already frustrated.
         *
         * A multipart message is also materially less likely to be filtered as
         * spam than a text-only one, which matters for a brand-new sending domain
         * with no reputation.
         *
         * Derived here rather than asked of callers: there is one caller today, and
         * making every future one hand-write two bodies is how the two drift.
         */
        html: htmlFromText(args.body),
      }),
    });
    if (!res.ok) {
      throw new Error(`email send failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
    }
    const json = (await res.json().catch(() => ({}))) as { id?: string };
    return { providerRef: json.id ?? 'unknown' };
  }
}

/** Development channel: logs instead of sending. Also what the tests assert against. */
export class ConsoleEmailChannel implements EmailChannel {
  private readonly log = new Logger('notify');
  readonly sent: Array<{ to: string; subject: string; body: string }> = [];

  async send(args: { to: string; subject: string; body: string }): Promise<EmailSendResult> {
    this.sent.push(args);
    this.log.log(`[email] → ${args.to}: ${args.subject}`);
    return { providerRef: `console_${this.sent.length}` };
  }
}
