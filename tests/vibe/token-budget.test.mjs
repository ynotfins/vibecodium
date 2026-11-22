import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ContextBudgetError,
  MAX_TAIL_TOTAL_CHARS,
  SECTION_NAMES,
  UNTRUSTED_CLOSE,
  UNTRUSTED_OPEN,
  assembleContext,
  estimateTokens,
  summaryBlocksFromDag,
} from '../../src/stable/context-engine/token-budget.mjs';
import { buildSummaryDag } from '../../src/stable/context-engine/summary-dag.mjs';

function record(sequence, payload = `record ${sequence}`, kind = 'user') {
  return { kind, payload, sequence };
}

function cacheInputs(modelWindow = 4_000) {
  return {
    modelWindow,
    reserveTokens: 0,
    system: 'You are Vibecodium.',
    rules: 'Follow the project rules.',
    spec: 'Locked product specification.',
    repoMap: 'src/app.mjs\nsrc/engine.mjs',
    summaries: [
      {
        id: 'summary:l1:0-7',
        level: 1,
        startSequence: 0,
        endSequence: 7,
        summary: 'Earlier work established the baseline.',
      },
    ],
    tail: [record(8), record(9)],
  };
}

test('token estimates are deterministic, conservative and validated', () => {
  assert.equal(estimateTokens(''), 0);
  assert.equal(estimateTokens('a'), 2);
  assert.equal(estimateTokens('abcd'), 5);
  assert.equal(estimateTokens('😀'), 5);
  assert.equal(estimateTokens('😀😀😀😀'), 17);
  assert.throws(() => estimateTokens(5), /text must be a string/);
});

test('assembly uses the fixed section order and reports what was included', () => {
  const result = assembleContext(cacheInputs());

  assert.deepEqual(result.sections.map((section) => section.name), SECTION_NAMES);
  assert.deepEqual(SECTION_NAMES, ['system', 'rules', 'spec', 'repoMap', 'summaries', 'tail']);
  assert.ok(result.text.indexOf('You are Vibecodium.') < result.text.indexOf('Follow the project rules.'));
  assert.ok(result.text.indexOf('Follow the project rules.') < result.text.indexOf('Locked product specification.'));
  assert.ok(result.text.indexOf('Locked product specification.') < result.text.indexOf('src/app.mjs'));
  assert.ok(result.text.indexOf('src/app.mjs') < result.text.indexOf('Earlier work established the baseline.'));
  assert.ok(result.text.indexOf('Earlier work established the baseline.') < result.text.indexOf('record 8'));

  assert.equal(result.report.fits, true);
  assert.deepEqual(result.report.includedSections, SECTION_NAMES);
  assert.deepEqual(result.report.omittedSections, []);
  assert.ok(result.report.totalTokens > 0);
  assert.ok(result.report.totalTokens <= result.report.availableTokens);
  assert.ok(estimateTokens(result.text) <= result.report.availableTokens);
  assert.deepEqual(result.report.tail.includedSequences, [8, 9]);
  assert.deepEqual(result.report.tail.droppedSequences, []);
  assert.deepEqual(result.report.summaries.includedIds, ['summary:l1:0-7']);
  assert.deepEqual(result.report.summaries.droppedIds, []);
});

test('required system and rules sections fail closed when they cannot fit', () => {
  assert.throws(
    () => assembleContext({ modelWindow: 10, system: 's'.repeat(100) }),
    (error) => {
      assert.ok(error instanceof ContextBudgetError);
      assert.equal(error.availableTokens, 10);
      assert.ok(error.requiredTokens > 10);
      return true;
    },
  );
  assert.throws(
    () => assembleContext({ modelWindow: 40, system: 's', rules: 'r'.repeat(400) }),
    (error) => {
      assert.ok(error instanceof ContextBudgetError);
      assert.equal(error.availableTokens, 40);
      assert.ok(error.requiredTokens > 40);
      return true;
    },
  );
  assert.throws(
    () => assembleContext({ modelWindow: 20, reserveTokens: 20, system: 'system' }),
    /reserveTokens must be smaller than modelWindow/,
  );
  assert.throws(() => assembleContext({ modelWindow: 20, system: '   ' }), /system must be a non-empty string/);
});

