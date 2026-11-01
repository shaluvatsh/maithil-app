import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import { makeHarness, type Harness } from '../../../test/harness';
import { AssistantTools, type Caller } from '../tools';
import { AssistantService, type Model } from '../assistant.service';
import { CatalogueKnowledge } from '../knowledge';

let h: Harness;
let tools: AssistantTools;

/** A caller backed by the harness, for the cases that touch real rows. */
const caller = (): Caller => ({
  userId: h.ids.devoteeId, role: 'devotee', phone: '+919830000001', locale: 'en',
});

/** A caller for the protocol cases, which never reach the database. */
const stubCaller = (): Caller => ({
  userId: 'usr_stub', role: 'devotee', phone: '+919830000001', locale: 'en',
});

/** A model that replays a fixed script, so the loop can be tested without a key. */
class ScriptedModel implements Model {
  readonly requests: Anthropic.MessageCreateParams[] = [];
  constructor(private readonly script: Anthropic.Message[]) {}
  async create(req: Anthropic.MessageCreateParams): Promise<Anthropic.Message> {
    // Snapshot: the service reuses one `messages` array across turns, so storing the
    // reference would show every recorded request the FINAL state of the conversation.
    this.requests.push(structuredClone(req) as Anthropic.MessageCreateParams);
    const next = this.script.shift();
    if (!next) throw new Error('the loop asked for more turns than the script has');
    return next;
  }
}

/** Fields every `Message` carries that a fixture has nothing useful to say about. */
const envelope = {
  id: 'msg', type: 'message', role: 'assistant', model: 'claude-opus-5',
  stop_sequence: null, container: null, stop_details: null,
  usage: { input_tokens: 1, output_tokens: 1 },
} as const;

const say = (text: string): Anthropic.Message => ({
  ...envelope,
  stop_reason: 'end_turn',
  content: [{ type: 'text', text, citations: null }],
} as never);

const callTool = (name: string, input: unknown, id = 'tu_1'): Anthropic.Message => ({
  ...envelope,
  stop_reason: 'tool_use',
  content: [{ type: 'tool_use', id, name, input }],
} as never);

/**
 * A stub corpus and stub tools.
 *
 * Most of what follows tests the PROTOCOL — that every tool_use gets a tool_result in
 * one message, that a refusal is not read as content, that the loop stops. None of
 * that needs a database, and booting Postgres-in-wasm per case is what pushed the
 * suite past the memory ceiling the vitest config warns about. The cases that really
 * do need real data say so by taking the harness.
 */
const stubKnowledge = { corpus: async () => '## Services we offer\n- Test Puja (test-puja)' };
const stubTools = {
  run: async (_c: Caller, name: string) =>
    name === 'set_working_hours'
      ? { content: 'that is only available to purohits, and this account is not one', isError: true }
      : { content: `ran ${name}` },
} as unknown as AssistantTools;

/** No database: protocol only. */
const makeStub = (script: Anthropic.Message[]) => {
  const model = new ScriptedModel(script);
  return { model, service: new AssistantService(model, stubTools, stubKnowledge) };
};

/** Real tools and the real catalogue, for the cases that assert on data. */
const make = (script: Anthropic.Message[]) => {
  const model = new ScriptedModel(script);
  return {
    model,
    service: new AssistantService(model, tools, new CatalogueKnowledge(h.db)),
  };
};

/** Boots Postgres-in-wasm. Called only by the describes that assert on real data. */
const withHarness = () => {
  beforeEach(async () => {
    h = await makeHarness();
    tools = new AssistantTools(h.db, {
      bookableTimes: async () => [{ startsAt: '2026-09-14T06:00:00+05:30', available: true }],
      startDraft: async () => ({ id: 'bk_draft_1' }),
      webBaseUrl: 'https://themaithil.in',
    });
  }, 60_000);
  afterEach(async () => { await h?.pg.close(); });
};

describe('the conversation loop', () => {
  it('returns a plain answer without calling tools', async () => {
    const { service } = makeStub([say('A Satyanarayan Puja takes about two hours.')]);
    const out = await service.reply({ caller: stubCaller(), text: 'how long?', history: [] });
    expect(out.text).toContain('two hours');
  });

  it('carries the conversation forward', async () => {
    const { service } = makeStub([say('Two hours.'), say('Yes, in Kolkata.')]);
    const first = await service.reply({ caller: stubCaller(), text: 'how long?', history: [] });
    const second = await service.reply({
      caller: stubCaller(), text: 'and do you cover Kolkata?', history: first.history,
    });
    expect(second.history.length).toBeGreaterThan(first.history.length);
  });
});

