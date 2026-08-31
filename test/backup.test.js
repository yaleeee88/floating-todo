import assert from "node:assert/strict";
import test from "node:test";

import {
  BACKUP_FORMAT,
  BACKUP_FORMAT_VERSION,
  createBackupPayload,
  parseBackupPayload,
} from "../src/backup.js";

test("new backups include todo state, memo content, and memo geometry", () => {
  const snapshot = { version: 6, items: [{ id: "todo-1" }] };
  const windowState = { x: 120, y: 80, width: 338, height: 210 };
  const payload = createBackupPayload(snapshot, {
    content: "报名材料清单",
    windowState,
  });

  assert.equal(payload.format, BACKUP_FORMAT);
  assert.equal(payload.version, BACKUP_FORMAT_VERSION);
  assert.equal(payload.snapshot, snapshot);
  assert.equal(payload.memo.content, "报名材料清单");
  assert.equal(payload.memo.windowState, windowState);
  assert.doesNotThrow(() => new Date(payload.exportedAt).toISOString());
});

test("new backup envelopes restore memo data", () => {
  const snapshot = { version: 6, items: [] };
  const parsed = parseBackupPayload({
    format: BACKUP_FORMAT,
    version: BACKUP_FORMAT_VERSION,
    snapshot,
    memo: {
      content: "复习计划",
      windowState: { width: 400, height: 260 },
    },
  });

  assert.equal(parsed.snapshot, snapshot);
  assert.equal(parsed.memo.content, "复习计划");
  assert.deepEqual(parsed.memo.windowState, { width: 400, height: 260 });
});

test("legacy raw snapshot backups remain importable without clearing a memo", () => {
  const legacy = { version: 3, items: [{ id: "legacy" }] };

  assert.deepEqual(parseBackupPayload(legacy), {
    snapshot: legacy,
    memo: null,
  });
});

test("v0.3 day-bucket backups remain importable", () => {
  const legacy = {
    itemsByDay: { today: [], tomorrow: [], dayAfterTomorrow: [] },
    recurringItems: [],
  };

  assert.equal(parseBackupPayload(legacy).snapshot, legacy);
});

test("unsupported future backup envelopes are rejected instead of wiping data", () => {
  assert.throws(
    () => parseBackupPayload({
      format: BACKUP_FORMAT,
      version: BACKUP_FORMAT_VERSION + 1,
      snapshot: {},
    }),
    /Unsupported floating-todo backup format/,
  );
});

test("corrupted memo backup data is rejected instead of clearing the current note", () => {
  assert.throws(
    () => parseBackupPayload({
      format: BACKUP_FORMAT,
      version: BACKUP_FORMAT_VERSION,
      snapshot: {},
      memo: { content: 42, windowState: null },
    }),
    /Invalid memo data/,
  );
});

test("unrelated JSON is rejected instead of replacing todos with an empty snapshot", () => {
  assert.throws(
    () => parseBackupPayload({ project: "unrelated", tasks: [] }),
    /not a floating-todo backup/,
  );
  assert.throws(() => parseBackupPayload({}), /not a floating-todo backup/);
});
