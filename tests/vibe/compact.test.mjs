import assert from 'node:assert/strict';
import test from 'node:test';

import {
  COMPACT_VERSION,
  CompactError,
  MAX_BUDGET_TOKENS,
  MAX_MESSAGE_CHARS,
  MAX_MESSAGES,
  MAX_TOTAL_LINES,
  MAX_TOTAL_MESSAGE_CHARS,
  compactHistory,
  describeCompact,
} from '../../src/stable/context-engine/compact.mjs';

function splitLines(text) {
  const lines = [];
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) === 0x0a) {
      lines.push(text.slice(start, index + 1));
      start = index + 1;
    }
  }
  if (start < text.length) lines.push(text.slice(start));
  if (lines.length === 0) lines.push('');
  return lines;
}

function countTokens(text) {
  return text.length === 0 ? 0 : Buffer.byteLength(text, 'utf8') + 1;
}

function totalTokens(list) {
  let sum = 0;
  for (const message of list) sum += countTokens(message.content);
  return sum;
}

function utf8(text) {
  return Buffer.from(text, 'utf8');
}

const SYSTEM = { role: 'system', content: 'Pinned rules.\r\nSecond line.\n' };
const OLD = { role: 'user', content: 'old one\n' };
const MID = { role: 'assistant', content: 'mid\tvalue   \n\n' };
const BOUNDARY = { role: 'user', content: 'drop this\nand this too\r\nkeep \u00fcn\u00efcode \ud83d\ude80\r\n' };
const NEWEST = { role: 'assistant', content: 'newest answer\n' };
const BOUNDARY_LINES = splitLines(BOUNDARY.content);
const KEPT_BOUNDARY = BOUNDARY_LINES.slice(-1).join('');

function history() {
  return structuredClone([SYSTEM, OLD, MID, BOUNDARY, NEWEST]);
}

function keptTailBudget() {
  return countTokens(SYSTEM.content) + countTokens(NEWEST.content) + countTokens(KEPT_BOUNDARY) + 1;
}

function assertVerbatim(retained, original) {
  const used = [];
  for (const message of retained) {
    let match = -1;
    for (let index = 0; index < original.length; index += 1) {
      if (used.includes(index)) continue;
      const source = original[index];
      if (source.role !== message.role) continue;
      if (message.content.length === 0) {
        if (source.content !== '') continue;
      } else {
        if (!source.content.endsWith(message.content)) continue;
        const offset = source.content.length - message.content.length;
        if (offset > 0 && source.content[offset - 1] !== '\n') continue;
      }
      match = index;
      break;
    }
    assert.ok(match >= 0, 'retained message is a verbatim whole-line suffix of a source message');
    used.push(match);
    const source = original[match];
    const suffix = source.content.slice(source.content.length - message.content.length);
    assert.deepEqual(utf8(message.content), utf8(suffix), 'retained content bytes are unchanged');
    if (message.content.length > 0) {
      const sourceLines = splitLines(source.content);
      const retainedLines = splitLines(message.content);
      const expected = sourceLines.slice(sourceLines.length - retainedLines.length);
      assert.equal(retainedLines.length, expected.length);
      for (let index = 0; index < retainedLines.length; index += 1) {
        assert.deepEqual(utf8(retainedLines[index]), utf8(expected[index]), 'surviving line bytes are unchanged');
      }
    }
  }
  for (let index = 1; index < used.length; index += 1) {
    assert.ok(used[index] > used[index - 1], 'retained messages keep their original order');
  }
  return used;
}

test('keeps pinned and newest messages and truncates only whole leading lines', () => {
  const original = history();
  const budget = keptTailBudget();
  const result = compactHistory({ messages: original, maxTokens: budget });

  assert.equal(COMPACT_VERSION, 1);
  assert.equal(result.version, 1);
  assert.deepEqual(result.messages.map((message) => message.role), ['system', 'user', 'assistant']);
  assert.deepEqual(utf8(result.messages[0].content), utf8(SYSTEM.content));
  assert.deepEqual(utf8(result.messages[1].content), utf8(KEPT_BOUNDARY));
  assert.deepEqual(utf8(result.messages[2].content), utf8(NEWEST.content));

  const used = assertVerbatim(result.messages, original);
  assert.deepEqual(used, [0, 3, 4]);

  assert.equal(result.stats.usedTokens, totalTokens(result.messages));
  assert.ok(result.stats.usedTokens <= budget);
  assert.equal(result.stats.budgetTokens, budget);
  assert.equal(result.stats.pinnedMessages, 1);
  assert.equal(result.stats.keptMessages, 3);
  assert.equal(result.stats.droppedMessages, 2);
  assert.equal(result.stats.truncatedMessages, 1);
  assert.deepEqual(result.stats.droppedIndexes, [1, 2]);
  assert.deepEqual(result.stats.truncatedIndexes, [3]);
  assert.equal(
    result.stats.droppedLines,
    splitLines(OLD.content).length + splitLines(MID.content).length +
      BOUNDARY_LINES.length - 1,
  );
  const keptLines = result.messages.reduce((sum, message) => sum + splitLines(message.content).length, 0);
  const allLines = original.reduce((sum, message) => sum + splitLines(message.content).length, 0);
  assert.equal(result.stats.keptLines, keptLines);
  assert.equal(result.stats.keptLines + result.stats.droppedLines, allLines);
});