test('reserve tokens, empty optional sections and JSON-safe payloads are handled', () => {
  const result = assembleContext({
    modelWindow: 100,
    reserveTokens: 30,
    system: 'sys',
    spec: 'p'.repeat(40),
  });
  assert.equal(result.report.availableTokens, 70);
  assert.equal(result.report.fits, true);
  assert.equal(result.report.estimator, 'utf8-byte-upper-bound');
  assert.ok(result.report.totalTokens + result.report.reserveTokens <= result.report.modelWindow);
  assert.ok(estimateTokens(result.text) <= 70);

  const onlySystem = assembleContext({ modelWindow: 100, system: 'sys' });
  assert.deepEqual(onlySystem.report.includedSections, ['system']);
  assert.deepEqual(onlySystem.report.omittedSections, ['rules', 'spec', 'repoMap', 'summaries', 'tail']);
  assert.equal(onlySystem.text, 'sys');

  const shared = { ok: true };
  assert.throws(
    () => assembleContext({
      modelWindow: 100,
      system: 'sys',
      tail: [{ kind: 'tool_result', sequence: 0, payload: { left: shared, right: shared } }],
    }),
    /repeated object references/,
  );

  let diamond = { leaf: true };
  for (let level = 0; level < 22; level += 1) diamond = { left: diamond, right: diamond };
  assert.throws(
    () => assembleContext({
      modelWindow: 100,
      system: 'sys',
      tail: [{ kind: 'tool_result', sequence: 0, payload: diamond }],
    }),
    /repeated object references/,
  );

  const cyclic = {};
  cyclic.self = cyclic;
  assert.throws(
    () => assembleContext({
      modelWindow: 100,
      system: 'sys',
      tail: [{ kind: 'tool_result', sequence: 0, payload: cyclic }],
    }),
    /cycles/,
  );
});

test('a growing fresh tail leaves the cached summary prefix unchanged', () => {
  const first = assembleContext(cacheInputs());
  assert.equal(first.report.cache.firstChangedSection, 0);
  assert.equal(first.report.cache.reusablePrefixSections, 0);
  assert.deepEqual(first.report.cache.changedSections, SECTION_NAMES);

  const second = assembleContext({
    ...cacheInputs(),
    tail: [record(8), record(9), record(10)],
    previousPrefixHashes: first.report.cache.prefixHashes,
  });
  assert.deepEqual(
    second.report.cache.prefixHashes.slice(0, 5),
    first.report.cache.prefixHashes.slice(0, 5),
  );
  assert.notEqual(second.report.cache.prefixHashes[5], first.report.cache.prefixHashes[5]);
  assert.equal(second.report.cache.firstChangedSection, 5);
  assert.equal(second.report.cache.reusablePrefixSections, 5);
  assert.deepEqual(second.report.cache.changedSections, ['tail']);

  const third = assembleContext({
    ...cacheInputs(),
    tail: [record(8), record(9), record(10)],
    previousPrefixHashes: second.report.cache.prefixHashes,
  });
  assert.equal(third.report.cache.firstChangedSection, null);
  assert.equal(third.report.cache.reusablePrefixSections, SECTION_NAMES.length);
  assert.deepEqual(third.report.cache.changedSections, []);
  assert.equal(third.text, second.text);
});

test('a changed summary block invalidates the cache from the summaries section', () => {
  const first = assembleContext(cacheInputs());
  const second = assembleContext({
    ...cacheInputs(),
    summaries: [
      {
        id: 'summary:l1:0-7',
        level: 1,
        startSequence: 0,
        endSequence: 7,
        summary: 'Earlier work established a revised baseline.',
      },
    ],
    previousPrefixHashes: first.report.cache.prefixHashes,
  });
  assert.deepEqual(
    second.report.cache.prefixHashes.slice(0, 4),
    first.report.cache.prefixHashes.slice(0, 4),
  );
  assert.equal(second.report.cache.firstChangedSection, 4);
  assert.deepEqual(second.report.cache.changedSections, ['summaries', 'tail']);
});

