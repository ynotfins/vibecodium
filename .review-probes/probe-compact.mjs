import { compactHistory, CompactError, MAX_BUDGET_TOKENS } from 'file:///D:/vibecodium.goal.worktrees/m2-compact/src/stable/context-engine/compact.mjs';

let failures = 0;
function expectCompact(label, fn) {
  try {
    fn();
    console.log('FAIL(no-throw) ' + label);
    failures += 1;
  } catch (error) {
    if (error instanceof CompactError) {
      console.log('ok ' + label + ' -> CompactError ' + error.code);
    } else {
      console.log('FAIL(raw-' + (error && error.constructor && error.constructor.name) + ') ' + label + ' -> ' + String(error));
      failures += 1;
    }
  }
}

const keyMax = ['max', 'Tokens'].join('');
const fullHistory = [
  { role: 'system', content: 'rules\n' },
  { role: 'user', content: 'a\nb\nc\n' },
  { role: 'assistant', content: 'd\ne\n' },
];

{
  const r = Proxy.revocable({ messages: fullHistory, [keyMax]: 10 }, {});
  r.revoke();
  expectCompact('revoked proxy as options', () => compactHistory(r.proxy));

  const m = Proxy.revocable(fullHistory, {});
  m.revoke();
  expectCompact('revoked proxy as messages array', () => compactHistory({ messages: m.proxy, [keyMax]: 10 }));

  const e = Proxy.revocable({ role: 'user', content: 'x' }, {});
  e.revoke();
  expectCompact('revoked proxy as message element', () => compactHistory({ messages: [e.proxy], [keyMax]: 10 }));

  const p = Proxy.revocable([0], {});
  p.revoke();
  expectCompact('revoked proxy as pinned', () => compactHistory({ messages: fullHistory, [keyMax]: 10, pinned: p.proxy }));

  const t = Proxy.revocable((text) => text.length, {});
  t.revoke();
  expectCompact('revoked proxy as tokenizer', () => compactHistory({ messages: fullHistory, [keyMax]: 10_000, tokenizer: t.proxy }));

  const b = Proxy.revocable({}, {});
  b.revoke();
  expectCompact('revoked proxy as maxTokens value', () => compactHistory({ messages: fullHistory, [keyMax]: b.proxy }));
}

function throwingProxy(trapName, target) {
  return new Proxy(target, { [trapName]: () => { throw new TypeError('hostile ' + trapName); } });
}
expectCompact('throwing options proxy getPrototypeOf', () => compactHistory(throwingProxy('getPrototypeOf', { messages: [], [keyMax]: 10 })));
expectCompact('throwing options proxy ownKeys', () => compactHistory(throwingProxy('ownKeys', { messages: [], [keyMax]: 10 })));
expectCompact('throwing options proxy getOwnPropertyDescriptor', () => compactHistory(throwingProxy('getOwnPropertyDescriptor', {})));
expectCompact('throwing messages proxy isArray/index', () => compactHistory({ messages: throwingProxy('getOwnPropertyDescriptor', []), [keyMax]: 10 }));
expectCompact('throwing messages proxy get', () => compactHistory({ messages: throwingProxy('get', []), [keyMax]: 10 }));
expectCompact('throwing message element ownKeys', () => compactHistory({ messages: [throwingProxy('ownKeys', { role: 'user', content: 'x' })], [keyMax]: 10 }));
expectCompact('throwing message element getPrototypeOf', () => compactHistory({ messages: [throwingProxy('getPrototypeOf', {})], [keyMax]: 10 }));
expectCompact('throwing pinned proxy descriptor', () => compactHistory({ messages: fullHistory, [keyMax]: 10, pinned: throwingProxy('getOwnPropertyDescriptor', []) }));
expectCompact('throwing pinned proxy get', () => compactHistory({ messages: fullHistory, [keyMax]: 10, pinned: throwingProxy('get', []) }));
expectCompact('throwing message content proxy', () => compactHistory({ messages: [{ role: 'user', content: throwingProxy('getPrototypeOf', {}) }], [keyMax]: 10 }));
{
  const options = new Proxy({ messages: fullHistory, [keyMax]: 10 }, { get() { throw new TypeError('hostile get'); } });
  expectCompact('throwing get trap on options', () => compactHistory(options));
  const element = new Proxy({ role: 'user', content: 'x' }, { get() { throw new TypeError('hostile get'); } });
  expectCompact('throwing get trap on message element', () => compactHistory({ messages: [element], [keyMax]: 10 }));
  const tokenizer = new Proxy((text) => text.length, { apply() { throw new TypeError('hostile apply'); } });
  expectCompact('throwing apply trap on tokenizer', () => compactHistory({ messages: fullHistory, [keyMax]: 10_000, tokenizer }));
  const undefinedDesc = new Proxy([], { getOwnPropertyDescriptor() { return undefined; } });
  expectCompact('undefined descriptor on messages index', () => {
    const target = [{ role: 'user', content: 'x' }];
    const sparseLike = new Proxy(target, { getOwnPropertyDescriptor(t, k) { return k === 'length' ? Reflect.getOwnPropertyDescriptor(t, k) : undefined; } });
    return compactHistory({ messages: sparseLike, [keyMax]: 10 });
  });
}

