import { Logger } from '@nestjs/common';

export interface SendResult { providerRef: string }

export interface Channel {
  readonly name: 'whatsapp' | 'sms' | 'push';
  send(args: {
    to: string; templateKey: string; providerTemplateName: string | null;
    body: string; variables: Record<string, string>;
  }): Promise<SendResult>;
}

/**
 * WhatsApp via a BSP (Gupshup / Interakt / AiSensy).
 *
 * WhatsApp will not deliver free-form text outside a 24-hour customer service window,
 * so every message we initiate must map to a template the BSP has had approved.
 * Approval takes 1-2 weeks PER BATCH, which is why it is a week-1 procurement item
 * (P0-0) and why `providerTemplateName` is nullable in the schema: we can author and
 * test templates before approval lands, and the send fails loudly rather than
 * silently dropping.
 */
export class WhatsAppChannel implements Channel {
  readonly name = 'whatsapp' as const;
  constructor(
    private readonly apiUrl: string,
    private readonly apiKey: string,
    private readonly sender: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async send(args: {
    to: string; templateKey: string; providerTemplateName: string | null;
    body: string; variables: Record<string, string>;
  }): Promise<SendResult> {
    if (!args.providerTemplateName) {
      throw new Error(
        `template "${args.templateKey}" has no approved WhatsApp template name yet`,
      );
    }
    const res = await this.fetchImpl(this.apiUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', apikey: this.apiKey },
      body: JSON.stringify({
        channel: 'whatsapp',
        source: this.sender,
        destination: args.to.replace('+', ''),
        template: { id: args.providerTemplateName, params: Object.values(args.variables) },
      }),
    });
    if (!res.ok) {
      throw new Error(`whatsapp send failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
    }
    const json = (await res.json()) as { messageId?: string };
    return { providerRef: json.messageId ?? 'unknown' };
  }
}

/** SMS fallback. Plain text, no template approval, higher cost, always deliverable. */
export class SmsChannel implements Channel {
  readonly name = 'sms' as const;
  constructor(
    private readonly authKey: string,
    private readonly senderId: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async send(args: { to: string; body: string }): Promise<SendResult> {
    const res = await this.fetchImpl('https://control.msg91.com/api/v5/flow/', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authkey: this.authKey },
      body: JSON.stringify({
        sender: this.senderId, mobiles: args.to.replace('+', ''), message: args.body,
      }),
    });
    if (!res.ok) {
      throw new Error(`sms send failed (${res.status})`);
    }
    const json = (await res.json()) as { request_id?: string };
    return { providerRef: json.request_id ?? 'unknown' };
  }
}

/** Development channel: logs instead of sending. Also what the tests assert against. */
export class ConsoleChannel implements Channel {
  readonly name = 'whatsapp' as const;
  private readonly log = new Logger('notify');
  readonly sent: Array<{ to: string; templateKey: string; body: string }> = [];

  async send(args: { to: string; templateKey: string; body: string }): Promise<SendResult> {
    this.sent.push({ to: args.to, templateKey: args.templateKey, body: args.body });
    this.log.log(`[${args.templateKey}] → ${args.to}: ${args.body}`);
    return { providerRef: `console_${this.sent.length}` };
  }
}
