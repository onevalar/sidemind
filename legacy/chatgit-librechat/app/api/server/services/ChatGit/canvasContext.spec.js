const ctx = require('./canvasContext');

let clock = 0;
function n(id, parentIds, data = {}) {
  clock += 1;
  return { id, parentIds, status: 'done', question: `Q-${id}`, answer: `A-${id}`, createdAt: new Date(clock * 1000), ...data };
}
const graph = (...nodes) => new Map(nodes.map((x) => [x.id, x]));
const userTexts = (messages) => messages.filter((m) => m.role === 'user').map((m) => m.content);

describe('canvasContext.buildMessages', () => {
  beforeEach(() => {
    clock = 0;
  });

  it('continues a branch with its full path and excludes sibling branches', () => {
    const g = graph(n('r', []), n('a', ['r']), n('b', ['r']), n('a2', ['a']));
    const { messages } = ctx.buildMessages(g, { parentIds: ['a2'], question: 'next' });
    expect(messages[0].role).toBe('system');
    expect(userTexts(messages)).toEqual(['Q-r', 'Q-a', 'Q-a2', 'next']);
    expect(messages.some((m) => m.content === 'A-b')).toBe(false);
  });

  it('merges branches with the shared ancestor sent once, in creation order', () => {
    const g = graph(n('r', []), n('a', ['r']), n('b', ['r']), n('c', ['b']));
    const { messages } = ctx.buildMessages(g, { parentIds: ['a', 'c'], question: 'compare' });
    expect(userTexts(messages)).toEqual(['Q-r', 'Q-a', 'Q-b', 'Q-c', 'compare']);
    expect(messages.filter((m) => m.content === 'A-r')).toHaveLength(1);
    expect(messages.some((m) => m.role === 'system' && /combining 2 branches/.test(m.content))).toBe(true);
  });

  it('renders quoted passages and empty questions as "explain this"', () => {
    const g = graph(n('r', []));
    const { messages } = ctx.buildMessages(g, { parentIds: ['r'], items: [{ quote: 'JEPA', q: '', source: 'r' }] });
    const last = messages[messages.length - 1].content;
    expect(last).toContain('"""\nJEPA\n"""');
    expect(last).toContain('请解释这段内容。');
  });

  it('starts a new tree with only the system prompt and the question', () => {
    const { messages } = ctx.buildMessages(new Map(), { parentIds: [], question: 'hello' });
    expect(messages).toEqual([{ role: 'system', content: ctx.SYSTEM_PROMPT }, { role: 'user', content: 'hello' }]);
  });

  it('replaces old turns with summaries only when the path is long and a summary exists', () => {
    const long = 'x'.repeat(ctx.COMPRESS_ABOVE_CHARS);
    const nodes = [n('r', [], { answer: long, summary: 'root summary' })];
    for (let i = 1; i <= 5; i++) {
      nodes.push(n(`s${i}`, [nodes[i - 1].id], { summary: i === 1 ? '' : `sum ${i}` }));
    }
    const g = graph(...nodes);
    const { messages, plan } = ctx.buildMessages(g, { parentIds: ['s5'], question: 'go' });
    const modes = Object.fromEntries(plan.map((p) => [p.node.id, p.mode]));
    expect(modes).toEqual({ r: 'summary', s1: 'raw', s2: 'summary', s3: 'raw', s4: 'raw', s5: 'raw' });
    expect(messages.some((m) => m.content === long)).toBe(false);
    expect(messages.find((m) => m.role === 'system' && /summarized/.test(m.content)).content).toContain('root summary');
    // s1 has no summary yet: it is sent verbatim, never dropped.
    expect(userTexts(messages)).toContain('Q-s1');
  });

  it('keeps every direct merge source verbatim even when compressing', () => {
    const long = 'y'.repeat(ctx.COMPRESS_ABOVE_CHARS);
    const g = graph(
      n('r', [], { answer: long, summary: 'r-sum' }),
      n('a', ['r'], { summary: 'a-sum' }),
      n('b', ['r'], { summary: 'b-sum' }),
      n('b2', ['b'], { summary: 'b2-sum' }),
      n('b3', ['b2'], { summary: 'b3-sum' }),
      n('b4', ['b3'], { summary: 'b4-sum' }),
    );
    const { plan } = ctx.buildMessages(g, { parentIds: ['a', 'b4'], question: 'merge' });
    const modes = Object.fromEntries(plan.map((p) => [p.node.id, p.mode]));
    expect(modes.a).toBe('raw');
    expect(modes.b4).toBe('raw');
    expect(modes.r).toBe('summary');
  });
});

describe('canvasContext.normalizeRequest', () => {
  const g = graph(n('r', []), n('a', ['r']), n('busy', ['r'], { status: 'streaming' }));

  it('accepts quotes from anywhere on the selected path', () => {
    const out = ctx.normalizeRequest({ parentIds: ['a'], items: [{ quote: 'x', q: 'why', source: 'r' }] }, g);
    expect(out).toEqual({ parentIds: ['a'], items: [{ quote: 'x', q: 'why', source: 'r' }], question: '' });
  });

  it.each([
    [{ parentIds: ['nope'], question: 'q' }, 'source not found'],
    [{ parentIds: ['busy'], question: 'q' }, 'source answer is not finished'],
    [{ parentIds: ['a'], question: '  ' }, 'empty question'],
    [{ parentIds: ['a'], items: [{ quote: '', source: 'a' }] }, 'invalid quoted passage'],
    [{ parentIds: ['a'], items: [{ quote: 'x', source: 'busy' }] }, 'quoted passage is not on the selected path'],
    [{ parentIds: Array.from({ length: 13 }, (_, i) => `p${i}`), question: 'q' }, 'at most 12 sources'],
  ])('rejects %j', (body, message) => {
    expect(() => ctx.normalizeRequest(body, g)).toThrow(message);
  });
});

describe('canvasContext.previewContext', () => {
  it('lists the turns the next question carries', () => {
    clock = 0;
    const g = graph(n('r', []), n('a', ['r']));
    expect(ctx.previewContext(g, ['a'])).toEqual({
      merged: false,
      turns: [
        { id: 'r', title: 'Q-r', mode: 'raw' },
        { id: 'a', title: 'Q-a', mode: 'raw' },
      ],
    });
  });
});