/** The few cases that assert on the real catalogue and real tools. */
describe('the loop over real data', () => {
  withHarness();

  it('runs a tool and feeds the result back', async () => {
    const { service, model } = make([
      callTool('find_rituals', { query: 'satyanarayan' }),
      say('We do Satyanarayan Puja — about two hours.'),
    ]);
    const out = await service.reply({ caller: caller(), text: 'do you do satyanarayan?', history: [] });

    expect(out.text).toContain('Satyanarayan');
    const second = model.requests[1]!;
    const last = second.messages.at(-1)!;
    expect(last.role).toBe('user');
    expect(JSON.stringify(last.content)).toContain('satyanarayan-puja');
  });

  /**
   * Every `tool_use` block must get a `tool_result`, in ONE user message. Splitting
   * them teaches the model to stop calling tools in parallel, and a missing result
   * is a protocol error rather than a silence it can work around.
   */
  it('answers every parallel tool call in a single user message', async () => {
    const parallel = {
      ...envelope,
      stop_reason: 'tool_use',
      content: [
        { type: 'tool_use', id: 'a', name: 'find_rituals', input: { query: 'griha' } },
        { type: 'tool_use', id: 'b', name: 'my_addresses', input: {} },
      ],
    } as never as Anthropic.Message;
    const { service, model } = makeStub([parallel, say('Here are your options.')]);
    await service.reply({ caller: caller(), text: 'book griha pravesh', history: [] });

    const results = model.requests[1]!.messages.filter((m) => m.role === 'user');
    const blocks = results.flatMap((m) =>
      Array.isArray(m.content) ? m.content.filter((b) => (b as { type: string }).type === 'tool_result') : []);
    expect(blocks, 'a parallel call went unanswered or was split across messages').toHaveLength(2);
    expect(blocks.map((b) => (b as { tool_use_id: string }).tool_use_id).sort()).toEqual(['a', 'b']);
  });

  /** A failing tool must come back as a result, not vanish or throw. */
  it('reports a tool failure back to the model instead of throwing', async () => {
    const { service, model } = makeStub([
      callTool('set_working_hours', { weekday: 0, starts_at: '06:00', ends_at: '18:00' }),
      say('Sorry, that is only for purohits.'),
    ]);
    const out = await service.reply({ caller: caller(), text: 'set my hours', history: [] });

    expect(out.text).toContain('purohits');
    const sent = JSON.stringify(model.requests[1]!.messages);
    expect(sent).toContain('is_error');
  });

  /**
   * A refusal arrives as a 200 with `stop_reason: "refusal"` and possibly empty
   * content — reading content first would hand the devotee a blank message.
   */
  it('handles a refusal without sending an empty reply', async () => {
    const refusal = {
      ...envelope, stop_reason: 'refusal', content: [],
    } as never as Anthropic.Message;
    const { service } = makeStub([refusal]);
    const out = await service.reply({ caller: caller(), text: '...', history: [] });
    expect(out.text.trim().length).toBeGreaterThan(0);
    expect(out.text).toContain('cannot help');
  });

  /** Never silence: an empty text block still gets a human reply. */
  it('never returns an empty message', async () => {
    const { service } = makeStub([say('   ')]);
    const out = await service.reply({ caller: caller(), text: 'hi', history: [] });
    expect(out.text.trim().length).toBeGreaterThan(0);
  });

  /** A confused model must not bill forever against a message nobody is watching. */
  it('stops after the turn limit and says so', async () => {
    const { service } = makeStub(Array.from({ length: 12 },
      (_, i) => callTool('find_rituals', { query: 'x' }, `tu_${i}`)));
    const out = await service.reply({ caller: caller(), text: 'loop', history: [] });
    expect(out.text).toContain('pass you to a person');
  });

  /**
   * The instructions and catalogue must sit behind ONE cache breakpoint, with
   * everything that varies after it. Putting the caller in the cached block would
   * give every user their own cache entry and waste the whole mechanism.
   */
  it('caches the instructions and catalogue, not the caller', async () => {
    const { service, model } = make([say('ok')]);
    await service.reply({ caller: caller(), text: 'hi', history: [] });

    const system = model.requests[0]!.system as Anthropic.TextBlockParam[];
    expect(system[0]!.cache_control).toEqual({ type: 'ephemeral' });
    // The slug, not a name — the harness ritual is translated only into Bengali.
    expect(system[0]!.text).toContain('satyanarayan-puja');
    expect(system[1]!.cache_control).toBeUndefined();
    expect(system[1]!.text).toContain('devotee');
  });

  /** No key configured is a polite decline, not a 500 for everyone. */
  it('declines politely when the assistant is not configured', async () => {
    const off = new AssistantService(null, stubTools, stubKnowledge);
    expect(off.enabled).toBe(false);
    const out = await off.reply({ caller: caller(), text: 'hi', history: [] });
    expect(out.text).toContain('not available');
  });
});

describe('the knowledge the assistant is given', () => {
  withHarness();

  it('contains the catalogue with real prices', async () => {
    const text = await new CatalogueKnowledge(h.db).corpus('en');
    expect(text).toContain('satyanarayan-puja');
    expect(text).toMatch(/₹[\d,]+/);
  });

  it('states the policies rather than leaving them to be invented', async () => {
    const text = await new CatalogueKnowledge(h.db).corpus('en');
    expect(text).toContain('48 hours');
    expect(text).toContain('assigns a verified purohit');
  });

  /** Byte-identical across calls, or the prompt cache never hits. */
  it('is stable across calls', async () => {
    const k = new CatalogueKnowledge(h.db);
    expect(await k.corpus('en')).toBe(await k.corpus('en'));
  });
});