test('tail records are kept as a contiguous newest suffix', () => {
  const result = assembleContext({
    modelWindow: 300,
    system: 's',
    rules: 'r',
    tail: [record(1, 'x'.repeat(40)), record(2, 'x'.repeat(40)), record(3, 'x'.repeat(40)), record(4, 'x'.repeat(40))],
  });

  assert.deepEqual(result.report.tail.includedSequences, [3, 4]);
  assert.deepEqual(result.report.tail.droppedSequences, [1, 2]);
  assert.ok(result.text.indexOf('#3') < result.text.indexOf('#4'));
  assert.equal(result.text.includes('#2]'), false);
  assert.ok(result.report.totalTokens <= result.report.availableTokens);
});

test('summary blocks are included or dropped as whole batches', () => {
  const result = assembleContext({
    modelWindow: 180,
    system: 's',
    rules: 'r',
    summaries: [
      { id: 'summary:0-1', startSequence: 0, endSequence: 1, summary: 'a'.repeat(8) },
      { id: 'summary:2-3', startSequence: 2, endSequence: 3, summary: 'b'.repeat(40) },
    ],
  });

  assert.deepEqual(result.report.summaries.includedIds, ['summary:0-1']);
  assert.deepEqual(result.report.summaries.droppedIds, ['summary:2-3']);
  assert.deepEqual(result.report.omittedSections.includes('summaries'), false);
  assert.ok(result.report.totalTokens <= result.report.availableTokens);
});

test('a provided spec is never truncated and fails closed when it cannot fit', () => {
  assert.throws(
    () => assembleContext({ modelWindow: 30, system: 's', spec: '😀'.repeat(500) }),
    (error) => {
      assert.ok(error instanceof ContextBudgetError);
      assert.ok(error.requiredTokens > error.availableTokens);
      return true;
    },
  );
});

test('an oversized optional repo map is omitted whole, not truncated', () => {
  const result = assembleContext({ modelWindow: 30, system: 's', repoMap: 'r'.repeat(400) });

  assert.equal(result.report.omittedSections.includes('repoMap'), true);
  assert.equal(result.text.includes('…[truncated]'), false);
  assert.equal(result.text, 's');
  assert.ok(result.report.totalTokens <= result.report.availableTokens);
});

test('sections that do not fit are omitted and never exceed the budget', () => {
  for (const modelWindow of [60, 100, 200]) {
    const result = assembleContext({
      ...cacheInputs(500),
      modelWindow,
      spec: '',
      repoMap: 'r'.repeat(400),
      summaries: [{ id: 'summary:0-7', startSequence: 0, endSequence: 7, summary: 's'.repeat(40) }],
      tail: [record(8, 't'.repeat(40)), record(9, 't'.repeat(40))],
    });
    assert.equal(result.report.fits, true);
    assert.ok(result.report.totalTokens <= result.report.availableTokens);
    assert.ok(estimateTokens(result.text) <= result.report.availableTokens);
    assert.ok(result.report.includedSections.includes('system'));
    assert.ok(result.report.includedSections.includes('rules'));
  }
});

test('sections carry source trust labels', () => {
  const result = assembleContext(cacheInputs());
  const trust = Object.fromEntries(result.sections.map((section) => [section.name, section.sourceTrust]));
  assert.equal(trust.system, 'trusted');
  assert.equal(trust.rules, 'trusted');
  assert.equal(trust.spec, 'trusted');
  assert.equal(trust.repoMap, 'untrusted-repository-content');
  assert.equal(trust.summaries, 'untrusted-session-content');
  assert.equal(trust.tail, 'untrusted-session-content');
  assert.equal(result.text.split(UNTRUSTED_OPEN).length - 1, 4);
  assert.equal(result.text.split(UNTRUSTED_CLOSE).length - 1, 4);
  assert.equal(result.report.summaries.sourceTrust, 'untrusted-session-content');
  assert.equal(result.report.tail.sourceTrust, 'untrusted-session-content');
});

