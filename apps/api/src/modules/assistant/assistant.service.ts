import Anthropic from '@anthropic-ai/sdk';
import { TOOL_DEFS, type AssistantTools, type Caller } from './tools';
import type { Knowledge } from './knowledge';

/**
 * The model, kept behind an interface.
 *
 * Not to abstract over providers — this is Claude-specific and the tool shapes are
 * Anthropic's. It exists so the whole loop can be driven by a scripted fake in
 * tests: the tool authorization rules below are the part that must not regress, and
 * proving them should not need a network call or an API key.
 */
export interface Model {
  create(req: Anthropic.MessageCreateParams): Promise<Anthropic.Message>;
}

export class ClaudeModel implements Model {
  private readonly client: Anthropic;
  constructor(apiKey: string) { this.client = new Anthropic({ apiKey }); }
  create(req: Anthropic.MessageCreateParams) {
    return this.client.messages.create(req) as Promise<Anthropic.Message>;
  }
}

/**
 * How many times the model may call tools before we stop it.
 *
 * A booking needs about four — find the ritual, check times, read addresses, create
 * the draft. Eight leaves room for a correction without letting a confused loop bill
 * indefinitely against a WhatsApp message nobody is watching.
 */
const MAX_TURNS = 8;

const SYSTEM = `You are the assistant for TheMaithil, which books Hindu purohits for
pujas in Indian homes. You are talking to someone on WhatsApp.

HOW TO WRITE
- Short. WhatsApp, not email. Two or three sentences unless they asked for a list.
- Reply in the language they wrote in. Most will write Bengali, Hindi, or English,
  often in Latin script — match the script they used, not just the language.
- Plain words. Say "booking amount", not "token". Say "materials", not "samagri
  procurement". Never mention internal states, ids, or table names.

WHAT YOU KNOW
The section below is the whole of what this platform offers and how it works. If an
answer is not in it and not from a tool, say you do not know and offer to pass it to
a person. Never invent a price, a date, a policy, or a purohit's name.

WHAT YOU DO NOT DO
- You never take payment and never confirm a booking. You create a draft and send a
  link; they pay on the website, where they see the assigned purohit and the full
  price first. Say so plainly — never imply a booking is confirmed when it is not.
- You do not give religious rulings. You can say what a puja is for, what it needs,
  and when it is traditionally done. If asked whether something is permitted, or what
  a family should do, say that is for their own purohit or elders to decide.
- You do not answer questions unrelated to pujas, this platform, or the panchang.
  Say that is outside what you can help with, and offer a person.
- You never discuss another customer, another purohit, or anything you were not
  given by a tool for the person you are talking to.

BEFORE YOU BOOK
Confirm all four with them in their own words first: which puja, which date, what
time, and which address. Check real availability with a tool — never guess a time.
Then create the draft and send the link.`;

export class AssistantService {
  constructor(
    private readonly model: Model | null,
    private readonly tools: AssistantTools,
    private readonly knowledge: Knowledge,
  ) {}

  /** Whether the assistant is configured at all. */
  get enabled(): boolean { return this.model !== null; }

  /**
   * One inbound message, start to finish.
   *
   * `history` is the conversation so far, loaded from storage — WhatsApp delivers
   * each message as its own HTTP request, so there is no long-lived process holding
   * a session. The returned history is what to store back.
   */
  async reply(args: {
    caller: Caller;
    text: string;
    history: Anthropic.MessageParam[];
  }): Promise<{ text: string; history: Anthropic.MessageParam[] }> {
    if (!this.model) {
      return {
        text: 'Sorry — messaging support is not available right now. '
          + 'Please use the website or call us.',
        history: args.history,
      };
    }

    const corpus = await this.knowledge.corpus(args.caller.locale);
    const messages: Anthropic.MessageParam[] = [
      ...args.history,
      { role: 'user', content: args.text },
    ];

    for (let turn = 0; turn < MAX_TURNS; turn++) {
      const res = await this.model.create({
        model: 'claude-opus-5',
        max_tokens: 4096,
        /*
         * Adaptive thinking at medium effort. This is a latency-sensitive chat route
         * where someone is watching a "typing" indicator, so the top of the effort
         * range buys nothing — but it does book pujas, so it is not a `low` route
         * either.
         */
        thinking: { type: 'adaptive' },
        output_config: { effort: 'medium' },
        system: [
          /*
           * One cache breakpoint, after the catalogue.
           *
           * The instructions and the catalogue are byte-identical for every message
           * from every user in a locale, so they are written to cache once and read
           * back for the rest. Everything that varies — who is asking, what they
           * said — sits in `messages`, after the breakpoint. Putting the caller's
           * name up here instead would give every user their own cache entry and
           * defeat the whole thing.
           */
          { type: 'text', text: `${SYSTEM}\n\n${corpus}`, cache_control: { type: 'ephemeral' } },
          { type: 'text', text: `The person you are talking to is a ${args.caller.role}.` },
        ],
        tools: TOOL_DEFS,
        messages,
      });

      messages.push({ role: 'assistant', content: res.content });

      /*
       * A refusal is not an exception. It arrives as a 200 with `stop_reason:
       * "refusal"` and content that may be empty, so reading `content` first would
       * hand the devotee a blank message.
       */
      if (res.stop_reason === 'refusal') {
        return {
          text: 'Sorry, I cannot help with that one. I can put you through to '
            + 'a person if you would like.',
          history: messages,
        };
      }

      if (res.stop_reason !== 'tool_use') {
        const text = res.content
          .filter((b): b is Anthropic.TextBlock => b.type === 'text')
          .map((b) => b.text).join('\n').trim();
        return {
          text: text || 'Sorry, I did not catch that — could you say it again?',
          history: messages,
        };
      }

      /*
       * Every tool_use block gets a tool_result, in ONE user message.
       *
       * Splitting them across messages, or dropping the result of a call that
       * failed, teaches the model to stop calling tools in parallel — and a missing
       * result is a protocol error, not a silence the model can work around.
       */
      const calls = res.content.filter(
        (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use',
      );
      const results = await Promise.all(calls.map(async (call) => {
        const out = await this.tools.run(args.caller, call.name, call.input);
        return {
          type: 'tool_result' as const,
          tool_use_id: call.id,
          content: out.content,
          ...(out.isError ? { is_error: true } : {}),
        };
      }));
      messages.push({ role: 'user', content: results });
    }

    /*
     * Out of turns. Says so rather than going quiet — a WhatsApp message that never
     * gets a reply reads as the business ignoring you.
     */
    return {
      text: 'Sorry, I am having trouble with that. Let me pass you to a person.',
      history: messages,
    };
  }
}
