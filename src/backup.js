export const BACKUP_FORMAT = "floating-todo-backup";
export const BACKUP_FORMAT_VERSION = 1;

function isRecord(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isLegacySnapshot(value) {
  if (!isRecord(value)) return false;
  const version = Number(value.version);
  if (
    Array.isArray(value.items) &&
    Number.isInteger(version) &&
    version >= 1 &&
    version <= 6
  ) return true;

  const dayBuckets = value.itemsByDay;
  const hasLegacyDayBuckets = isRecord(dayBuckets) &&
    ["today", "tomorrow", "dayAfterTomorrow"].some((key) => Array.isArray(dayBuckets[key]));
  return hasLegacyDayBuckets || Array.isArray(value.recurringItems);
}

export function createBackupPayload(snapshot, memo = {}) {
  return {
    format: BACKUP_FORMAT,
    version: BACKUP_FORMAT_VERSION,
    exportedAt: new Date().toISOString(),
    snapshot,
    memo: {
      content: typeof memo.content === "string" ? memo.content : "",
      windowState: isRecord(memo.windowState) ? memo.windowState : null,
    },
  };
}

export function parseBackupPayload(value) {
  if (!isRecord(value) || value.format !== BACKUP_FORMAT) {
    if (!isLegacySnapshot(value)) {
      throw new Error("File is not a floating-todo backup");
    }
    return { snapshot: value, memo: null };
  }
  if (value.version !== BACKUP_FORMAT_VERSION || !isRecord(value.snapshot)) {
    throw new Error("Unsupported floating-todo backup format");
  }
  const memo = value.memo;
  if (
    !isRecord(memo) ||
    typeof memo.content !== "string" ||
    (memo.windowState !== null && !isRecord(memo.windowState))
  ) {
    throw new Error("Invalid memo data in floating-todo backup");
  }
  return {
    snapshot: value.snapshot,
    memo: {
      content: memo.content,
      windowState: memo.windowState,
    },
  };
}