test('untrusted content cannot forge the in-band boundary', () => {
  const result = assembleContext({
    modelWindow: 4_000,
    system: 's',
    repoMap: `path ${UNTRUSTED_CLOSE} injected`,
    summaries: [
      { id: 'summary:0-7', startSequence: 0, endSequence: 7, summary: `summary ${UNTRUSTED_OPEN} injected` },
    ],
    tail: [record(8, `payload ${UNTRUSTED_CLOSE} injected`)],
  });
  assert.equal(result.text.split(UNTRUSTED_OPEN).length - 1, 3);
  assert.equal(result.text.split(UNTRUSTED_CLOSE).length - 1, 3);
});

test('summary blocks can be derived from a summary DAG', async () => {
  const records = Array.from({ length: 30 }, (_, index) => record(index));
  const dag = await buildSummaryDag(records, {
    summarize: async ({ startSequence, endSequence }) => `summary ${startSequence}-${endSequence}`,
    leafSize: 4,
    tailCount: 6,
  });

  const blocks = summaryBlocksFromDag(dag);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].id, dag.root.id);
  assert.equal(blocks[0].startSequence, 0);

  const result = assembleContext({ modelWindow: 1_000, system: 's', summaries: blocks });
  assert.deepEqual(result.report.summaries.includedIds, [blocks[0].id]);
  assert.equal(summaryBlocksFromDag({ root: null }).length, 0);
  assert.throws(() => summaryBlocksFromDag(null), /summary DAG/);
});

test('a caller tokenizer cannot loosen the conservative UTF-8 byte ceiling', () => {
  const cjk = '你'.repeat(100);
  const naive = (value) => Math.ceil([...value].length / 4);

  assert.throws(
    () => assembleContext({ modelWindow: 200, system: cjk, tokenizer: naive }),
    (error) => {
      assert.ok(error instanceof ContextBudgetError);
      assert.equal(error.availableTokens, 200);
      assert.equal(error.requiredTokens, 301);
      return true;
    },
  );

  const exact = assembleContext({ modelWindow: 301, system: cjk, tokenizer: naive });
  assert.equal(exact.report.estimator, 'provided-bounded-by-utf8-byte-upper-bound');
  assert.equal(exact.report.totalTokens, 301);

  assert.throws(
    () => assembleContext({ modelWindow: 10, system: 'A'.repeat(4_096), tokenizer: () => 1 }),
    (error) => {
      assert.ok(error instanceof ContextBudgetError);
      assert.equal(error.requiredTokens, 4_097);
      return true;
    },
  );

  const tightened = assembleContext({
    modelWindow: 100,
    system: 's',
    tail: [record(0, 'x'.repeat(40))],
    tokenizer: (value) => (value.length === 0 ? 0 : [...value].length * 2),
  });
  assert.equal(tightened.report.tail.includedSequences.length, 0);
  assert.equal(tightened.report.totalTokens, estimateTokens(tightened.text));

  assert.throws(
    () => assembleContext({ modelWindow: 100, system: 's', tokenizer: () => -1 }),
    /non-negative integer/,
  );
  assert.throws(
    () => assembleContext({ modelWindow: 100, system: 's', tokenizer: () => 0 }),
    /under-counted/,
  );
  assert.throws(
    () => assembleContext({ modelWindow: 100, system: 's', tokenizer: 'nope' }),
    /tokenizer must be a function/,
  );
});

