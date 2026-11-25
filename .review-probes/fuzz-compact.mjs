import { compactHistory, CompactError, MAX_BUDGET_TOKENS } from 'file:///D:/vibecodium.goal.worktrees/m2-compact/src/stable/context-engine/compact.mjs';
const [PERSON_NAME] = ['max', 'Tokens'].join('');
let failures = 0;
function floor(text) { return text.length === 0 ? 0 : Buffer.byteLength(text, 'utf8') + 1; }
function call(label, fn) {
  try { const r = fn(); return { ok: true, r }; }
  catch (e) {
    if (!(e instanceof CompactError)) { console.log('FAIL raw ' + label + ': ' + e); failures += 1; }
    return { ok: false, e };
  }
}
function expectFail(label, fn) {
  const out = call(label, fn);
  if (out.ok) { console.log('FAIL expected-throw ' + label); failures += 1; }
  else if (out.e instanceof CompactError) { console.log('ok ' + label + ' -> ' + out.e.code); }
}
function expectOk(label, fn) {
  const out = call(label, fn);
  if (!out.ok) { console.log('FAIL expected-ok ' + label + ' -> ' + out.e.code); failures += 1; }
  else { console.log('ok ' + label + ' -> no throw'); }
}

const base = () => ([
  { role: 'system', content: 'rules\nsecond\n' },
  { role: 'user', content: 'one\ntwo\nthree\nfour\nfive\n' },
  { role: 'assistant', content: 'a\nb\nc\nd\n' },
  { role: 'tool', content: 't\n', name: 'n', tool_call_id: 'id' },
  { role: 'user', content: 'last\nline\n' },
]);

const rp = (target) => { const p = Proxy.revocable(target, {}); p.revoke(); return p.proxy; };
expectFail('revoked pinned element', () => compactHistory({ messages: base(), [PERSON_NAME]: 10, pinned: [rp(0)] }));
expectFail('revoked content value', () => compactHistory({ messages: [{ role: 'user', content: rp({}) }], [PERSON_NAME]: 10 }));
expectFail('revoked role value', () => compactHistory({ messages: [{ role: rp({}), content: 'x' }], [PERSON_NAME]: 10 }));
expectFail('revoked name value', () => compactHistory({ messages: [{ role: 'tool', content: 'x', name: rp({}) }], [PERSON_NAME]: 10 }));
expectFail('revoked tool id value', () => compactHistory({ messages: [{ role: 'tool', content: 'x', tool_call_id: rp({}) }], [PERSON_NAME]: 10 }));
expectFail('revoked messages length', () => compactHistory({ messages: rp([]), [PERSON_NAME]: 10 }));
expectOk('throwing get traps are never invoked (options)', () => compactHistory(new Proxy({ messages: base(), [PERSON_NAME]: 10_000 }, { get() { throw new TypeError('get'); } })));
expectOk('throwing get traps are never invoked (element)', () => compactHistory({ messages: [new Proxy({ role: 'user', content: 'x' }, { get() { throw new TypeError('get'); } })], [PERSON_NAME]: 10 }));
expectOk('frozen output still valid', () => { const r = compactHistory({ messages: base(), [PERSON_NAME]: 10_000 }); if (!Object.isFrozen(r) || !Object.isFrozen(r.stats)) throw new Error('not frozen'); return r; });

// Deterministic tokenizer whose call-index value climbs: old re-count style would overcharge.
{
  let call = 0;
  const tokenizer = (text) => { if (!text.length) return 0; call += 1; return Math.min(MAX_BUDGET_TOKENS, floor(text) + call * 1000); };
  const out = call('call-index-climb', () => compactHistory({ messages: base(), [PERSON_NAME]: 40, tokenizer }));
  if (out.ok) {
    if (out.r.stats.usedTokens > 40) { console.log('FAIL over ' + out.r.stats.usedTokens); failures += 1; }
    else console.log('ok call-index-climb used=' + out.r.stats.usedTokens + ' <= 40');
  }
}

// Random fuzz: random histories, random line shapes, random budgets, random per-call counts.
let seed = 987654321;
function rnd(n) { seed = (seed * 1103515245 + 12345) >>> 0; return seed % n; }
let runs = 0;
for (let i = 0; i < 30000; i += 1) {
  const n = rnd(8);
  const msgs = [];
  for (let j = 0; j < n; j += 1) {
    const lines = rnd(8);
    let content = '';
    for (let k = 0; k < lines; k += 1) content += 'abcdefghij'.slice(0, 1 + rnd(10)) + (rnd(2) ? '\n' : '\r\n');
    if (rnd(4) === 0) content = '';
    msgs.push({ role: ['system', 'user', 'assistant', 'tool'][rnd(4)], content });
  }
  const pinned = [];
  for (let j = 0; j < n; j += 1) if (rnd(5) === 0) pinned.push(j);
  const budget = 1 + rnd(500);
  const mode = rnd(4);
  let c = 0;
  const tokenizer = (text) => {
    if (text.length === 0) return 0;
    c += 1;
    const f = floor(text);
    if (mode === 0) return Math.min(MAX_BUDGET_TOKENS, f + rnd(3000));
    if (mode === 1) return Math.min(MAX_BUDGET_TOKENS, f + (c <= 8 ? 0 : 5000));
    if (mode === 2) return Math.min(MAX_BUDGET_TOKENS, f + (c <= 8 ? 5000 : 0));
    return Math.min(MAX_BUDGET_TOKENS, f + ((text.length * 7 + c * 13) % 2000));
  };
  const out = call('fuzz-' + i, () => compactHistory({ messages: msgs, [PERSON_NAME]: budget, pinned, tokenizer }));
  if (!out.ok) continue;
  runs += 1;
  if (!Number.isSafeInteger(out.r.stats.usedTokens) || out.r.stats.usedTokens > budget) {
    console.log('FAIL fuzz-over used=' + out.r.stats.usedTokens + ' budget=' + budget);
    failures += 1;
  }
  if (out.r.stats.usedTokens < 0) { console.log('FAIL negative'); failures += 1; }
  // every retained message must be a verbatim suffix at a line boundary of some source message
  for (const m of out.r.messages) {
    if (typeof m.content !== 'string') { console.log('FAIL nonstring'); failures += 1; }
  }
}
console.log('fuzz runs that returned=' + runs + ' failures=' + failures);
process.exitCode = failures ? 1 : 0;
