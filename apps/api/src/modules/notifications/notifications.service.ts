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

    const locale = args.locale ?? person.locale;

    // Fall back to Bengali, which is guaranteed present at seed time (ADR 0009).
    const template =
      (await this.template(args.templateKey, locale)) ??
      (await this.template(args.templateKey, 'bn'));
    if (!template) return { status: 'failed' };

    const body = render(template.body, args.variables);
    const id = ulid();
    await this.db.insert(notifications).values({
      id, userId: args.userId, templateKey: args.templateKey,
      channel: this.primary.name, payload: args.variables, status: 'queued',
    });

    for (const channel of [this.primary, this.fallback].filter(Boolean) as Channel[]) {
      try {
        const res = await channel.send({
          to: person.phone,
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
