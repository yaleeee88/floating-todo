import assert from "node:assert/strict";
import test from "node:test";
import {
  MEMO_DOCUMENT_KEY, LEGACY_MEMO_KEY, MEMO_FONT,
  normalizeMemoDocument, isMemoDocument, readMemoDocument,
} from "../src/memo-document.js";

test("old memo content migrates literally, including HTML-like text and empty lines", () => {
  const text = '<b>原文</b>\n\n{"hello":"world"}\n';
  const storage = new Map([[LEGACY_MEMO_KEY, text]]);
  const value = readMemoDocument({ getItem: (key) => storage.get(key) ?? null });
  assert.deepEqual(value, { version: 2, text, bold: [], fontSize: 13, pinned: true });
  assert.equal(storage.size, 1);
});

test("rich document takes precedence over the untouched legacy copy", () => {
  const expected = normalizeMemoDocument({ text: "新内容", fontSize: 18, pinned: false });
  const values = new Map([[LEGACY_MEMO_KEY, "旧内容"], [MEMO_DOCUMENT_KEY, JSON.stringify(expected)]]);
  assert.deepEqual(readMemoDocument({ getItem: (key) => values.get(key) ?? null }), expected);
});

test("font sizes are bounded and bold ranges merge without modifying text", () => {
  const result = normalizeMemoDocument({ text: "abcdef", fontSize: 999, pinned: false,
    bold: [{ start: 2, end: 4 }, { start: 0, end: 2 }, { start: 3, end: 20 }, { start: 5, end: 1 }] });
  assert.equal(result.text, "abcdef");
  assert.equal(result.fontSize, MEMO_FONT.max);
  assert.equal(result.pinned, false);
  assert.deepEqual(result.bold, [{ start: 0, end: 6 }]);
  assert.equal(normalizeMemoDocument({ fontSize: -10 }).fontSize, MEMO_FONT.min);
});

test("corrupted rich content throws instead of silently reverting to an old note", () => {
  assert.throws(() => readMemoDocument({ getItem: () => "{" }));
  assert.throws(() => readMemoDocument({ getItem: () => '{"version":3}' }), /Invalid/);
  assert.equal(isMemoDocument({ ...normalizeMemoDocument({ text: "abc" }), bold: [{ start: -1, end: 1 }] }), false);
});