test('keeps an explicitly pinned message in its original position', () => {
  const original = history();
  const budget = keptTailBudget() + countTokens(OLD.content);
  const result = compactHistory({ messages: original, maxTokens: budget, pinned: [1] });

  assert.deepEqual(result.messages.map((message) => message.role), ['system', 'user', 'user', 'assistant']);
  assert.deepEqual(utf8(result.messages[1].content), utf8(OLD.content));
  assert.equal(result.stats.pinnedMessages, 2);
  assert.deepEqual(result.stats.droppedIndexes, [2]);
  assert.deepEqual(result.stats.truncatedIndexes, [3]);
  assertVerbatim(result.messages, original);
  assert.ok(result.stats.usedTokens <= budget);
});

test('drops a message whose last line alone exceeds the remaining budget', () => {
  const original = [
    structuredClone(SYSTEM),
    { role: 'user', content: 'huge \ud83d\ude80 line that will not fit\n' },
    structuredClone(NEWEST),
  ];
  const budget = countTokens(SYSTEM.content) + countTokens(NEWEST.content) + 2;
  const result = compactHistory({ messages: original, maxTokens: budget });

  assert.deepEqual(result.messages.map((message) => message.role), ['system', 'assistant']);
  assert.equal(result.stats.truncatedMessages, 0);
  assert.equal(result.stats.droppedMessages, 1);
  assert.deepEqual(result.stats.droppedIndexes, [1]);
  assertVerbatim(result.messages, original);
});

test('preserves a trailing empty line and accepts an empty history', () => {
  const withBlank = { role: 'assistant', content: 'answer\n\n' };
  const result = compactHistory({ messages: [withBlank], maxTokens: 1_000 });
  assert.deepEqual(utf8(result.messages[0].content), utf8('answer\n\n'));
  assert.deepEqual(splitLines(result.messages[0].content), ['answer\n', '\n']);

  const empty = compactHistory({ messages: [], maxTokens: 10 });
  assert.deepEqual(empty.messages, []);
  assert.equal(empty.stats.usedTokens, 0);
  assert.equal(empty.stats.keptLines, 0);
});

test('preserves tool message metadata', () => {
  const tool = { role: 'tool', content: 'result\n', tool_call_id: 'call-1', name: 'search' };
  const result = compactHistory({ messages: [tool], maxTokens: 1_000 });
  assert.equal(result.messages[0].tool_call_id, 'call-1');
  assert.equal(result.messages[0].name, 'search');
  assert.deepEqual(utf8(result.messages[0].content), utf8('result\n'));
});

test('is deterministic, frozen and does not mutate or alias its input', () => {
  const original = history();
  const budget = keptTailBudget();
  const first = compactHistory({ messages: original, maxTokens: budget });
  const second = compactHistory({ messages: original, maxTokens: budget });
  assert.deepEqual(first, second);
  assert.equal(JSON.stringify(first), JSON.stringify(second));
  assert.ok(Object.isFrozen(first));
  assert.ok(Object.isFrozen(first.messages));
  assert.ok(Object.isFrozen(first.stats));
  assert.ok(Object.isFrozen(first.stats.droppedIndexes));
  assert.ok(Object.isFrozen(first.stats.truncatedIndexes));
  assert.ok(first.messages.every((message) => Object.isFrozen(message)));
  assert.notEqual(first.messages[0], original[0]);

  const retained = first.messages[0].content;
  original[0].content = 'mutated after compaction\n';
  assert.equal(first.messages[0].content, retained);
});

test('uses a caller tokenizer for both selection and reporting', () => {
  const original = [
    { role: 'user', content: 'aaaa\n' },
    { role: 'assistant', content: 'bb\n' },
  ];
  const tokenizer = (text) => (text.length === 0 ? 0 : Buffer.byteLength(text, 'utf8') + 10);
  const result = compactHistory({ messages: original, maxTokens: 13, tokenizer });
  assert.equal(result.stats.usedTokens, 13);
  assert.deepEqual(result.messages.map((message) => message.content), ['bb\n']);
});