let cases = 0;
function floor(text) { return text.length === 0 ? 0 : Buffer.byteLength(text, 'utf8') + 1; }
function assertNotOver(label, budget, tokenizer, messages) {
  let result;
  try {
    result = compactHistory({ messages, [keyMax]: budget, tokenizer });
  } catch (error) {
    if (!(error instanceof CompactError)) {
      console.log('FAIL(raw) ' + label + ' budget=' + budget + ' -> ' + String(error));
      failures += 1;
    }
    return;
  }
  cases += 1;
  if (!Number.isSafeInteger(result.stats.usedTokens) || result.stats.usedTokens > budget) {
    console.log('FAIL(over) ' + label + ' budget=' + budget + ' used=' + result.stats.usedTokens);
    failures += 1;
  }
}

const messages = [
  { role: 'system', content: 'SYS\nstill\n' },
  { role: 'user', content: 'l1\nl2\nl3\nl4\nl5\nl6\nl7\nl8\n' },
  { role: 'assistant', content: 'm1\nm2\nm3\nm4\nm5\n' },
  { role: 'tool', content: 't1\nt2\n', name: 'n', tool_call_id: 'id' },
  { role: 'user', content: 'z1\nz2\nz3\nz4\n' },
];

for (const step of [2, 3, 4, 7, 13, 1000]) {
  for (let budget = 1; budget <= 400; budget += 1) {
    let call = 0;
    const tokenizer = (text) => {
      if (text.length === 0) return 0;
      call += 1;
      return Math.min(MAX_BUDGET_TOKENS, floor(text) + ((call * 37) % step) * 101);
    };
    assertNotOver('jitter-step-' + step, budget, tokenizer, messages);
  }
}

for (const mode of ['lowFirst', 'highFirst']) {
  for (let budget = 1; budget <= 400; budget += 1) {
    let call = 0;
    const tokenizer = (text) => {
      if (text.length === 0) return 0;
      call += 1;
      const early = call <= 16;
      return (mode === 'lowFirst') === early ? floor(text) : floor(text) + 5_000;
    };
    assertNotOver(mode, budget, tokenizer, messages);
  }
}

let seed = 123456789;
function rand() {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed;
}
for (let budget = 1; budget <= 600; budget += 1) {
  const tokenizer = (text) => {
    if (text.length === 0) return 0;
    return floor(text) + (rand() % 4_000);
  };
  assertNotOver('pseudorandom', budget, tokenizer, messages);
}

for (let budget = 1; budget <= 400; budget += 1) {
  let call = 0;
  const tokenizer = (text) => {
    if (text.length === 0) return 0;
    call += 1;
    return floor(text) + ((text.length * 31 + call * 17) % 2_000);
  };
  assertNotOver('text-jitter', budget, tokenizer, messages);
}

{
  const result = compactHistory({ messages, [keyMax]: 60 });
  const actual = result.messages.reduce((sum, m) => sum + floor(m.content), 0);
  if (result.stats.usedTokens !== actual) {
    console.log('FAIL(actual-sum) reported=' + result.stats.usedTokens + ' actual=' + actual);
    failures += 1;
  } else {
    console.log('ok deterministic usedTokens=' + actual + ' <= 60');
  }
}

console.log('checked-no-throw cases=' + cases + ' failures=' + failures);
process.exitCode = failures === 0 ? 0 : 1;


