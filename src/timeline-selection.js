// Only the visible completed tail needs sorting/render preparation. Hidden history
// is counted without computing recurrence dates or allocating decorated entries.
export function selectTimelineEntries(items, goals, { limit = 16, showAll = false } = {}) {
  const pending = [];
  const completed = [];
  let completedCount = 0;
  function visit(value, kind) {
    const done = kind === "todo"
      ? !["daily", "weekdays", "custom"].includes(value.schedule) && !!value.completed
      : value.status === "completed";
    if (!done) {
      pending.push({ kind, value });
      return;
    }
    completedCount++;
    if (showAll) {
      completed.push({ kind, value });
      return;
    }
    const timestamp = value.completedAt || 0;
    if (completed.length >= limit && timestamp <= (completed.at(-1)?.value.completedAt || 0)) return;
    // Upper bound preserves the original stable order for equal timestamps.
    let low = 0, high = completed.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if ((completed[middle].value.completedAt || 0) >= timestamp) low = middle + 1;
      else high = middle;
    }
    completed.splice(low, 0, { kind, value });
    if (completed.length > limit) completed.pop();
  }
  for (const item of items) visit(item, "todo");
  for (const goal of goals) visit(goal, "goal");
  if (showAll) completed.sort((a, b) => (b.value.completedAt || 0) - (a.value.completedAt || 0));
  return { pending, completed, completedCount, hiddenCount: Math.max(0, completedCount - limit) };
}