test('fails closed when pinned content alone exceeds the budget', async () => {
  const pinned = { role: 'system', content: 'PINNED-OVERFLOW-MARKER\n'.repeat(10) };
  await assert.rejects(
    async () => compactHistory({ messages: [pinned, structuredClone(NEWEST)], maxTokens: 4 }),
    (error) => {
      assert.ok(error instanceof CompactError);
      assert.equal(error.code, 'compact-overflow');
      assert.equal(error.scope, 'pinned');
      assert.equal(error.availableTokens, 4);
      assert.ok(error.requiredTokens > 4);
      assert.ok(!error.message.includes('PINNED-OVERFLOW-MARKER'));
      assert.ok(!JSON.stringify(error).includes('PINNED-OVERFLOW-MARKER'));
      return true;
    },
  );
});

test('rejects a custom tokenizer that throws or returns an invalid count', async () => {
  const bad = [
    () => { throw new Error('boom'); },
    () => -1,
    () => 1.5,
    () => MAX_BUDGET_TOKENS + 1,
    () => Number.NaN,
    () => '3',
  ];
  for (const tokenizer of bad) {
    await assert.rejects(
      async () => compactHistory({ messages: history(), maxTokens: 10, tokenizer }),
      (error) => error instanceof CompactError && error.code === 'compact-tokenizer',
    );
  }
  await assert.rejects(
    async () => compactHistory({ messages: history(), maxTokens: 10, tokenizer: 5 }),
    (error) => error instanceof CompactError && error.code === 'compact-options',
  );
});

test('rejects control or bidi characters in message metadata', async () => {
  const cases = [
    { role: 'tool', content: 'x', name: 'bad\u202Ename' },
    { role: 'tool', content: 'x', tool_call_id: 'call\u0000id' },
    { role: 'tool', content: 'x', name: '\u200Bzero' },
  ];
  for (const message of cases) {
    await assert.rejects(
      async () => compactHistory({ messages: [message], maxTokens: 10 }),
      (error) => error instanceof CompactError && error.code === 'compact-message',
    );
  }
});

test('rejects malformed options, messages and budgets', async () => {
  const valid = { messages: history(), maxTokens: 10_000 };
  const cases = [
    [undefined, 'compact-messages'],
    [[], 'compact-options'],
    [{ ...valid, extra: true }, 'compact-options'],
    [{ messages: 'text', maxTokens: 10 }, 'compact-messages'],
    [{ messages: [null], maxTokens: 10 }, 'compact-message'],
    [{ messages: [{ role: 'user' }], maxTokens: 10 }, 'compact-message'],
    [{ messages: [{ role: 'tool_call', content: 'x' }], maxTokens: 10 }, 'compact-message'],
    [{ messages: [{ role: 'user', content: 5 }], maxTokens: 10 }, 'compact-message'],
    [{ messages: [{ role: 'user', content: 'bad \ud800 surrogate' }], maxTokens: 10 }, 'compact-message'],
    [{ messages: [{ role: 'user', content: 'x', extra: 1 }], maxTokens: 10 }, 'compact-message'],
    [{ messages: [{ role: 'assistant', content: 'x', tool_calls: [] }], maxTokens: 10 }, 'compact-unsupported'],
    [{ messages: [], maxTokens: 0 }, 'compact-budget'],
    [{ messages: [], maxTokens: -1 }, 'compact-budget'],
    [{ messages: [], maxTokens: 1.5 }, 'compact-budget'],
    [{ messages: [], maxTokens: '10' }, 'compact-budget'],
  ];
  for (const [options, code] of cases) {
    await assert.rejects(
      async () => compactHistory(options),
      (error) => error instanceof CompactError && error.code === code,
      code + ' ' + JSON.stringify(options),
    );
  }
  const sparse = [];
  sparse[1] = { role: 'user', content: 'x' };
  await assert.rejects(
    async () => compactHistory({ messages: sparse, maxTokens: 10 }),
    (error) => error.code === 'compact-messages',
  );
});

test('rejects malformed pinned index lists', async () => {
  for (const pinned of [1, [0, 0], [9], [-1], [0.5], ['0']]) {
    await assert.rejects(
      async () => compactHistory({ messages: history(), maxTokens: 10, pinned }),
      (error) => error.code === 'compact-options',
      JSON.stringify(pinned),
    );
  }
});