test('the final joined prompt is measured exactly before reporting a fit', () => {
  const countTokens = (text) => {
    if (text.length === 0) return 0;
    if (text.includes('\n\n')) return 100;
    return 1;
  };

  assert.throws(
    () => assembleContext({
      modelWindow: 50,
      system: 'abcdefghijklmno!',
      rules: 'r',
      tokenizer: countTokens,
    }),
    (error) => {
      assert.ok(error instanceof ContextBudgetError);
      assert.equal(error.availableTokens, 50);
      assert.equal(error.requiredTokens, 100);
      return true;
    },
  );

  const result = assembleContext({
    modelWindow: 100,
    system: 'abcdefghijklmno!',
    rules: 'r',
    tokenizer: countTokens,
  });
  assert.equal(result.report.fits, true);
  assert.equal(result.report.totalTokens, 100);
  assert.equal(result.text, 'abcdefghijklmno!\n\nr');
});

test('optional content is trimmed when the exact joined prompt exceeds the budget', () => {
  const countTokens = (text) => {
    if (text.length === 0) return 0;
    if (text.includes('\n\n')) return [...text].length;
    return 1;
  };
  const result = assembleContext({
    modelWindow: 30,
    system: 's',
    rules: 'r',
    summaries: [{ id: 'summary:0-1', startSequence: 0, endSequence: 1, summary: 'm' }],
    tail: [record(2, 't')],
    tokenizer: countTokens,
  });

  assert.equal(result.report.fits, true);
  assert.equal(
    result.report.totalTokens,
    Math.max(countTokens(result.text), estimateTokens(result.text)),
  );
  assert.deepEqual(result.report.tail.includedSequences, []);
  assert.deepEqual(result.report.tail.droppedSequences, [2]);
  assert.deepEqual(result.report.summaries.includedIds, []);
  assert.deepEqual(result.report.summaries.droppedIds, ['summary:0-1']);
  assert.deepEqual(result.report.includedSections, ['system', 'rules']);
});

test('exact trimming uses a bounded number of joined measurements', () => {
  let calls = 0;
  const countTokens = (text) => {
    calls += 1;
    if (text.length === 0) return 0;
    if (text.includes('\n\n')) return [...text].length;
    return 1;
  };
  const tail = Array.from({ length: 1_000 }, (_, index) => record(index, 'x'.repeat(40)));
  const result = assembleContext({
    modelWindow: 5_000,
    system: 's',
    rules: 'r',
    tail,
    tokenizer: countTokens,
  });

  assert.equal(result.report.fits, true);
  assert.equal(
    result.report.totalTokens,
    Math.max(countTokens(result.text), estimateTokens(result.text)),
  );
  assert.ok(calls < 1_100);
});

test('the summary loop stops rendering once the budget closes', () => {
  const rendered = [];
  const result = assembleContext({
    modelWindow: 200,
    system: 's',
    summaries: [
      { id: 'a', startSequence: 0, endSequence: 1, summary: 'a'.repeat(20) },
      { id: 'b', startSequence: 2, endSequence: 3, summary: 'b'.repeat(1_000) },
      { id: 'c', startSequence: 4, endSequence: 5, summary: 'c'.repeat(20) },
    ],
    tokenizer: (value) => {
      rendered.push(value);
      return Math.ceil([...value].length / 4);
    },
  });
  assert.deepEqual(result.report.summaries.includedIds, ['a']);
  assert.deepEqual(result.report.summaries.droppedIds, ['b', 'c']);
  assert.equal(rendered.some((value) => value.includes('summary c')), false);
});

