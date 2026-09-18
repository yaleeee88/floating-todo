import assert from "node:assert/strict";
import test from "node:test";
import { selectTimelineEntries } from "../src/timeline-selection.js";
import { APPEARANCE_KEY, MEMO_PRESENCE_KEY, appearanceSettings, publishAppearance, publishSignal } from "../src/window-sync.js";

test("completed selection matches stable full sorting, including tied/missing timestamps", () => {
  let seed = 17;
  const random = () => { seed = (seed * 16807) % 2147483647; return seed; };
  for (const size of [0, 1, 16, 17, 1000, 10000]) {
    const items = Array.from({ length: size }, (_, id) => ({ id, completed: true, completedAt: random() % 50 }));
    const goals = Array.from({ length: 30 }, (_, id) => ({ id, status: "completed", completedAt: random() % 20 }));
    const expected = [...items.map((value) => ({ kind: "todo", value })), ...goals.map((value) => ({ kind: "goal", value }))]
      .sort((a, b) => (b.value.completedAt || 0) - (a.value.completedAt || 0));
    const original = structuredClone({ items, goals });
    for (const limit of [0, 1, 16, 40]) {
      const selected = selectTimelineEntries(items, goals, { limit });
      assert.deepEqual(selected.completed, expected.slice(0, limit));
      assert.equal(selected.completedCount, size + 30);
      assert.equal(selected.hiddenCount, Math.max(0, size + 30 - limit));
      assert.deepEqual(selectTimelineEntries(items, goals, { limit, showAll: true }).completed, expected);
    }
    assert.deepEqual({ items, goals }, original);
  }
});

test("recurring plans and paused goals never disappear into the completed tail", () => {
  const items = [{ id: 1, completed: true }, { id: 2, completed: false }, { id: 3, schedule: "daily", completed: true },
    { id: 4, schedule: "custom", completed: true }, { id: 5, schedule: "weekdays", completed: true }];
  const goals = [{ id: 6, status: "paused" }, { id: 7, status: "active" }];
  const result = selectTimelineEntries(items, goals);
  assert.deepEqual(result.pending.map(({ value }) => value.id), [2, 3, 4, 5, 6, 7]);
  assert.deepEqual(result.completed.map(({ value }) => value.id), [1]);
});

test("completed selection immediately reflects edits/restores without stale caches", () => {
  const items = Array.from({ length: 30 }, (_, id) => ({ id, completed: true, completedAt: id }));
  assert.equal(selectTimelineEntries(items, []).completed[0].value.id, 29);
  items[0].completedAt = 100;
  assert.equal(selectTimelineEntries(items, []).completed[0].value.id, 0);
  items[0].completed = false;
  assert.equal(selectTimelineEntries(items, []).pending[0].value.id, 0);
  assert.equal(selectTimelineEntries(items, []).completedCount, 29);
});

test("hidden history is selected without reading dates, recurrence records or details", () => {
  const items = Array.from({ length: 100 }, (_, id) => ({ id, completed: true, completedAt: id,
    get dueDate() { throw new Error("Unexpected date calculation"); },
    get records() { throw new Error("Unexpected record traversal"); },
    get detail() { throw new Error("Unexpected detail traversal"); },
  }));
  assert.equal(selectTimelineEntries(items, []).completed.length, 16);
});

test("small window signals write only on change and do not copy unrelated data", () => {
  const data = new Map();
  let writes = 0;
  const storage = { getItem: (key) => data.get(key) ?? null, setItem: (key, value) => { writes++; data.set(key, value); } };
  const settings = { appearance: "dark", opacity: 0.8, customBg: " #123456 ", unrelated: "private" };
  for (let i = 0; i < 20; i++) publishAppearance(storage, settings);
  assert.equal(writes, 1);
  assert.deepEqual(JSON.parse(data.get(APPEARANCE_KEY)), { appearance: "dark", opacity: 0.8, customBg: "#123456" });
  for (let i = 0; i < 20; i++) publishSignal(storage, MEMO_PRESENCE_KEY, "1");
  assert.equal(writes, 2);
  publishSignal(storage, MEMO_PRESENCE_KEY, "0");
  assert.equal(writes, 3);
});

test("invalid appearance values are bounded and signal failure does not throw", () => {
  assert.deepEqual(appearanceSettings(null), { appearance: "system", opacity: 0.9, customBg: null });
  assert.equal(appearanceSettings({ opacity: 3 }).opacity, 1);
  assert.equal(appearanceSettings({ opacity: 0 }).opacity, 0.45);
  assert.equal(appearanceSettings({ opacity: "", customBg: " " }).opacity, 0.9);
  assert.equal(publishAppearance({ getItem() { throw new Error("Storage full"); } }, {}), false);
});
