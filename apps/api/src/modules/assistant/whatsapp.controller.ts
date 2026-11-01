import { Controller, Post, Req, Headers, HttpCode, Inject } from '@nestjs/common';
import type { Request } from 'express';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { Public } from '../auth/guards';
import { parseInbound } from './inbound-payload';
import { DomainError, ErrorCode } from '@themaithil/contracts';
import { AssistantService } from './assistant.service';
import { Conversations } from './conversations';
import { NotificationService } from '../notifications/notifications.service';
import type { Config } from '../../common/config';
import { CONFIG } from '../../common/tokens';

/**
 * What a BSP posts when someone messages us. Deliberately loose about everything we
 * do not use — providers add fields, and a strict schema would start rejecting real
 * messages the day they do.
 */
@Controller('v1/webhooks/whatsapp')
export class WhatsAppInboundController {
  constructor(
    @Inject(AssistantService) private readonly assistant: AssistantService,
    @Inject(Conversations) private readonly conversations: Conversations,
    @Inject(NotificationService) private readonly notify: NotificationService,
    @Inject(CONFIG) private readonly config: Config,
  ) {}

  /**
   * Inbound WhatsApp.
   *
   * `@Public` because the BSP cannot hold a JWT — the signature over the raw body IS
   * the authentication, exactly as for the Razorpay webhook.
   *
   * Always answers 200 once the message is claimed. A non-2xx makes the BSP retry,
   * and retrying a message we already acted on would run the agent twice — which for
   * an agent that creates bookings is not a duplicate log line, it is a duplicate
   * booking.
   */
  @Public()
  @Post()
  @HttpCode(200)
  async inbound(
    @Req() req: Request & { rawBody?: Buffer },
    @Headers('x-hub-signature-256') signature: string,
  ) {
    const raw = req.rawBody?.toString('utf8');
    if (!raw) {
      throw new DomainError(ErrorCode.FORBIDDEN, 'raw body unavailable');
    }
    this.verify(raw, signature);

    const parsed = parseInbound(JSON.parse(raw));
    if ('ignored' in parsed) {
      /*
       * Not worth retrying: a delivery receipt will not become a message on the
       * third attempt, and a shape we do not understand will not become
       * understandable either. `parseInbound` has already logged the skeleton of
       * anything genuinely unrecognised.
       */
      return { status: 'ignored' as const, reason: parsed.ignored };
    }
    const msg = parsed;

    const fresh = await this.conversations.claimInbound({
      providerMessageId: msg.providerMessageId, phone: msg.from, body: msg.text,
    });
    if (!fresh) return { status: 'duplicate' as const };

    const caller = await this.conversations.identify(msg.from);
    if (!caller) {
      /*
       * A number we do not know.
       *
       * No account means no tools — there is nothing of theirs to read and nothing
       * they may change. Rather than run a toolless agent, send them to the place
       * where they can actually get an account.
       */
      await this.notify.sendToPhone({
        phone: msg.from, templateKey: 'assistant.unknown_number',
        variables: {}, locale: 'bn',
      });
      return { status: 'unknown_number' as const };
    }

    const history = await this.conversations.history(caller.phone);
    const out = await this.assistant.reply({ caller, text: msg.text, history });
    await this.conversations.save(caller.phone, caller.userId, out.history);

    /*
     * Sent as a session message, not a template.
     *
     * We are replying seconds after they wrote to us, which is inside the 24-hour
     * window where WhatsApp permits free-form text — so this needs no approved
     * template and is not blocked on the BSP's 1–2 week approval cycle. It also
     * avoids a `{{text}}` passthrough template, which some BSPs refuse.
     */
    await this.notify.sendSessionReply({
      phone: caller.phone, userId: caller.userId, body: out.text,
    });

    return { status: 'replied' as const };
  }

  /**
   * The signature over the exact bytes received.
   *
   * `timingSafeEqual` rather than `===`, and a length check first because it throws
   * on mismatched lengths. Without a configured secret this refuses everything: an
   * unauthenticated endpoint that runs an agent against a phone number the caller
   * chose would let anyone read anyone's bookings by claiming to be their number.
   */
  private verify(raw: string, signature: string | undefined) {
    const secret = this.config.WHATSAPP_INBOUND_SECRET;
    if (!secret) {
      throw new DomainError(
        ErrorCode.FORBIDDEN, 'inbound messaging is not configured',
      );
    }
    const expected = `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`;
    const a = Buffer.from(expected);
    const b = Buffer.from(signature ?? '');
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      throw new DomainError(ErrorCode.FORBIDDEN, 'bad signature');
    }
  }
}