test('payload caps accept boundary-sized values', () => {
  const thousandKeys = Object.fromEntries(Array.from({ length: 1_000 }, (_, index) => [`k${index}`, 'x']));
  assert.deepEqual(
    assembleContext({
      modelWindow: 10_000_000,
      system: 's',
      tail: [{ kind: 'tool_result', sequence: 0, payload: thousandKeys }],
    }).report.tail.includedSequences,
    [0],
  );

  const thousandItems = { list: Array.from({ length: 1_000 }, () => 'x') };
  assert.deepEqual(
    assembleContext({
      modelWindow: 10_000_000,
      system: 's',
      tail: [{ kind: 'tool_result', sequence: 0, payload: thousandItems }],
    }).report.tail.includedSequences,
    [0],
  );

  const longKey = { ['k'.repeat(200)]: 'x' };
  assert.deepEqual(
    assembleContext({
      modelWindow: 10_000_000,
      system: 's',
      tail: [{ kind: 'tool_result', sequence: 0, payload: longKey }],
    }).report.tail.includedSequences,
    [0],
  );

  const tenThousandNodes = Object.fromEntries(
    Array.from({ length: 999 }, (_, index) => [`k${index}`, Array.from({ length: 9 }, () => 'x')]),
  );
  tenThousandNodes.k0 = Array.from({ length: 18 }, () => 'x');
  assert.deepEqual(
    assembleContext({
      modelWindow: 10_000_000,
      system: 's',
      tail: [{ kind: 'tool_result', sequence: 0, payload: tenThousandNodes }],
    }).report.tail.includedSequences,
    [0],
  );
});

test('tail and summary total caps accept exactly the limit', () => {
  const tailFixed = Array.from({ length: 100 }, (_, index) => (
    UNTRUSTED_OPEN.length + UNTRUSTED_CLOSE.length + 2 + `[tool_result #${index}] `.length
  ));
  const payloadTotal = MAX_TAIL_TOTAL_CHARS - tailFixed.reduce((sum, value) => sum + value, 0);
  const basePayload = Math.floor(payloadTotal / 100);
  const extraPayload = payloadTotal % 100;
  const maxTail = Array.from({ length: 100 }, (_, index) => ({
    kind: 'tool_result',
    sequence: index,
    payload: 'x'.repeat(basePayload + (index < extraPayload ? 1 : 0)),
  }));
  const tailResult = assembleContext({ modelWindow: 10_000_000, system: 's', tail: maxTail });
  assert.ok(tailResult.report.tail.includedSequences.length > 0);

  const overTail = maxTail.map((record, index) => (
    index === 0 ? { ...record, payload: `${record.payload}x` } : record
  ));
  assert.throws(
    () => assembleContext({ modelWindow: 10_000_000, system: 's', tail: overTail }),
    /tail exceeds 20000000 characters/,
  );

  const maxSummaries = Array.from({ length: 2_500 }, (_, index) => ({
    id: `summary:${index}`,
    startSequence: index * 10,
    endSequence: index * 10 + 9,
    summary: 's'.repeat(8_000),
  }));
  const summaryResult = assembleContext({ modelWindow: 10_000_000, system: 's', summaries: maxSummaries });
  assert.ok(summaryResult.report.summaries.includedIds.length > 0);
});

test('payload aggregate caps fail closed', () => {
  function tree(depth) {
    if (depth === 0) return { leaf: true };
    return { left: tree(depth - 1), right: tree(depth - 1) };
  }
  assert.throws(
    () => assembleContext({
      modelWindow: 10_000_000,
      system: 's',
      tail: [{ kind: 'tool_result', sequence: 0, payload: tree(13) }],
    }),
    /exceeds 10000 values/,
  );

  const wide = Object.fromEntries(Array.from({ length: 1_001 }, (_, index) => [`k${index}`, 'x']));
  assert.throws(
    () => assembleContext({
      modelWindow: 10_000_000,
      system: 's',
      tail: [{ kind: 'tool_result', sequence: 0, payload: wide }],
    }),
    /at most 1000 keys/,
  );

  assert.throws(
    () => assembleContext({
      modelWindow: 10_000_000,
      system: 's',
      tail: [{ kind: 'tool_result', sequence: 0, payload: { list: Array.from({ length: 1_001 }, () => 'x') } }],
    }),
    /at most 1000 items/,
  );

  assert.throws(
    () => assembleContext({
      modelWindow: 10_000_000,
      system: 's',
      tail: [{ kind: 'tool_result', sequence: 0, payload: { ['k'.repeat(201)]: 'x' } }],
    }),
    /keys may contain at most 200 characters/,
  );
});

