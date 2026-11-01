import { ulid } from 'ulid';
import { eq, and } from 'drizzle-orm';
import type { Db } from '../../db/client';
import { notificationTemplates, notifications, users } from '../../db/schema/index';
import type { Channel } from './channels';
import type { Locale } from '@themaithil/contracts';

/**
 * Renders and sends. WhatsApp first, SMS on failure - the market is WhatsApp-first,
 * but a purohit who does not get an OTP is a failed booking, so we never let a
 * WhatsApp problem be the end of the story.
 */
export function render(body: string, variables: Record<string, string>): string {
  return body.replace(/\{\{(\w+)\}\}/g, (_, key: string) => variables[key] ?? `{{${key}}}`);
}

/**
 * Variables that must never be written down.
 *
 * `notifications.payload` keeps every variable so ops can see what was sent, which
 * is right for a date or a purohit's name and wrong for a one-time code: OtpService
 * stores only an HMAC precisely so that a copy of the database is not a list of
 * valid codes, and persisting the plaintext here would hand back what the hashing
 * was protecting — for login OTPs, that is account takeover.
 *
 * Redacted rather than dropped, so the row still shows that a code was sent.
 */
const SECRET_VARIABLES = new Set(['otp']);

export function redact(variables: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(variables)) {
    out[k] = SECRET_VARIABLES.has(k) ? '[redacted]' : v;
  }
  return out;
}

export class NotificationService {
  constructor(
    private readonly db: Db,
    private readonly primary: Channel,
    private readonly fallback?: Channel,
  ) {}

  async send(args: {
    userId: string;
    templateKey: string;
    variables: Record<string, string>;
    locale?: Locale;
  }): Promise<{ status: 'sent' | 'failed'; channel?: string }> {
    const person = (await this.db.select({ phone: users.phone, locale: users.locale })
      .from(users).where(eq(users.id, args.userId)).limit(1))[0];
    if (!person) return { status: 'failed' };

    return this.deliver({
      to: person.phone,
      userId: args.userId,
      templateKey: args.templateKey,
      variables: args.variables,
      locale: args.locale ?? person.locale,
    });
  }

  /**
   * Sends to a phone number rather than to an account.
   *
   * A login OTP is the one message that cannot go through `send()`: the whole point
   * of it is that the person may not have an account yet, so there is no `userId` to
   * look up and no stored `locale` to read. Signup is exactly when this matters
   * most, and requiring a user row would have made the message undeliverable to
   * every new devotee and every new purohit.
   */
  async sendToPhone(args: {
    phone: string;
    templateKey: string;
    variables: Record<string, string>;
    locale: Locale;
  }): Promise<{ status: 'sent' | 'failed'; channel?: string }> {
    return this.deliver({ to: args.phone, userId: null, ...args });
  }

  private async deliver(args: {
    to: string;
    userId: string | null;
    templateKey: string;
    variables: Record<string, string>;
    locale: Locale;
  }): Promise<{ status: 'sent' | 'failed'; channel?: string }> {
    // Fall back to Bengali, which is guaranteed present at seed time (ADR 0009).
    const template =
      (await this.template(args.templateKey, args.locale)) ??
      (await this.template(args.templateKey, 'bn'));
    if (!template) {
      /*
       * Recorded, not silently dropped.
       *
       * This returned `failed` and wrote nothing — so a template that had been
       * written into the seed but never seeded into a given database produced a
       * message that simply did not exist: no row, no log line, nothing for ops to
       * chase. Two of them (`booking.join_link.devotee`,
       * `booking.recording.devotee`) were found exactly this way, and only because
       * someone happened to query the table.
       *
       * The row is the whole point of this table — every other failure path below
       * already writes one and marks it `failed`. A missing template is the failure
       * MOST worth seeing, because it is a deployment mistake rather than a flaky
       * provider, and it will never recover on its own.
       */
      await this.db.insert(notifications).values({
        id: ulid(),
        ...(args.userId ? { userId: args.userId } : {}),
        templateKey: args.templateKey,
        channel: this.primary.name,
        payload: redact(args.variables),
        status: 'failed',
        failedReason: `no ${args.templateKey} template for ${args.locale} or bn`,
      });
      return { status: 'failed' };
    }

    const body = render(template.body, args.variables);
    const id = ulid();
    await this.db.insert(notifications).values({
      id,
      ...(args.userId ? { userId: args.userId } : {}),
      templateKey: args.templateKey,
      channel: this.primary.name,
      payload: redact(args.variables),
      status: 'queued',
    });

    for (const channel of [this.primary, this.fallback].filter(Boolean) as Channel[]) {
      try {
        const res = await channel.send({
          to: args.to,
          templateKey: args.templateKey,
          providerTemplateName: template.providerTemplateName,
          body,
          variables: args.variables,
        });
        await this.db.update(notifications).set({
          status: 'sent', channel: channel.name,
          providerRef: res.providerRef, sentAt: new Date().toISOString(),
        }).where(eq(notifications.id, id));
        return { status: 'sent', channel: channel.name };
      } catch (e) {
        await this.db.update(notifications).set({
          status: 'failed', failedReason: e instanceof Error ? e.message : String(e),
        }).where(eq(notifications.id, id));
      }
    }
    return { status: 'failed' };
  }

  /**
   * A free-form reply to someone who just messaged us.
   *
   * No template, and deliberately so. WhatsApp only blocks free-form text OUTSIDE
   * the 24-hour window a customer opens by writing to us — and this is only ever
   * called from the inbound webhook, seconds after they did. Routing the assistant
   * through a template instead would have made it wait on 1–2 weeks of BSP approval
   * per batch to say something a person is sitting there waiting to read, and would
   * have needed a `{{text}}` passthrough template that some BSPs refuse outright.
   *
   * Still recorded in `notifications` like everything else: a reply that failed to
   * send is exactly as important to be able to chase as a booking confirmation.
   */
  async sendSessionReply(args: {
    phone: string; userId: string | null; body: string;
  }): Promise<{ status: 'sent' | 'failed'; channel?: string }> {
    const id = ulid();
    await this.db.insert(notifications).values({
      id,
      ...(args.userId ? { userId: args.userId } : {}),
      templateKey: 'assistant.session',
      channel: this.primary.name,
      // The assistant's own words, not user-supplied variables — nothing to redact,
      // and the text is what an operator would need to see to chase a complaint.
      payload: { body: args.body.slice(0, 2000) },
      status: 'queued',
    });

    const channels = [this.primary, this.fallback].filter(Boolean) as Channel[];
    for (const channel of channels) {
      // A channel with no session support cannot help here; skipping it is better
      // than sending this through a template path that would reject it.
      if (!channel.sendSession) continue;
      try {
        const res = await channel.sendSession({ to: args.phone, body: args.body });
        await this.db.update(notifications).set({
          status: 'sent', channel: channel.name,
          providerRef: res.providerRef, sentAt: new Date().toISOString(),
        }).where(eq(notifications.id, id));
        return { status: 'sent', channel: channel.name };
      } catch (e) {
        await this.db.update(notifications).set({
          status: 'failed', failedReason: e instanceof Error ? e.message : String(e),
        }).where(eq(notifications.id, id));
      }
    }
    return { status: 'failed' };
  }

  private async template(key: string, locale: Locale) {
    const rows = await this.db.select().from(notificationTemplates)
      .where(and(
        eq(notificationTemplates.key, key),
        eq(notificationTemplates.locale, locale),
        eq(notificationTemplates.active, true),
      )).limit(1);
    return rows[0];
  }
}