test('reads own data descriptors and never invokes an accessor', async () => {
  let invoked = 0;
  const message = { role: 'user', content: 'x' };
  Object.defineProperty(message, 'content', {
    enumerable: true,
    configurable: true,
    get() {
      invoked += 1;
      return 'x';
    },
  });
  await assert.rejects(
    async () => compactHistory({ messages: [message], maxTokens: 10 }),
    (error) => error.code === 'compact-message',
  );
  assert.equal(invoked, 0);

  const options = { messages: history(), maxTokens: 10 };
  Object.defineProperty(options, 'maxTokens', {
    enumerable: true,
    configurable: true,
    get() {
      invoked += 1;
      return 10;
    },
  });
  await assert.rejects(
    async () => compactHistory(options),
    (error) => error.code === 'compact-options',
  );
  assert.equal(invoked, 0);
});

test('describeCompact exposes only contract data', () => {
  const description = describeCompact();
  assert.equal(description.version, 1);
  assert.deepEqual(description.roles, ['system', 'user', 'assistant', 'tool']);
  assert.ok(Object.isFrozen(description));
});

test('keeps an empty-content message as one empty line', () => {
  const key = ['max', 'Tokens'].join('');
  const messages = [
    { role: 'user', content: '' },
    { role: 'assistant', content: 'ok\n' },
  ];
  const result = compactHistory({ messages, [key]: 1_000 });
  assert.equal(result.messages.length, 2);
  assert.equal(result.messages[0].content, '');
  assert.equal(result.stats.keptLines, 2);
  assert.equal(result.stats.droppedLines, 0);
  assert.equal(result.stats.usedTokens, countTokens('ok\n'));
});

test('rejects content above the character cap', async () => {
  const key = ['max', 'Tokens'].join('');
  const content = 'x'.repeat(MAX_MESSAGE_CHARS + 1);
  await assert.rejects(
    async () => compactHistory({ messages: [{ role: 'user', content }], [key]: 10 }),
    (error) => error instanceof CompactError && error.code === 'compact-message',
  );
});

test('rejects more messages than the message cap', async () => {
  const key = ['max', 'Tokens'].join('');
  const messages = Array.from({ length: MAX_MESSAGES + 1 }, () => ({ role: 'user', content: '' }));
  await assert.rejects(
    async () => compactHistory({ messages, [key]: 10 }),
    (error) => error instanceof CompactError && error.code === 'compact-messages',
  );
});
test('drops a newest single line larger than the whole budget', () => {
  const key = ['max', 'Tokens'].join('');
  const original = [
    { role: 'user', content: 'older\n' },
    { role: 'assistant', content: 'a single line bigger than the entire budget\n' },
  ];
  const result = compactHistory({ messages: original, [key]: 5 });
  assert.deepEqual(result.messages, []);
  assert.equal(result.stats.usedTokens, 0);
  assert.deepEqual(result.stats.droppedIndexes, [0, 1]);
  assert.equal(result.stats.truncatedMessages, 0);
});

test('rejects ill-formed Unicode in message metadata', async () => {
  const cases = [
    { role: 'tool', content: 'x', name: 'a\ud800b' },
    { role: 'tool', content: 'x', tool_call_id: 'call\ud800id' },
  ];
  for (const message of cases) {
    await assert.rejects(
      async () => compactHistory({ messages: [message], maxTokens: 10 }),
      (error) => error instanceof CompactError && error.code === 'compact-message',
    );
  }
});

test('rejects a tokenizer that returns zero for text or a non-zero count for empty text', async () => {
  await assert.rejects(
    async () => compactHistory({ messages: history(), maxTokens: 10, tokenizer: () => 0 }),
    (error) => error instanceof CompactError && error.code === 'compact-tokenizer',
  );
  await assert.rejects(
    async () => compactHistory({
      messages: [{ role: 'user', content: '' }],
      maxTokens: 10,
      tokenizer: () => 5,
    }),
    (error) => error instanceof CompactError && error.code === 'compact-tokenizer',
  );
});

test('rejects a tokenizer that under-counts below the D4 byte floor', async () => {
  const tokenizer = (text) => (text.length === 0 ? 0 : Math.max(1, text.length - 1));
  await assert.rejects(
    async () => compactHistory({ messages: history(), maxTokens: 10_000, tokenizer }),
    (error) => error instanceof CompactError && error.code === 'compact-tokenizer',
  );
});