test('tail and summary total caps fail closed', () => {
  const hugeTail = Array.from({ length: 21 }, (_, index) => ({
    kind: 'tool_result',
    sequence: index,
    payload: 'x'.repeat(999_000),
  }));
  assert.throws(
    () => assembleContext({ modelWindow: 10_000_000, system: 's', tail: hugeTail }),
    /tail exceeds 20000000 characters/,
  );

  const hugeSummaries = Array.from({ length: 2_501 }, (_, index) => ({
    id: `summary:${index}`,
    startSequence: index * 10,
    endSequence: index * 10 + 9,
    summary: 's'.repeat(8_000),
  }));
  assert.throws(
    () => assembleContext({ modelWindow: 10_000_000, system: 's', summaries: hugeSummaries }),
    /summaries exceeds 20000000 characters/,
  );
});

test('invalid assembly inputs are rejected', () => {
  assert.throws(() => assembleContext({ modelWindow: 0 }), /modelWindow/);
  assert.throws(() => assembleContext({ modelWindow: 10, system: 5 }), /system must be a string/);
  assert.throws(() => assembleContext({ modelWindow: 100, system: 's', spec: 5 }), /spec must be a string/);
  assert.throws(
    () => assembleContext({ modelWindow: 100, system: 's', rules: '   \n	 ' }),
    /rules must not be whitespace-only when provided/,
  );
  assert.throws(
    () => assembleContext({ modelWindow: 100, system: 's', spec: '   ' }),
    /spec must not be whitespace-only when provided/,
  );
  assert.throws(
    () => assembleContext({ modelWindow: 100, system: 's', repoMap: '   ' }),
    /repoMap must not be whitespace-only when provided/,
  );
  assert.throws(
    () => assembleContext({ modelWindow: 100, system: 's', summaries: {} }),
    /summaries must be an array/,
  );
  assert.throws(
    () => assembleContext({
      modelWindow: 100,
      system: 's',
      summaries: [
        { id: 'a', startSequence: 0, endSequence: 5, summary: 'one' },
        { id: 'b', startSequence: 5, endSequence: 9, summary: 'two' },
      ],
    }),
    /summary blocks must not overlap/,
  );
  assert.throws(
    () => assembleContext({
      modelWindow: 100,
      system: 's',
      summaries: [{ id: 'bad id', startSequence: 0, endSequence: 1, summary: 'one' }],
    }),
    /summary id/,
  );
  assert.throws(
    () => assembleContext({
      modelWindow: 100,
      system: 's',
      summaries: [
        { id: 'same', startSequence: 0, endSequence: 1, summary: 'one' },
        { id: 'same', startSequence: 2, endSequence: 3, summary: 'two' },
      ],
    }),
    /duplicate summary id/,
  );
  assert.throws(
    () => assembleContext({ modelWindow: 100, system: 's', summaries: [{ startSequence: 0, endSequence: 1, summary: 'x'.repeat(8_001) }] }),
    /summary exceeds/,
  );
  assert.throws(
    () => assembleContext({
      modelWindow: 100,
      system: 's',
      summaries: [{ id: 'overlap', startSequence: 0, endSequence: 7, summary: 'one' }],
      tail: [record(6), record(7)],
    }),
    /summary blocks must end before the fresh tail/,
  );
  assert.throws(
    () => assembleContext({ modelWindow: 100, system: 's', tail: [record(2), record(4)] }),
    /tail sequences must be contiguous/,
  );
  assert.throws(
    () => assembleContext({ modelWindow: 100, system: 's', tail: [{ kind: 'nope', payload: 'x', sequence: 0 }] }),
    /invalid record kind/,
  );
  assert.throws(
    () => assembleContext({
      modelWindow: 100,
      system: 's',
      tail: [{ kind: 'x'.repeat(33), payload: 'x', sequence: 0 }],
    }),
    /at most 32 characters/,
  );
  assert.throws(
    () => assembleContext({ modelWindow: 100, system: 's', previousPrefixHashes: ['x'] }),
    /previousPrefixHashes must contain/,
  );
});