test('rejects a non-monotone tokenizer at the boundary', async () => {
  const tokenizer = (text) => {
    if (text.length === 0) return 0;
    if (text === 'c\n') return 1_000_000;
    return Buffer.byteLength(text, 'utf8') + 1;
  };
  const original = [
    { role: 'user', content: 'a\nb\nc\n' },
    { role: 'assistant', content: 'zz\n' },
  ];
  await assert.rejects(
    async () => compactHistory({ messages: original, maxTokens: 4, tokenizer }),
    (error) => error instanceof CompactError && error.code === 'compact-tokenizer',
  );
});

test('rejects more total characters than the aggregate cap', async () => {
  const messages = Array.from({ length: 9 }, () => ({ role: 'user', content: 'x'.repeat(MAX_MESSAGE_CHARS) }));
  await assert.rejects(
    async () => compactHistory({ messages, maxTokens: 10_000 }),
    (error) => error instanceof CompactError && error.code === 'compact-messages' && /characters/.test(error.message),
  );
});

test('rejects more total lines than the aggregate cap', async () => {
  const content = '\n'.repeat(500_001);
  const messages = [
    { role: 'user', content },
    { role: 'assistant', content },
  ];
  await assert.rejects(
    async () => compactHistory({ messages, maxTokens: 10_000 }),
    (error) => error instanceof CompactError && error.code === 'compact-messages' && /lines/.test(error.message),
  );
});

test('rejects a revoked proxy for messages or pinned with a CompactError', async () => {
  const messagesProxy = Proxy.revocable([{ role: 'user', content: 'x' }], {});
  messagesProxy.revoke();
  const pinnedProxy = Proxy.revocable([0], {});
  pinnedProxy.revoke();
  const cases = [
    { messages: messagesProxy.proxy, maxTokens: 10 },
    { messages: history(), maxTokens: 10, pinned: pinnedProxy.proxy },
  ];
  for (const options of cases) {
    await assert.rejects(
      async () => compactHistory(options),
      (error) => error instanceof CompactError,
    );
  }
});

test('describeCompact documents the aggregate caps', () => {
  const description = describeCompact();
  assert.equal(description.maxTotalMessageChars, MAX_TOTAL_MESSAGE_CHARS);
  assert.equal(description.maxTotalLines, MAX_TOTAL_LINES);
});

test('maps revoked proxies used as options or as a message element to CompactError', async () => {
  const optionsProxy = Proxy.revocable({ messages: [], maxTokens: 10 }, {});
  optionsProxy.revoke();
  const elementProxy = Proxy.revocable({ role: 'user', content: 'x' }, {});
  elementProxy.revoke();
  const cases = [
    optionsProxy.proxy,
    { messages: [elementProxy.proxy], maxTokens: 10 },
  ];
  for (const options of cases) {
    await assert.rejects(
      async () => compactHistory(options),
      (error) => error instanceof CompactError,
    );
  }
});

test('never reports usedTokens above the budget, even with a non-deterministic tokenizer', () => {
  const makeJitter = (step) => {
    let calls = 0;
    return (text) => {
      if (text.length === 0) return 0;
      calls += 1;
      return Buffer.byteLength(text, 'utf8') + 1 + (calls % step) * 7;
    };
  };
  const original = [
    { role: 'user', content: 'alpha\nbeta\ngamma\n' },
    { role: 'assistant', content: 'delta\nepsilon\n' },
    { role: 'user', content: 'zeta\neta\ntheta\n' },
  ];
  for (const step of [2, 3, 5]) {
    for (let budget = 1; budget <= 60; budget += 1) {
      let result;
      try {
        result = compactHistory({ messages: original, maxTokens: budget, tokenizer: makeJitter(step) });
      } catch (error) {
        assert.ok(error instanceof CompactError, 'unexpected error type');
        continue;
      }
      assert.ok(
        result.stats.usedTokens <= budget,
        'usedTokens ' + result.stats.usedTokens + ' exceeds budget ' + budget,
      );
    }
  }
});

test('does not report a truncation when a non-deterministic tokenizer keeps the whole message', () => {
  let first = true;
  const tokenizer = (text) => {
    if (text.length === 0) return 0;
    if (text === 'a\nb\n' && first) {
      first = false;
      return 100;
    }
    return Buffer.byteLength(text, 'utf8') + 1;
  };
  const original = [{ role: 'user', content: 'a\nb\n' }];
  const result = compactHistory({ messages: original, maxTokens: 10, tokenizer });
  assert.equal(result.stats.truncatedMessages, 0);
  assert.deepEqual(result.stats.truncatedIndexes, []);
  assert.equal(result.stats.droppedLines, 0);
  assert.equal(result.messages[0].content, 'a\nb\n');
  assert.ok(result.stats.usedTokens <= 10);
});
