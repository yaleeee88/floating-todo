/* 悬浮待办 · 时间线版 (Tauri v2 + 原生 JavaScript) */

import {
  addDays,
  bucketFutureHorizonEntries,
  buildFutureHorizonEntries,
  dayDistance,
  dueTimestamp,
  fromDateKey,
  goalProgressForDate,
  goalWeekStats,
  migrateSnapshot,
  routineOccursOnDate,
  routinesForDate,
  todoOccursOnDate,
  toDateKey,
} from "./domain.js";
import {
  isWindowPositionVisible,
  normalizeWindowState,
  WINDOW_LIMITS,
} from "./window-state.js";

const TAURI = window.__TAURI__;
const appWindow = TAURI?.window?.getCurrentWindow?.();
const reducedMotionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
const STORAGE_KEY = "floating-todo/snapshot";
const WINDOW_STATE_KEY = "floating-todo/window-state-v1";
const WINDOW_STATE_SAVE_DELAY = 220;
const COMPACT_ENTER_WIDTH = 300;
const COMPACT_ENTER_HEIGHT = 260;
const COMPACT_EXIT_WIDTH = 312;
const COMPACT_EXIT_HEIGHT = 272;
const OVERVIEW_WIDE_BREAKPOINT = 720;
const OVERVIEW_LARGE_BREAKPOINT = 1100;
const COMPLETED_RENDER_LIMIT = 16;
const app = document.getElementById("app");
document.documentElement.classList.toggle("browser-preview", !TAURI);
document.documentElement.classList.toggle("native-app", !!TAURI);

if ("scrollRestoration" in history) history.scrollRestoration = "manual";
window.scrollTo(0, 0);

const uid = () =>
  crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;

function readSnapshot() {
  try {
    return migrateSnapshot(JSON.parse(localStorage.getItem(STORAGE_KEY)));
  } catch (_) {
    return migrateSnapshot(null);
  }
}

function readWindowState() {
  try {
    return normalizeWindowState(JSON.parse(localStorage.getItem(WINDOW_STATE_KEY)));
  } catch (_) {
    return null;
  }
}

let state = readSnapshot();
let rememberedWindowState = readWindowState();
let compact = rememberedWindowState?.compact === true;
let lastRenderedDate = toDateKey();
let statusAnnouncement = "";
let windowStateSaveTimer = null;
let stateSaveTimer = null;
let appearanceFrame = null;
let reminderCheckRunning = false;
let notificationPermissionRequested = false;
let appliedAlwaysOnTop;
let appliedClickThrough;
let showAllCompleted = false;
let activeMainView = "overview";
let overviewWidthTier = getOverviewWidthTier();
let lastRenderedMainView = null;
let pendingMotionCue = null;
const viewScrollTop = { overview: 0, list: 0 };

function getOverviewWidthTier(width = window.innerWidth) {
  if (width >= OVERVIEW_LARGE_BREAKPOINT) return 2;
  if (width >= OVERVIEW_WIDE_BREAKPOINT) return 1;
  return 0;
}

function save() {
  if (stateSaveTimer !== null) {
    clearTimeout(stateSaveTimer);
    stateSaveTimer = null;
  }
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    return true;
  } catch (error) {
    statusAnnouncement = "本地存储空间不足，新更改暂时无法保存";
    console.error("Unable to persist the todo snapshot", error);
    return false;
  }
}

function cloneValue(value) {
  return JSON.parse(JSON.stringify(value));
}

function scheduleStateSave() {
  if (stateSaveTimer !== null) clearTimeout(stateSaveTimer);
  stateSaveTimer = setTimeout(() => {
    stateSaveTimer = null;
    if (!save()) render();
  }, 400);
}

function flushStateSave() {
  if (stateSaveTimer === null) return;
  clearTimeout(stateSaveTimer);
  stateSaveTimer = null;
  save();
}

function persistMutation(mutate) {
  const rollback = mutate();
  if (save()) return true;
  rollback?.();
  statusAnnouncement = "本地存储空间不足，新更改未保存";
  return false;
}

function showPersistenceError(overlay, message = "本地存储空间不足，暂时无法保存。请先导出备份并清理较早记录。") {
  if (!overlay) return;
  statusAnnouncement = "";
  let error = overlay.querySelector("[data-persistence-error]");
  if (!error) {
    error = document.createElement("p");
    error.className = "dialog-save-error";
    error.dataset.persistenceError = "";
    error.setAttribute("role", "alert");
    const actions = overlay.querySelector(".dialog-actions");
    if (actions) actions.before(error);
    else overlay.querySelector(".dialog")?.append(error);
  }
  error.textContent = message;
}

function clearPersistenceError(overlay) {
  overlay?.querySelector("[data-persistence-error]")?.remove();
}

function pruneTransientState(dateKey = toDateKey()) {
  const validIds = new Set([
    ...state.items.map((item) => item.id),
    ...(state.goals || []).map((goal) => goal.id),
  ]);
  state.expandedIds = [...new Set(state.expandedIds || [])].filter((id) => validIds.has(id));
  if (state.settings.todayActionsCollapsedDate && state.settings.todayActionsCollapsedDate !== dateKey) {
    state.settings.todayActionsCollapsedDate = "";
  }
  for (const goal of state.goals || []) {
    const todayNotifications = goal.notifiedRecords?.[dateKey];
    goal.notifiedRecords = todayNotifications ? { [dateKey]: todayNotifications } : {};
  }
  for (const item of state.items || []) {
    if (!isRecurringTodo(item)) continue;
    const notifiedToday = item.notifiedRecords?.[dateKey] === true;
    item.notifiedRecords = notifiedToday ? { [dateKey]: true } : {};
  }
}

// 旧数据加载后立即以当前格式落盘，之后不再重复迁移。
pruneTransientState();
save();

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]
  );
}

function linkify(value) {
  return esc(value).replace(
    /(https?:\/\/[^\s<]+)/g,
    '<a href="$1" data-link="$1">$1</a>'
  );
}

function timeModeFor(startTime, endTime) {
  if (!startTime) return "none";
  return endTime ? "range" : "point";
}

function timeModeOptions(mode) {
  return [
    ["none", "不设时间"],
    ["point", "时间点"],
    ["range", "时间段"],
  ].map(([value, label]) =>
    `<option value="${value}" ${mode === value ? "selected" : ""}>${label}</option>`
  ).join("");
}

function timeRangeLabel(startTime, endTime, emptyLabel = "不设时间") {
  if (!startTime) return emptyLabel;
  return endTime ? `${startTime}–${endTime}` : startTime;
}

function timeRangeAriaLabel(startTime, endTime, emptyLabel = "不设时间") {
  if (!startTime) return emptyLabel;
  return endTime ? `${startTime} 至 ${endTime}` : startTime;
}

function syncTimeEditor(root) {
  if (!root) return;
  const mode = root.querySelector("[data-time-mode]")?.value || "none";
  const fields = root.querySelector("[data-time-fields]");
  const startInput = root.querySelector("[data-time-start]");
  const endInput = root.querySelector("[data-time-end]");
  const endField = root.querySelector("[data-time-end-field]");
  const startLabel = root.querySelector("[data-time-start-label]");
  fields?.classList.toggle("hidden", mode === "none");
  fields?.classList.toggle("point", mode === "point");
  endField?.classList.toggle("hidden", mode !== "range");
  if (startLabel) startLabel.textContent = mode === "range" ? "开始时间" : "时间点";
  if (startInput) startInput.disabled = mode === "none";
  if (endInput) endInput.disabled = mode !== "range";
  root.querySelector("[data-time-error]")?.classList.add("hidden");
  startInput?.removeAttribute("aria-invalid");
  endInput?.removeAttribute("aria-invalid");
}

function readTimeEditor(root) {
  const mode = root?.querySelector("[data-time-mode]")?.value || "none";
  const startInput = root?.querySelector("[data-time-start]");
  const endInput = root?.querySelector("[data-time-end]");
  const startTime = mode === "none" ? "" : startInput?.value || "";
  const endTime = mode === "range" ? endInput?.value || "" : "";
  let message = "";
  let invalidInput = null;
  if (mode !== "none" && !startTime) {
    message = mode === "range" ? "请选择开始时间" : "请选择时间点";
    invalidInput = startInput;
  } else if (mode === "range" && !endTime) {
    message = "请选择结束时间";
    invalidInput = endInput;
  } else if (mode === "range" && endTime <= startTime) {
    message = "结束时间需晚于开始时间";
    invalidInput = endInput;
  }
  return { mode, startTime, endTime, message, invalidInput };
}

function showTimeEditorError(root, result) {
  const error = root?.querySelector("[data-time-error]");
  if (error) {
    error.textContent = result.message;
    error.classList.remove("hidden");
  }
  result.invalidInput?.setAttribute("aria-invalid", "true");
  result.invalidInput?.focus();
  root?.classList.add("shake");
  setTimeout(() => root?.classList.remove("shake"), 300);
}

function preferredScrollBehavior() {
  return reducedMotionQuery.matches ? "auto" : "smooth";
}

function queueMotionCue(type, id, routineId = "", subtaskId = "") {
  pendingMotionCue = { type, id, routineId, subtaskId };
}

function playPendingMotionCue() {
  const cue = pendingMotionCue;
  pendingMotionCue = null;
  if (!cue || reducedMotionQuery.matches) return;

  const matching = [...app.querySelectorAll("[data-id]")].filter((element) =>
    element.dataset.id === cue.id &&
    (!cue.routineId || element.dataset.routineId === cue.routineId) &&
    (!cue.subtaskId || element.dataset.subtaskId === cue.subtaskId)
  );
  if (cue.type === "expand") {
    const expanded = matching
      .map((element) => element.closest(".todo-row"))
      .find((row) => row?.querySelector(".todo-expanded"));
    expanded?.querySelector(".todo-expanded")?.classList.add("motion-reveal");
    return;
  }

  const rows = new Set(matching.map((element) =>
    element.closest(".overview-action, .todo-row, .overview-goal, .nearest-node, .horizon-entry")
  ).filter(Boolean));
  rows.forEach((row) => {
    row.classList.add("motion-state-change");
    row.querySelector(".check.on, .overview-check.on, .subtask-check.on, .goal-progress.complete")
      ?.classList.add("motion-check-pop");
  });
}

function captureFocusDescriptor(element = document.activeElement) {
  const control = element?.closest?.("[data-act]");
  if (!control || !app.contains(control)) return null;
  return {
    act: control.dataset.act || "",
    id: control.dataset.id || "",
    routineId: control.dataset.routineId || "",
    subtaskId: control.dataset.subtaskId || "",
    bucket: control.dataset.bucket || "",
    focusScope: control.dataset.focusScope || "",
  };
}

function restoreFocusDescriptor(descriptor) {
  if (!descriptor?.act) return;
  const restored = [...app.querySelectorAll(`[data-act="${descriptor.act}"]`)].find((element) =>
    (element.dataset.id || "") === descriptor.id &&
    (element.dataset.routineId || "") === descriptor.routineId &&
    (element.dataset.subtaskId || "") === descriptor.subtaskId &&
    (element.dataset.bucket || "") === descriptor.bucket &&
    (element.dataset.focusScope || "") === descriptor.focusScope
  );
  restored?.focus({ preventScroll: true });
}

function dismissOverlay(overlay, onRemoved) {
  if (!overlay?.isConnected) {
    onRemoved?.();
    return;
  }
  if (overlay.classList.contains("is-closing")) return;
  if (reducedMotionQuery.matches) {
    overlay.remove();
    onRemoved?.();
    return;
  }
  let fallbackTimer = null;
  const finish = () => {
    if (fallbackTimer !== null) clearTimeout(fallbackTimer);
    overlay.removeEventListener("animationend", onAnimationEnd);
    overlay.remove();
    onRemoved?.();
  };
  const onAnimationEnd = (event) => {
    if (event.target === overlay) finish();
  };
  overlay.addEventListener("animationend", onAnimationEnd);
  overlay.classList.add("is-closing");
  fallbackTimer = setTimeout(finish, 180);
}

const ICONS = {
  reminders: '<svg viewBox="0 0 44 44" width="44" height="44" aria-hidden="true"><circle cx="11" cy="13" r="4" fill="#ff9f0a"/><path d="m9.2 13 1.2 1.2 2.3-2.5" fill="none" stroke="white" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/><circle cx="11" cy="22" r="4" fill="#34c759"/><path d="m9.2 22 1.2 1.2 2.3-2.5" fill="none" stroke="white" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/><circle cx="11" cy="31" r="4" fill="#0a84ff"/><path d="m9.2 31 1.2 1.2 2.3-2.5" fill="none" stroke="white" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/><path d="M19 13h15M19 22h15M19 31h11" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" opacity=".58"/></svg>',
  check: '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg>',
  plus: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.4"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>',
  arrow: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 6 6 6-6 6"/></svg>',
  edit: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>',
  trash: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M8 6V4h8v2M19 6l-1 15H6L5 6M10 11v6M14 11v6"/></svg>',
  gear: '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1-2.9 2.9-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21h-4v-.1a1.7 1.7 0 0 0-1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1-2.9-2.9.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3v-4h.1A1.7 1.7 0 0 0 4.6 9a1.7 1.7 0 0 0-.3-1.8l-.1-.1 2.9-2.9.1.1A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-1.5V3h4v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1 2.9 2.9-.1.1a1.7 1.7 0 0 0-.3 1.8 1.7 1.7 0 0 0 1.5 1h.1v4h-.1a1.7 1.7 0 0 0-1.5 1Z"/></svg>',
  empty: '<svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="4" y="3" width="16" height="18" rx="3"/><path d="m8 12 2.4 2.4L16 9M8 6.5h8"/></svg>',
  close: '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2.2"><path d="m6 6 12 12M18 6 6 18"/></svg>',
  download: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 3v12m0 0 4-4m-4 4-4-4M5 21h14"/></svg>',
  upload: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 17V5m0 0 4 4m-4-4L8 9M5 21h14"/></svg>',
  target: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.9"><circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3"/><path d="M12 2v3M22 12h-3"/></svg>',
  repeat: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m17 2 4 4-4 4"/><path d="M3 11V9a3 3 0 0 1 3-3h15"/><path d="m7 22-4-4 4-4"/><path d="M21 13v2a3 3 0 0 1-3 3H3"/></svg>',
  pause: '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg>',
  play: '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="m8 5 11 7-11 7z"/></svg>',
  overview: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="2"/><rect x="14" y="3" width="7" height="4" rx="2"/><rect x="14" y="11" width="7" height="10" rx="2"/><rect x="3" y="14" width="7" height="7" rx="2"/></svg>',
  list: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><path d="M9 6h11M9 12h11M9 18h11"/><circle cx="4.5" cy="6" r="1" fill="currentColor" stroke="none"/><circle cx="4.5" cy="12" r="1" fill="currentColor" stroke="none"/><circle cx="4.5" cy="18" r="1" fill="currentColor" stroke="none"/></svg>',
  calendar: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="16" rx="3"/><path d="M8 3v4M16 3v4M3 10h18"/><path d="M8 14h.01M12 14h.01M16 14h.01M8 17.5h.01M12 17.5h.01" stroke-width="2.5"/></svg>',
};

function goalSortTimestamp(goal, dateKey = toDateKey()) {
  if (goal.status === "active") {
    const todayRoutines = routinesForDate(goal, dateKey);
    const pendingRoutines = todayRoutines.filter((routine) => !goal.records?.[dateKey]?.[routine.id]);
    if (pendingRoutines.length) {
      return Math.min(...pendingRoutines.map((routine) => dueTimestamp({
        dueDate: dateKey,
        dueTime: routine.time || "",
      })));
    }
    if (todayRoutines.length) return dueTimestamp({ dueDate: dateKey, dueTime: "" });
  }
  return dueTimestamp({ dueDate: goal.targetDate, dueTime: "" });
}

function timelineTier(entry, dateKey = toDateKey()) {
  if (entry.kind === "todo") {
    const item = entry.value;
    if (!isRecurringTodo(item)) return item.completed ? 4 : 0;
    // Future recurring occurrences belong in the same pending tier as one-off
    // todos, so the shared due timestamp can keep the list truly chronological.
    if (!todoOccursOnDate(item, dateKey)) return 0;
    return todoCompletedForDate(item, dateKey) ? 1 : 0;
  }
  const goal = entry.value;
  if (goal.status === "completed") return 4;
  if (goal.status === "paused") return 3;
  const progress = goalDailyProgress(goal, dateKey);
  if (progress.remaining > 0) return 0;
  if (progress.total > 0) return 1;
  return 2;
}

function getTimelineEntries() {
  const dateKey = toDateKey();
  const entries = [
    ...state.items.map((item) => ({ kind: "todo", value: item })),
    ...(state.goals || []).map((goal) => ({ kind: "goal", value: goal })),
  ].map((entry) => ({
    entry,
    tier: timelineTier(entry, dateKey),
    due: entry.kind === "todo"
      ? dueTimestamp({
          dueDate: nextTodoOccurrence(entry.value, dateKey),
          dueTime: entry.value.dueTime || "",
        })
      : goalSortTimestamp(entry.value, dateKey),
    completedAt: entry.kind === "todo" && isRecurringTodo(entry.value)
      ? todoRecordForDate(entry.value, dateKey)?.completedAt || 0
      : entry.value.completedAt || 0,
    createdAt: entry.value.createdAt || 0,
  }));
  return entries.sort((a, b) => {
    if (a.tier !== b.tier) return a.tier - b.tier;
    if (a.tier === 4) return b.completedAt - a.completedAt;
    if (a.due !== b.due) return a.due - b.due;
    return a.createdAt - b.createdAt;
  }).map(({ entry }) => entry);
}

function limitCompletedEntries(entries) {
  let completedCount = 0;
  const visibleEntries = entries.filter((entry) => {
    const completed = entry.kind === "todo"
      ? !isRecurringTodo(entry.value) && !!entry.value.completed
      : entry.value.status === "completed";
    if (!completed) return true;
    completedCount += 1;
    return showAllCompleted || completedCount <= COMPLETED_RENDER_LIMIT;
  });
  return {
    entries: visibleEntries,
    completedCount,
    hiddenCount: Math.max(0, completedCount - COMPLETED_RENDER_LIMIT),
  };
}

function headerStatusSummary() {
  const dateKey = toDateKey();
  const pendingTodos = state.items.filter((item) => isRecurringTodo(item)
    ? todoOccursOnDate(item, dateKey) && !todoCompletedForDate(item, dateKey)
    : !item.completed
  ).length;
  const recurringPlans = state.items.filter(isRecurringTodo).length;
  const activeGoals = (state.goals || []).filter((goal) => goal.status === "active").length;
  const pausedGoals = (state.goals || []).filter((goal) => goal.status === "paused").length;
  const parts = [];
  if (pendingTodos) parts.push(`${pendingTodos} 项待办`);
  if (activeGoals) parts.push(`${activeGoals} 个目标`);
  if (!pendingTodos && !activeGoals && recurringPlans) parts.push(`${recurringPlans} 项重复计划`);
  if (!pendingTodos && !activeGoals && pausedGoals) parts.push(`${pausedGoals} 个目标已暂停`);
  return parts.length ? parts.join(" · ") : "全部完成";
}

function getTodayGoalActions(dateKey = toDateKey()) {
  const actions = [];
  (state.goals || [])
    .filter((goal) => goal.status === "active")
    .forEach((goal) => {
      routinesForDate(goal, dateKey).forEach((routine, routineIndex) => {
        actions.push({
          goal,
          routine,
          routineIndex,
          completed: goal.records?.[dateKey]?.[routine.id] === true,
        });
      });
    });
  return actions.sort((a, b) => {
    if (a.completed !== b.completed) return a.completed ? 1 : -1;
    const aTime = dueTimestamp({ dueDate: dateKey, dueTime: a.routine.time || "" });
    const bTime = dueTimestamp({ dueDate: dateKey, dueTime: b.routine.time || "" });
    if (aTime !== bTime) return aTime - bTime;
    const goalOrder = (a.goal.createdAt || 0) - (b.goal.createdAt || 0);
    if (goalOrder !== 0) return goalOrder;
    return a.routineIndex - b.routineIndex;
  });
}

function todayGoalActionsHtml() {
  const dateKey = toDateKey();
  const actions = getTodayGoalActions(dateKey);
  if (!actions.length) return "";
  const completed = actions.filter((action) => action.completed).length;
  const allComplete = completed === actions.length;
  const collapsed = state.settings.todayActionsCollapsedDate === dateKey;
  const displayedActions = compact
    ? actions.filter((action) => !action.completed).slice(0, 1)
    : actions;
  const showList = !collapsed && (!compact || !allComplete) && displayedActions.length > 0;
  return `<section class="today-actions-board ${collapsed ? "collapsed" : ""} ${allComplete ? "all-complete" : ""}" aria-labelledby="today-actions-title">
    <button class="today-actions-head" data-act="today-actions-toggle" aria-expanded="${showList}" aria-controls="today-actions-list">
      <span class="today-actions-symbol" aria-hidden="true">${ICONS.repeat}</span>
      <div><h2 id="today-actions-title">今日行动</h2><p>来自 ${new Set(actions.map((action) => action.goal.id)).size} 个阶段目标</p></div>
      <span class="today-actions-progress" aria-label="今日 ${actions.length} 项行动中已完成 ${completed} 项">${completed}/${actions.length}</span>
      <span class="today-actions-chevron" aria-hidden="true">${ICONS.arrow}</span>
    </button>
    ${showList ? `<ul class="today-actions-list" id="today-actions-list">
      ${displayedActions.map(({ goal, routine, completed: checked }) => `<li class="today-action-row ${checked ? "done" : ""}">
        <button class="subtask-check ${checked ? "on" : ""}" data-act="goal-routine-toggle" data-id="${esc(goal.id)}" data-routine-id="${esc(routine.id)}" data-focus-scope="today" role="checkbox" aria-checked="${checked}" aria-label="${checked ? "恢复" : "完成"}今日行动：${esc(routine.title)}">${checked ? ICONS.check : ""}</button>
        <button class="today-action-main" data-act="goal-reveal" data-id="${esc(goal.id)}" aria-label="查看阶段目标${esc(goal.title)}">
          <span class="today-action-title">${esc(routine.title)}</span>
          <span class="today-action-meta"><span class="today-action-goal">${esc(goal.title)}</span><span>·</span><time ${routine.time ? `datetime="${esc(dateKey)}T${esc(routine.time)}"` : ""} aria-label="${esc(timeRangeAriaLabel(routine.time, routine.endTime))}">${esc(timeRangeLabel(routine.time, routine.endTime))}</time></span>
        </button>
        <span class="today-action-arrow" aria-hidden="true">${ICONS.arrow}</span>
      </li>`).join("")}
    </ul>` : ""}
  </section>`;
}

function shortDateLabel(dateKey) {
  const date = fromDateKey(dateKey);
  if (!date) return "未设日期";
  const prefix = date.getFullYear() === new Date().getFullYear() ? "" : `${date.getFullYear()}年`;
  return `${prefix}${date.getMonth() + 1}月${date.getDate()}日`;
}

function compactRelativeLabel(dateKey) {
  const days = dayDistance(dateKey);
  if (!Number.isFinite(days)) return "";
  if (days === 0) return "今天";
  if (days > 0) return `剩余 ${days} 天`;
  return `逾期 ${Math.abs(days)} 天`;
}

function horizonDateLabel(dateKey) {
  const date = fromDateKey(dateKey);
  if (!date) return "未设日期";
  const monthDay = `${date.getMonth() + 1}/${date.getDate()}`;
  return date.getFullYear() === new Date().getFullYear()
    ? monthDay
    : `${date.getFullYear()}/${monthDay}`;
}

function horizonDistanceLabel(dateKey) {
  const days = dayDistance(dateKey);
  if (!Number.isFinite(days)) return "";
  if (days === 0) return "今天";
  if (days > 0) return `剩${days}天`;
  return `逾期${Math.abs(days)}天`;
}

function todayHeaderLabel() {
  const date = new Date();
  const weekdays = ["日", "一", "二", "三", "四", "五", "六"];
  return `${date.getMonth() + 1}月${date.getDate()}日 · 星期${weekdays[date.getDay()]}`;
}

function rowHtml(item) {
  const dateKey = toDateKey();
  const safeItemId = esc(item.id);
  const detailsId = `todo-details-${item.id}`;
  const safeDetailsId = esc(detailsId);
  const recurring = isRecurringTodo(item);
  const occursToday = recurring && todoOccursOnDate(item, dateKey);
  const displayDate = recurring ? nextTodoOccurrence(item, dateKey) : item.dueDate;
  const completed = recurring
    ? occursToday && todoCompletedForDate(item, dateKey)
    : todoCompletedForDate(item, dateKey);
  const canToggle = !recurring || occursToday;
  const expanded = !compact && state.expandedIds.includes(item.id);
  const distance = dayDistance(displayDate);
  const distanceClass = distance < 0 ? "overdue" : distance === 0 ? "today" : "";
  const statusClass = completed ? "completed" : "pending";
  const statusText = completed ? "已完成" : recurring && !occursToday ? "下次" : "待完成";
  const itemTimeLabel = timeRangeLabel(item.dueTime, item.dueEndTime, "");
  const dateTimeText = `${shortDateLabel(displayDate)}${itemTimeLabel ? ` ${itemTimeLabel}` : ""}`;
  const repeatLabel = todoScheduleLabel(item);
  const subtasks = Array.isArray(item.subtasks) ? item.subtasks : [];
  const completedSubtasks = subtasks.filter((subtask) =>
    (!recurring || occursToday) && todoSubtaskCompletedForDate(item, subtask.id, dateKey)
  ).length;
  const subtasksHtml = expanded && subtasks.length
    ? `<section class="subtask-section" aria-label="子待办">
        <div class="subtask-head"><span>子待办</span><span aria-label="${subtasks.length} 个子待办中已完成 ${completedSubtasks} 个">${completedSubtasks}/${subtasks.length} 已完成</span></div>
        <ul class="subtask-list" aria-label="${esc(item.title)}的子待办">
          ${subtasks.map((subtask) => {
            const subtaskCompleted = (!recurring || occursToday) &&
              todoSubtaskCompletedForDate(item, subtask.id, dateKey);
            return `<li class="subtask-row ${subtaskCompleted ? "done" : ""}">
            <button class="subtask-check ${subtaskCompleted ? "on" : ""}" data-act="subtask-toggle" data-id="${esc(item.id)}" data-subtask-id="${esc(subtask.id)}" role="checkbox" aria-checked="${subtaskCompleted}" ${canToggle ? "" : "disabled"} aria-label="${subtaskCompleted ? "恢复" : "完成"}子待办：${esc(subtask.title)}">${subtaskCompleted ? ICONS.check : ""}</button>
            <span>${esc(subtask.title)}</span>
          </li>`;
          }).join("")}
        </ul>
      </section>`
    : "";
  const details = expanded
    ? `<div class="todo-expanded" id="${safeDetailsId}">
        ${item.detail
          ? `<div class="description">${linkify(item.detail)}</div>`
          : subtasks.length ? "" : '<div class="description muted">暂无更多说明</div>'}
        ${subtasksHtml}
        <div class="expanded-footer">
          <div class="row-actions">
            <button class="text-action" data-act="edit" data-id="${safeItemId}">${ICONS.edit} 编辑</button>
            <button class="text-action danger" data-act="delete" data-id="${safeItemId}">${ICONS.trash} 删除</button>
          </div>
        </div>
      </div>`
    : "";

  return `<article class="todo-row ${completed ? "done" : ""} ${recurring ? "recurring" : ""} ${expanded ? "expanded" : ""}" data-id="${safeItemId}">
    <div class="todo-summary">
      <button class="check ${completed ? "on" : ""}" data-act="toggle" data-id="${safeItemId}" aria-pressed="${completed}" ${canToggle ? "" : "disabled"} aria-label="${completed ? `恢复待办：${esc(item.title)}` : `完成待办：${esc(item.title)}`}">${completed ? ICONS.check : ""}</button>
      <button class="todo-main" data-act="expand" data-id="${safeItemId}" aria-expanded="${expanded}" aria-controls="${safeDetailsId}">
        <span class="todo-title">${esc(item.title)}</span>
        <span class="todo-meta">
          <span class="meta-status ${statusClass}">${statusText}</span>
          <span class="meta-dot">·</span>
          <time class="meta-date" datetime="${esc(displayDate)}${item.dueTime ? `T${esc(item.dueTime)}` : ""}" aria-label="${esc(`${shortDateLabel(displayDate)}${itemTimeLabel ? ` ${timeRangeAriaLabel(item.dueTime, item.dueEndTime)}` : ""}`)}">${esc(dateTimeText)}</time>
          ${repeatLabel ? `<span class="meta-dot">·</span><span class="meta-repeat">${ICONS.repeat} ${esc(repeatLabel)}</span>` : ""}
          ${completed ? "" : `<span class="meta-dot">·</span><span class="meta-relative ${distanceClass}" data-relative="${esc(displayDate)}">${compactRelativeLabel(displayDate)}</span>`}
          ${subtasks.length ? `<span class="meta-dot">·</span><span class="meta-subtasks" aria-label="${subtasks.length} 个子待办中已完成 ${completedSubtasks} 个">${completedSubtasks}/${subtasks.length} 子待办</span>` : ""}
        </span>
      </button>
      <span class="chevron ${expanded ? "up" : ""}" data-act="expand" data-id="${esc(item.id)}" aria-hidden="true">${ICONS.arrow}</span>
    </div>
    ${details}
  </article>`;
}

function goalDailyProgress(goal, dateKey = toDateKey()) {
  return goalProgressForDate(goal, dateKey);
}

function goalCumulativeCompletions(goal) {
  return Object.entries(goal.records || {}).reduce((total, [dateKey, record]) => {
    const scheduledIds = new Set(routinesForDate(goal, dateKey).map((routine) => routine.id));
    return total + Object.entries(record || {})
      .filter(([id, completed]) => completed === true && scheduledIds.has(id)).length;
  }, 0);
}

function goalStatusText(goal, progress, targetDistance) {
  if (goal.status === "completed") return "目标已完成";
  if (goal.status === "paused") return "已暂停";
  if (targetDistance < 0) return "目标已到期";
  if (!progress.total) return "今日无计划";
  if (progress.completed === progress.total) return "今日已完成";
  return `今日 ${progress.completed}/${progress.total}`;
}

function goalRowHtml(goal) {
  const dateKey = toDateKey();
  const expanded = !compact && state.expandedIds.includes(goal.id);
  const progress = goalDailyProgress(goal, dateKey);
  const targetDistance = dayDistance(goal.targetDate);
  const statusText = goalStatusText(goal, progress, targetDistance);
  const targetRelative = compactRelativeLabel(goal.targetDate);
  const completedToday = progress.total > 0 && progress.completed === progress.total;
  const goalFinished = goal.status === "completed";
  const progressRatio = goalFinished ? 1 : progress.total ? progress.completed / progress.total : 0;
  const detailsId = `goal-details-${goal.id}`;

  let details = "";
  if (expanded) {
    const week = goalWeekStats(goal, new Date());
    const cumulative = goalCumulativeCompletions(goal);
    const routineList = goal.status === "active" && progress.routines.length
      ? `<ul class="goal-routine-list" aria-label="${esc(goal.title)}的今日计划">
          ${progress.routines.map((routine) => {
            const checked = !!goal.records?.[dateKey]?.[routine.id];
            return `<li class="goal-routine-row ${checked ? "done" : ""}">
              <span class="subtask-check goal-routine-indicator ${checked ? "on" : ""}" role="img" aria-label="${checked ? "已完成" : "未完成"}">${checked ? ICONS.check : ""}</span>
              <span class="goal-routine-copy"><strong>${esc(routine.title)}</strong><small aria-label="${esc(timeRangeAriaLabel(routine.time, routine.endTime))}">${esc(timeRangeLabel(routine.time, routine.endTime))}</small></span>
            </li>`;
          }).join("")}
        </ul>`
      : `<div class="goal-routine-empty">${
          goal.status === "paused" ? "目标已暂停，恢复后继续今日计划" :
          goal.status === "completed" ? "这个阶段目标已经完成" :
          targetDistance < 0 ? "目标日期已到，可以完成目标或延长日期" :
          "今天没有安排重复行动"
        }</div>`;

    details = `<div class="todo-expanded goal-expanded" id="${esc(detailsId)}">
        ${goal.detail ? `<div class="description">${linkify(goal.detail)}</div>` : ""}
        <section class="goal-today-section" aria-label="今日计划">
          <div class="goal-section-head"><span>今日计划</span>${goal.status === "active" && progress.total ? '<button data-act="today-actions-reveal">在顶部直接操作</button>' : ""}<span aria-label="今日 ${progress.total} 项行动中已完成 ${progress.completed} 项">${progress.completed}/${progress.total}</span></div>
          ${routineList}
        </section>
        <div class="goal-insights" aria-label="目标执行统计">
          <span><b>${week.completed}/${week.total}</b> 本周行动</span>
          <span><b>${cumulative}</b> 累计完成</span>
        </div>
        <div class="goal-deadline"><span>${ICONS.target}</span><div><small>目标日期</small><strong>${esc(shortDateLabel(goal.targetDate))} · ${esc(targetRelative)}</strong></div></div>
        <div class="expanded-footer goal-actions">
          <div class="row-actions">
            <button class="text-action" data-act="goal-edit" data-id="${esc(goal.id)}">${ICONS.edit} 编辑</button>
            ${goal.status === "completed" ? "" : `<button class="text-action" data-act="goal-pause" data-id="${esc(goal.id)}">${goal.status === "paused" ? ICONS.play : ICONS.pause} ${goal.status === "paused" ? "继续" : "暂停"}</button>`}
            <button class="text-action" data-act="goal-complete" data-id="${esc(goal.id)}">${goal.status === "completed" ? ICONS.repeat : ICONS.check} ${goal.status === "completed" ? targetDistance < 0 ? "延长并重新开启" : "重新开启" : "完成目标"}</button>
            <button class="text-action danger" data-act="goal-delete" data-id="${esc(goal.id)}">${ICONS.trash} 删除</button>
          </div>
        </div>
      </div>`;
  }

  return `<article class="todo-row goal-row ${goal.status === "completed" ? "done" : ""} ${expanded ? "expanded" : ""}" data-id="${esc(goal.id)}">
    <div class="todo-summary goal-summary">
      <div class="goal-progress ${completedToday || goalFinished ? "complete" : ""} ${goal.status}" style="--goal-progress:${progressRatio}" role="img" aria-label="${goalFinished ? "阶段目标已完成" : `今日 ${progress.total} 项行动中已完成 ${progress.completed} 项`}">
        ${completedToday || goalFinished ? ICONS.check : `<span>${progress.total ? progress.completed : "·"}</span>`}
      </div>
      <button class="todo-main" data-act="expand" data-id="${esc(goal.id)}" aria-expanded="${expanded}" aria-controls="${esc(detailsId)}">
        <span class="goal-title-line"><span class="todo-title">${esc(goal.title)}</span><span class="goal-tag">阶段目标</span></span>
        <span class="todo-meta goal-meta">
          <span class="meta-status goal-state ${goal.status}">${esc(statusText)}</span>
          <span class="meta-dot">·</span>
          <time class="meta-date" datetime="${esc(goal.targetDate)}">${esc(shortDateLabel(goal.targetDate))}</time>
          <span class="meta-dot goal-deadline-dot">·</span>
          <span class="meta-relative goal-relative ${targetDistance < 0 ? "overdue" : ""}" data-relative="${esc(goal.targetDate)}">${esc(targetRelative)}</span>
        </span>
      </button>
      <span class="chevron ${expanded ? "up" : ""}" data-act="expand" data-id="${esc(goal.id)}" aria-hidden="true">${ICONS.arrow}</span>
    </div>
    ${details}
  </article>`;
}

function getOverviewTodayActions(dateKey = toDateKey()) {
  const todoActions = state.items
    .filter((item) => {
      if (isRecurringTodo(item)) return todoOccursOnDate(item, dateKey);
      const distance = dayDistance(item.dueDate);
      if (!Number.isFinite(distance) || distance > 0) return false;
      return !item.completed || item.dueDate === dateKey;
    })
    .map((item) => ({
      kind: "todo",
      id: item.id,
      title: item.title,
      context: isRecurringTodo(item)
        ? todoScheduleLabel(item)
        : item.dueDate === dateKey ? "普通待办" : compactRelativeLabel(item.dueDate),
      dateKey: isRecurringTodo(item) ? dateKey : item.dueDate,
      startTime: item.dueTime || "",
      endTime: item.dueEndTime || "",
      completed: todoCompletedForDate(item, dateKey),
      recurring: isRecurringTodo(item),
      createdAt: item.createdAt || 0,
    }));
  const routineActions = getTodayGoalActions(dateKey).map(({ goal, routine, completed }) => ({
    kind: "routine",
    id: goal.id,
    routineId: routine.id,
    title: routine.title,
    context: goal.title,
    dateKey,
    startTime: routine.time || "",
    endTime: routine.endTime || "",
    completed,
    createdAt: goal.createdAt || 0,
  }));

  return [...todoActions, ...routineActions].sort((a, b) => {
    if (a.completed !== b.completed) return a.completed ? 1 : -1;
    const aTimestamp = dueTimestamp({ dueDate: a.dateKey, dueTime: a.startTime });
    const bTimestamp = dueTimestamp({ dueDate: b.dateKey, dueTime: b.startTime });
    if (aTimestamp !== bTimestamp) return aTimestamp - bTimestamp;
    return a.createdAt - b.createdAt;
  });
}

function overviewActionRowHtml(action) {
  const isTodo = action.kind === "todo";
  const toggleAct = isTodo ? "toggle" : "goal-routine-toggle";
  const revealAct = isTodo ? "todo-reveal" : "goal-reveal";
  const timeLabel = timeRangeLabel(action.startTime, action.endTime, "");
  const overdue = isTodo && !action.recurring && dayDistance(action.dateKey) < 0;
  return `<li class="overview-action ${action.completed ? "done" : ""} ${overdue ? "overdue" : ""}">
    <button class="overview-check ${action.completed ? "on" : ""}" data-act="${toggleAct}" data-id="${esc(action.id)}" ${isTodo ? "" : `data-routine-id="${esc(action.routineId)}" data-focus-scope="overview"`} role="checkbox" aria-checked="${action.completed}" aria-label="${action.completed ? "恢复" : "完成"}${esc(action.title)}">${action.completed ? ICONS.check : ""}</button>
    <button class="overview-action-main" data-act="${revealAct}" data-id="${esc(action.id)}" aria-label="查看${esc(action.title)}详情">
      <span class="overview-action-title">${esc(action.title)}</span>
      <span class="overview-action-context ${overdue ? "overdue" : ""}">${esc(action.context)}</span>
    </button>
    ${timeLabel ? `<time class="overview-action-time" datetime="${esc(action.dateKey)}T${esc(action.startTime)}" aria-label="${esc(timeRangeAriaLabel(action.startTime, action.endTime))}">${esc(timeLabel)}</time>` : ""}
  </li>`;
}

function overviewTodayHtml(actions) {
  const completed = actions.filter((action) => action.completed).length;
  const pending = actions.filter((action) => !action.completed);
  const visible = pending.slice(0, 5);
  const hiddenCount = Math.max(0, pending.length - visible.length);
  const density = pending.length <= 2 ? "comfortable" : pending.length === 3 ? "balanced" : "dense";
  return `<section class="overview-card overview-today ${density}" aria-labelledby="overview-today-title">
    <div class="overview-section-head">
      <div><h2 id="overview-today-title">今日行动</h2><p>${pending.length ? "今天真正需要推进的事" : completed ? `今天已完成 ${completed} 项` : "让今天保持一点余白"}</p></div>
      ${actions.length ? `<button class="overview-count" data-act="open-today-sheet" aria-label="查看全部今日行动">${completed}/${actions.length}${ICONS.arrow}</button>` : ""}
    </div>
    ${pending.length
      ? `<ul class="overview-action-list">${visible.map(overviewActionRowHtml).join("")}</ul>
         ${hiddenCount ? `<button class="overview-more" data-act="open-today-sheet">另外 ${hiddenCount} 项今日行动 ${ICONS.arrow}</button>` : ""}`
      : completed
        ? `<button class="overview-completed-summary" data-act="open-today-sheet"><span class="overview-empty-check">${ICONS.check}</span><span><strong>今日行动已完成</strong><small>${completed} 项已收起，点击查看</small></span>${ICONS.arrow}</button>`
      : `<button class="overview-empty-action" data-act="new-menu"><span class="overview-empty-check">${ICONS.check}</span><span><strong>今天没有待完成事项</strong><small>需要时，点一下添加</small></span>${ICONS.plus}</button>`}
  </section>`;
}

function overviewEntryButtonHtml(entry, className = "") {
  return `<button class="${className}" data-act="horizon-reveal" data-kind="${esc(entry.kind)}" data-id="${esc(entry.id)}" aria-label="查看${esc(entry.title)}，${esc(shortDateLabel(entry.dateKey))}，${esc(compactRelativeLabel(entry.dateKey))}">`;
}

function horizonBucketEntryHtml(entry) {
  return `${overviewEntryButtonHtml(entry, `horizon-entry ${entry.kind}`)}
    <span class="horizon-entry-title">${esc(entry.title)}</span>
    <small><time datetime="${esc(entry.dateKey)}">${esc(horizonDateLabel(entry.dateKey))}</time><span>${esc(horizonDistanceLabel(entry.dateKey))}</span></small>
  </button>`;
}

function horizonBucketHtml(key, label, entries, allEntries = entries) {
  if (!entries.length && !allEntries.length) {
    return `<div class="horizon-band empty"><span class="horizon-band-label">${label}</span><span class="horizon-band-empty">暂无安排</span></div>`;
  }
  if (!entries.length) {
    return `<button class="horizon-band nearest-only" data-act="open-horizon-bucket" data-bucket="${esc(key)}" aria-label="查看${label}的 ${allEntries.length} 个节点"><span class="horizon-band-label">${label}</span>
      <span class="horizon-band-copy"><strong>${allEntries.length} 个节点</strong><small>最近节点已在上方显示</small></span><span class="horizon-band-arrow">${ICONS.arrow}</span></button>`;
  }
  const visible = entries.slice(0, 3);
  return `<div class="horizon-band has-entries">
    <div class="horizon-band-heading"><span class="horizon-band-label">${label}</span><button class="horizon-band-total" data-act="open-horizon-bucket" data-bucket="${esc(key)}" aria-label="查看${label}全部 ${allEntries.length} 个节点">共${allEntries.length}${ICONS.arrow}</button></div>
    <div class="horizon-entry-list">${visible.map(horizonBucketEntryHtml).join("")}</div>
  </div>`;
}

function horizonOverviewHtml(futureEntries, buckets, allBuckets) {
  const nearest = futureEntries[0];
  return `<section class="overview-card nearest-card" aria-labelledby="nearest-title">
      <div class="overview-section-kicker" id="nearest-title">最近节点</div>
      ${nearest
        ? `${overviewEntryButtonHtml(nearest, `nearest-node ${nearest.kind}`)}
            <span class="nearest-icon">${nearest.kind === "goal" ? ICONS.target : ICONS.calendar}</span>
            <span class="nearest-copy"><small>${nearest.kind === "goal" ? "阶段目标" : "重要节点"}</small><strong>${esc(nearest.title)}</strong><span><time datetime="${esc(nearest.dateKey)}">${esc(shortDateLabel(nearest.dateKey))}</time> · ${esc(compactRelativeLabel(nearest.dateKey))}</span></span>
            <span class="nearest-arrow">${ICONS.arrow}</span></button>`
        : `<button class="nearest-node empty" data-act="new-menu"><span class="nearest-icon">${ICONS.calendar}</span><span class="nearest-copy"><strong>还没有未来节点</strong><span>添加考试、比赛或截止日期</span></span>${ICONS.plus}</button>`}
    </section>
    <section class="overview-card horizon-card" aria-labelledby="horizon-title">
      <div class="overview-section-head compact-head"><div><h2 id="horizon-title">时间地平线</h2><p>${futureEntries.length ? `${futureEntries.length} 个未来节点` : "未来安排会在这里展开"}</p></div></div>
      <div class="horizon-bands">
        ${horizonBucketHtml("within30Days", "30天内", buckets.within30Days, allBuckets.within30Days)}
        ${horizonBucketHtml("within90Days", "31–90天", buckets.within90Days, allBuckets.within90Days)}
        ${horizonBucketHtml("beyond90Days", "90天后", buckets.beyond90Days, allBuckets.beyond90Days)}
      </div>
    </section>`;
}

function overviewGoalsHtml(todayActionCount, horizonDensity = 1) {
  const goals = (state.goals || [])
    .filter((goal) => goal.status !== "completed")
    .sort((a, b) => {
      const aDistance = dayDistance(a.targetDate);
      const bDistance = dayDistance(b.targetDate);
      if (Number.isFinite(aDistance) !== Number.isFinite(bDistance)) return Number.isFinite(aDistance) ? -1 : 1;
      if (Number.isFinite(aDistance) && aDistance !== bDistance) return aDistance - bDistance;
      if (a.status !== b.status) return a.status === "active" ? -1 : 1;
      return (a.createdAt || 0) - (b.createdAt || 0);
    });
  const narrowVisibleLimit = todayActionCount >= 4
    ? (horizonDensity >= 2 ? 1 : 2)
    : (horizonDensity >= 2 ? 2 : 3);
  const visibleLimit = overviewWidthTier === 2
    ? 6
    : overviewWidthTier === 1
      ? 4
      : narrowVisibleLimit;
  const visibleGoals = goals.slice(0, visibleLimit);
  const hiddenCount = Math.max(0, goals.length - visibleGoals.length);
  return `<section class="overview-card overview-goals ${horizonDensity >= 2 ? "horizon-dense" : ""}" aria-labelledby="overview-goals-title">
    <div class="overview-section-head compact-head">
      <div><h2 id="overview-goals-title">阶段目标</h2><p>${goals.length ? "用今天的行动靠近目标" : "为长期计划建立节奏"}</p></div>
      ${goals.length ? `<button class="overview-count" data-act="view-list" aria-label="在完整清单中查看全部阶段目标">${goals.length} 个${ICONS.arrow}</button>` : ""}
    </div>
    ${visibleGoals.length ? `<div class="overview-goal-list">${visibleGoals.map((goal) => {
      const today = goalDailyProgress(goal);
      const week = goalWeekStats(goal, new Date());
      const overdue = dayDistance(goal.targetDate) < 0;
      const validTargetDate = !!fromDateKey(goal.targetDate);
      const targetMeta = validTargetDate
        ? `${shortDateLabel(goal.targetDate)} · ${compactRelativeLabel(goal.targetDate)}`
        : "未设置目标日期 · 去补充";
      return `<button class="overview-goal ${goal.status} ${overdue ? "overdue" : ""}" data-act="goal-reveal" data-id="${esc(goal.id)}">
        <span class="overview-goal-mark">${goal.status === "paused" ? ICONS.pause : ICONS.target}</span>
        <span class="overview-goal-copy"><strong>${esc(goal.title)}</strong><small>${validTargetDate ? `<time datetime="${esc(goal.targetDate)}">${esc(targetMeta)}</time>` : esc(targetMeta)}</small></span>
        <span class="overview-goal-stats">${today.total ? `<b>今日 ${today.completed}/${today.total}</b>` : ""}${week.total ? `<small>本周 ${week.completed}/${week.total}</small>` : `<small>${goal.status === "paused" ? "已暂停" : "今日无计划"}</small>`}</span>
        <span class="overview-goal-arrow">${ICONS.arrow}</span>
      </button>`;
    }).join("")}</div>` : `<button class="overview-goal-empty" data-act="new-menu"><span>${ICONS.target}</span><strong>建立一个阶段目标</strong><small>把考试或比赛拆成每天能做的行动</small></button>`}
    ${hiddenCount ? `<button class="overview-more goal-more" data-act="view-list">另外 ${hiddenCount} 个目标，在完整清单中查看 ${ICONS.arrow}</button>` : ""}
  </section>`;
}

function overviewDockHtml(view) {
  return `<footer class="overview-dock" aria-label="主导航">
    <button class="dock-tab ${view === "overview" ? "active" : ""}" data-act="view-overview" aria-current="${view === "overview" ? "page" : "false"}">${ICONS.overview}<span>全景</span></button>
    <button class="dock-add" data-act="new-menu" aria-label="新建">${ICONS.plus}</button>
    <button class="dock-tab ${view === "list" ? "active" : ""}" data-act="view-list" aria-current="${view === "list" ? "page" : "false"}">${ICONS.list}<span>清单</span></button>
  </footer>`;
}

function applyAppearance() {
  const root = document.documentElement;
  root.dataset.theme = state.settings.appearance;
  root.style.setProperty("--opacity", state.settings.opacity);
  if (state.settings.customBg) {
    root.style.setProperty("--panel-top", state.settings.customBg);
    root.style.setProperty("--panel-bottom", state.settings.customBg);
  } else {
    root.style.removeProperty("--panel-top");
    root.style.removeProperty("--panel-bottom");
  }
  const alwaysOnTop = !!state.settings.alwaysOnTop;
  if (appWindow && alwaysOnTop !== appliedAlwaysOnTop) {
    appliedAlwaysOnTop = alwaysOnTop;
    appWindow.setAlwaysOnTop(alwaysOnTop).catch(() => {
      if (appliedAlwaysOnTop === alwaysOnTop) appliedAlwaysOnTop = undefined;
    });
  }
  const clickThrough = !!state.settings.clickThrough;
  if (appWindow && clickThrough !== appliedClickThrough) {
    appliedClickThrough = clickThrough;
    appWindow.setIgnoreCursorEvents(clickThrough).catch(() => {
      if (appliedClickThrough === clickThrough) appliedClickThrough = undefined;
    });
  }
}

function scheduleAppearanceUpdate() {
  if (appearanceFrame !== null) return;
  appearanceFrame = requestAnimationFrame(() => {
    appearanceFrame = null;
    applyAppearance();
  });
}

function flushAppearanceUpdate() {
  if (appearanceFrame !== null) {
    cancelAnimationFrame(appearanceFrame);
    appearanceFrame = null;
  }
  applyAppearance();
}

function render() {
  const previousMain = app.querySelector(".main-scroll");
  const previousView = previousMain?.dataset.mainView;
  if (previousMain && previousView) viewScrollTop[previousView] = previousMain.scrollTop;
  const activeControl = document.activeElement?.closest?.("[data-act]");
  const activeKey = activeControl
    ? {
        act: activeControl.dataset.act,
        id: activeControl.dataset.id || "",
        subtaskId: activeControl.dataset.subtaskId || "",
        routineId: activeControl.dataset.routineId || "",
        focusScope: activeControl.dataset.focusScope || "",
      }
    : null;
  applyAppearance();
  const renderedView = compact ? "list" : activeMainView;
  const overview = renderedView === "overview";
  const allEntries = overview ? [] : getTimelineEntries();
  const completedView = overview
    ? { entries: [], completedCount: 0, hiddenCount: 0 }
    : limitCompletedEntries(allEntries);
  const entries = completedView.entries;
  const todayActions = overview ? getOverviewTodayActions() : [];
  const futureEntries = overview
    ? buildFutureHorizonEntries(state.items.filter((item) => !isRecurringTodo(item)), state.goals || [])
    : [];
  const allHorizonBuckets = overview ? bucketFutureHorizonEntries(futureEntries) : null;
  const nearestFuture = futureEntries[0];
  const horizonBuckets = allHorizonBuckets
    ? Object.fromEntries(Object.entries(allHorizonBuckets).map(([key, entries]) => [
        key,
        nearestFuture
          ? entries.filter((entry) => !(entry.kind === nearestFuture.kind && entry.id === nearestFuture.id))
          : entries,
      ]))
    : null;
  const horizonDensity = horizonBuckets
    ? Math.max(0, ...Object.values(horizonBuckets).map((bucket) => Math.min(3, bucket.length)))
    : 0;
  const pendingToday = todayActions.filter((action) => !action.completed).length;
  const subtitle = overview
    ? `${todayHeaderLabel()} · 今天 ${pendingToday} 项 · 未来 ${futureEntries.length} 个节点`
    : `${todayHeaderLabel()} · ${headerStatusSummary()}`;
  const mainContent = overview
    ? `${overviewTodayHtml(todayActions)}
      ${horizonOverviewHtml(futureEntries, horizonBuckets, allHorizonBuckets)}
      ${overviewGoalsHtml(pendingToday, horizonDensity)}`
    : `${todayGoalActionsHtml()}
      ${allEntries.length
        ? entries.map((entry) => entry.kind === "goal" ? goalRowHtml(entry.value) : rowHtml(entry.value)).join("")
        : `<div class="empty-state">${ICONS.empty}<strong>当前没有待办</strong><span>写下下一件重要的事吧</span></div>`}
      ${completedView.hiddenCount
        ? `<button class="completed-overflow" data-act="completed-overflow">${showAllCompleted ? "收起较早完成项" : `显示更早已完成 · ${completedView.hiddenCount}`}</button>`
        : ""}`;

  const animateView = renderedView !== lastRenderedMainView;
  app.innerHTML = `
    <header class="header ${overview ? "horizon-header" : "list-header"}" data-drag-region>
      ${overview ? "" : `<div class="app-symbol">${ICONS.reminders}</div>`}
      <div class="titles"><h1>${overview ? "时间地平线" : "完整清单"}</h1><p aria-live="polite">${esc(subtitle)}</p></div>
      <div class="spacer"></div>
      <button class="icon-btn" data-act="settings" title="设置" aria-label="设置">${ICONS.gear}</button>
    </header>

    <main class="${overview ? `overview-screen ${pendingToday >= 3 ? "many-today" : ""}` : "timeline"} main-scroll ${animateView ? "motion-view-enter" : ""}" data-main-view="${renderedView}">${mainContent}</main>
    ${compact ? "" : overviewDockHtml(renderedView)}
    ${compact ? '<button class="compact-open" data-act="grow">展开</button>' : ""}
    <div class="sr-only" role="status" aria-live="polite" aria-atomic="true">${esc(statusAnnouncement)}</div>
  `;
  lastRenderedMainView = renderedView;

  const main = app.querySelector(".main-scroll");
  if (main) main.scrollTop = viewScrollTop[renderedView] || 0;
  if (activeKey) {
    const restored = [...app.querySelectorAll(`[data-act="${activeKey.act}"]`)]
      .find((element) =>
        (element.dataset.id || "") === activeKey.id &&
        (element.dataset.subtaskId || "") === activeKey.subtaskId &&
        (element.dataset.routineId || "") === activeKey.routineId &&
        (element.dataset.focusScope || "") === activeKey.focusScope
      );
    restored?.focus({ preventScroll: true });
  }
  playPendingMotionCue();
  statusAnnouncement = "";
}

app.addEventListener("mousedown", (event) => {
  if (event.target.closest(".header") && !event.target.closest("button")) {
    appWindow?.startDragging().catch(() => {});
  }
});

function addTodo(data) {
  const title = data.title.trim();
  if (!title || !data.dueDate) return false;
  const schedule = ["once", "daily", "weekdays", "custom"].includes(data.schedule)
    ? data.schedule
    : "once";
  const item = {
    id: uid(),
    title,
    detail: (data.detail || "").trim(),
    subtasks: (data.subtasks || []).map((subtask) => ({
      id: subtask.id || uid(),
      title: subtask.title.trim(),
      completed: !!subtask.completed,
    })).filter((subtask) => subtask.title),
    dueDate: data.dueDate,
    dueTime: data.dueTime || "",
    dueEndTime: data.dueEndTime || "",
    schedule,
    weekdays: schedule === "custom"
      ? [...new Set(data.weekdays || [])]
          .filter((day) => Number.isInteger(day) && day >= 0 && day <= 6)
          .sort((a, b) => a - b)
      : [],
    records: {},
    notifiedRecords: {},
    completed: false,
    completedAt: null,
    notified: false,
    createdAt: Date.now(),
  };
  state.items.push(item);
  if (!save()) {
    state.items = state.items.filter((entry) => entry !== item);
    return false;
  }
  return true;
}

function toggleTodo(id) {
  if (!state.items.some((todo) => todo.id === id)) return;
  const dateKey = toDateKey();
  const target = state.items.find((todo) => todo.id === id);
  if (isRecurringTodo(target) && !todoOccursOnDate(target, dateKey)) return;
  const persisted = persistMutation(() => {
    const item = state.items.find((todo) => todo.id === id);
    if (isRecurringTodo(item)) {
      const previousRecords = item.records;
      const previousNotifiedRecords = item.notifiedRecords;
      const previousRecord = todoRecordForDate(item, dateKey) || {};
      const nextCompleted = previousRecord.completed !== true;
      const subtaskRecords = { ...(previousRecord.subtasks || {}) };
      if (nextCompleted) {
        item.subtasks?.forEach((subtask) => { subtaskRecords[subtask.id] = true; });
      }
      item.records = {
        ...(previousRecords || {}),
        [dateKey]: {
          ...previousRecord,
          completed: nextCompleted,
          completedAt: nextCompleted ? Date.now() : null,
          subtasks: subtaskRecords,
        },
      };
      if (previousRecord.completed === true && !nextCompleted && previousNotifiedRecords?.[dateKey]) {
        item.notifiedRecords = { ...previousNotifiedRecords };
        delete item.notifiedRecords[dateKey];
      }
      return () => {
        item.records = previousRecords;
        item.notifiedRecords = previousNotifiedRecords;
      };
    }
    const previous = {
      completed: item.completed,
      completedAt: item.completedAt,
      notified: item.notified,
      subtasks: item.subtasks?.map((subtask) => subtask.completed),
    };
    item.completed = !item.completed;
    if (item.completed) item.subtasks?.forEach((subtask) => { subtask.completed = true; });
    item.completedAt = item.completed ? Date.now() : null;
    if (!item.completed) item.notified = false;
    return () => {
      item.completed = previous.completed;
      item.completedAt = previous.completedAt;
      item.notified = previous.notified;
      item.subtasks?.forEach((subtask, index) => {
        subtask.completed = previous.subtasks[index];
      });
      };
  });
  if (persisted) queueMotionCue("state", id);
  render();
}

function toggleExpanded(id) {
  const opening = !state.expandedIds.includes(id);
  state.expandedIds = opening
    ? [...state.expandedIds, id]
    : state.expandedIds.filter((value) => value !== id);
  scheduleStateSave();
  if (opening) queueMotionCue("expand", id);
  render();
}

function toggleSubtask(itemId, subtaskId) {
  const exists = state.items
    .find((todo) => todo.id === itemId)
    ?.subtasks?.some((entry) => entry.id === subtaskId);
  if (!exists) return;
  const dateKey = toDateKey();
  const target = state.items.find((todo) => todo.id === itemId);
  if (isRecurringTodo(target) && !todoOccursOnDate(target, dateKey)) return;
  const persisted = persistMutation(() => {
    const item = state.items.find((todo) => todo.id === itemId);
    const subtask = item.subtasks.find((entry) => entry.id === subtaskId);
    if (isRecurringTodo(item)) {
      const previousRecords = item.records;
      const previousNotifiedRecords = item.notifiedRecords;
      const previousRecord = todoRecordForDate(item, dateKey) || {};
      const subtaskRecords = { ...(previousRecord.subtasks || {}) };
      const nextCompleted = subtaskRecords[subtaskId] !== true;
      if (nextCompleted) subtaskRecords[subtaskId] = true;
      else delete subtaskRecords[subtaskId];
      item.records = {
        ...(previousRecords || {}),
        [dateKey]: {
          ...previousRecord,
          completed: previousRecord.completed === true && nextCompleted,
          completedAt: previousRecord.completed === true && nextCompleted
            ? previousRecord.completedAt || Date.now()
            : null,
          subtasks: subtaskRecords,
        },
      };
      if (previousRecord.completed === true && !nextCompleted && previousNotifiedRecords?.[dateKey]) {
        item.notifiedRecords = { ...previousNotifiedRecords };
        delete item.notifiedRecords[dateKey];
      }
      return () => {
        item.records = previousRecords;
        item.notifiedRecords = previousNotifiedRecords;
      };
    }
    const previous = {
      subtaskCompleted: subtask.completed,
      itemCompleted: item.completed,
      completedAt: item.completedAt,
      notified: item.notified,
    };
    subtask.completed = !subtask.completed;
    if (item.completed && !subtask.completed) {
      item.completed = false;
      item.completedAt = null;
      item.notified = false;
    }
    return () => {
      subtask.completed = previous.subtaskCompleted;
      item.completed = previous.itemCompleted;
      item.completedAt = previous.completedAt;
      item.notified = previous.notified;
    };
  });
  if (persisted) queueMotionCue("state", itemId, "", subtaskId);
  render();
}

function toggleGoalRoutine(goalId, routineId) {
  const goal = (state.goals || []).find((entry) => entry.id === goalId);
  if (!goal || goal.status !== "active") return;
  const dateKey = toDateKey();
  const routine = routinesForDate(goal, dateKey).find((entry) => entry.id === routineId);
  if (!routine) return;
  const persisted = persistMutation(() => {
    const currentGoal = state.goals.find((entry) => entry.id === goalId);
    const previousRecords = currentGoal.records;
    currentGoal.records = { ...(previousRecords || {}) };
    currentGoal.records[dateKey] = { ...(previousRecords?.[dateKey] || {}) };
    if (currentGoal.records[dateKey][routineId]) delete currentGoal.records[dateKey][routineId];
    else currentGoal.records[dateKey][routineId] = true;
    if (!Object.keys(currentGoal.records[dateKey]).length) delete currentGoal.records[dateKey];
    const progress = goalDailyProgress(currentGoal, dateKey);
    statusAnnouncement = progress.completed === progress.total && progress.total
      ? `${currentGoal.title}的今日计划已全部完成`
      : `${currentGoal.title}今日已完成 ${progress.completed}/${progress.total}`;
    return () => { currentGoal.records = previousRecords; };
  });
  if (persisted) queueMotionCue("state", goalId, routineId);
  render();
}

function closeOpenPausePeriod(goal, resumeDate) {
  const openIndex = (goal.pausePeriods || []).findLastIndex((period) => !period.endDate);
  if (openIndex < 0) return;
  const endDate = addDays(resumeDate, -1);
  if (endDate < goal.pausePeriods[openIndex].startDate) goal.pausePeriods.splice(openIndex, 1);
  else goal.pausePeriods[openIndex].endDate = endDate;
}

function toggleGoalPause(id) {
  const goal = (state.goals || []).find((entry) => entry.id === id);
  if (!goal || goal.status === "completed") return;
  const dateKey = toDateKey();
  const persisted = persistMutation(() => {
    const currentGoal = state.goals.find((entry) => entry.id === id);
    const previousStatus = currentGoal.status;
    const previousPausePeriods = currentGoal.pausePeriods;
    currentGoal.pausePeriods = (previousPausePeriods || []).map((period) => ({ ...period }));
    if (currentGoal.status === "paused") {
      currentGoal.status = "active";
      closeOpenPausePeriod(currentGoal, dateKey);
    } else {
      currentGoal.status = "paused";
      currentGoal.pausePeriods.push({ startDate: dateKey, endDate: "" });
    }
    statusAnnouncement = `${currentGoal.title}${currentGoal.status === "paused" ? "已暂停" : "已继续"}`;
    return () => {
      currentGoal.status = previousStatus;
      currentGoal.pausePeriods = previousPausePeriods;
    };
  });
  if (persisted) queueMotionCue("state", id);
  render();
}

function toggleGoalComplete(id) {
  const goal = (state.goals || []).find((entry) => entry.id === id);
  if (!goal) return;
  const reopening = goal.status === "completed";
  if (reopening && dayDistance(goal.targetDate) < 0) {
    openGoalEditor(id, { reopenOnSave: true });
    return;
  }
  const persisted = persistMutation(() => {
    const currentGoal = state.goals.find((entry) => entry.id === id);
    const previousStatus = currentGoal.status;
    const previousCompletedAt = currentGoal.completedAt;
    const previousPausePeriods = currentGoal.pausePeriods;
    currentGoal.pausePeriods = (previousPausePeriods || []).map((period) => ({ ...period }));
    if (!reopening && currentGoal.status === "paused") {
      const openPeriod = (currentGoal.pausePeriods || []).findLast((period) => !period.endDate);
      if (openPeriod) openPeriod.endDate = toDateKey();
    }
    currentGoal.status = reopening ? "active" : "completed";
    currentGoal.completedAt = reopening ? null : Date.now();
    if (reopening) closeOpenPausePeriod(currentGoal, toDateKey());
    else currentGoal.pausePeriods.push({ startDate: addDays(toDateKey(), 1), endDate: "" });
    statusAnnouncement = `${currentGoal.title}${reopening ? "已重新开启" : "已完成"}`;
    return () => {
      currentGoal.status = previousStatus;
      currentGoal.completedAt = previousCompletedAt;
      currentGoal.pausePeriods = previousPausePeriods;
    };
  });
  if (persisted) queueMotionCue("state", id);
  render();
}

function switchMainView(view) {
  if (!['overview', 'list'].includes(view) || activeMainView === view) return;
  activeMainView = view;
  viewScrollTop[view] = 0;
  render();
}

function trapOverlayFocus(overlay, event) {
  if (event.key !== "Tab") return;
  const focusable = [...overlay.querySelectorAll('button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')]
    .filter((element) => element.getClientRects().length > 0);
  if (!focusable.length) return;
  const first = focusable[0];
  const last = focusable.at(-1);
  if (event.shiftKey && (document.activeElement === first || !overlay.contains(document.activeElement))) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && (document.activeElement === last || !overlay.contains(document.activeElement))) {
    event.preventDefault();
    first.focus();
  }
}

async function revealTodo(id) {
  if (!state.items.some((item) => item.id === id)) return;
  activeMainView = "list";
  if (!state.expandedIds.includes(id)) state.expandedIds.push(id);
  if (compact) await expandWindow();
  scheduleStateSave();
  render();
  requestAnimationFrame(() => {
    const card = [...app.querySelectorAll(".todo-row:not(.goal-row)")]
      .find((element) => element.dataset.id === id);
    card?.scrollIntoView({ behavior: preferredScrollBehavior(), block: "nearest" });
    card?.querySelector('.todo-main[data-act="expand"]')?.focus({ preventScroll: true });
  });
}

async function revealGoal(id) {
  if (!(state.goals || []).some((goal) => goal.id === id)) return;
  activeMainView = "list";
  if (!state.expandedIds.includes(id)) state.expandedIds.push(id);
  if (compact) await expandWindow();
  scheduleStateSave();
  render();
  requestAnimationFrame(() => {
    const card = [...app.querySelectorAll(".goal-row")]
      .find((element) => element.dataset.id === id);
    card?.scrollIntoView({ behavior: preferredScrollBehavior(), block: "nearest" });
    card?.querySelector('.todo-main[data-act="expand"]')?.focus({ preventScroll: true });
  });
}

function openOverviewTodaySheet() {
  const actions = getOverviewTodayActions();
  const sheetDateKey = toDateKey();
  const returnFocus = captureFocusDescriptor();
  const overlay = document.createElement("div");
  overlay.className = "overlay overview-sheet-overlay";
  overlay.dataset.dateKey = sheetDateKey;
  overlay.innerHTML = `<section class="dialog overview-sheet-dialog" role="dialog" aria-modal="true" aria-labelledby="today-sheet-title">
    <div class="dialog-head"><div><h2 id="today-sheet-title">今日行动</h2><p>${actions.length ? `共 ${actions.length} 项，点击正文查看完整详情` : "今天没有待完成事项"}</p></div><button class="icon-btn" data-sheet-close aria-label="关闭">${ICONS.close}</button></div>
    ${actions.length ? `<ul class="overview-action-list sheet-action-list">${actions.map(overviewActionRowHtml).join("")}</ul>` : ""}
  </section>`;
  document.body.appendChild(overlay);
  const close = (restoreFocus = true) => {
    dismissOverlay(overlay, restoreFocus ? () => restoreFocusDescriptor(returnFocus) : null);
  };
  overlay.addEventListener("click", async (event) => {
    if (event.target === overlay || event.target.closest("[data-sheet-close]")) return close();
    if (overlay.dataset.dateKey !== toDateKey()) {
      close();
      updateRelativeLabels();
      return;
    }
    const target = event.target.closest("[data-act]");
    if (!target) return;
    const { act, id, routineId } = target.dataset;
    if (act === "toggle" || act === "goal-routine-toggle") {
      if (act === "toggle") toggleTodo(id);
      else toggleGoalRoutine(id, routineId);
      const refreshedActions = getOverviewTodayActions();
      const list = overlay.querySelector(".sheet-action-list");
      if (list) {
        list.innerHTML = refreshedActions.length
          ? refreshedActions.map(overviewActionRowHtml).join("")
          : '<li class="sheet-empty-action">今天的行动已经全部处理完毕</li>';
      }
      const summary = overlay.querySelector(".dialog-head p");
      if (summary) summary.textContent = refreshedActions.length
        ? `共 ${refreshedActions.length} 项，点击正文查看完整详情`
        : "今天没有待完成事项";
      const restored = [...overlay.querySelectorAll(`[data-act="${act}"]`)]
        .find((button) => button.dataset.id === id && (button.dataset.routineId || "") === (routineId || ""));
      restored?.focus({ preventScroll: true });
      return;
    }
    close(false);
    if (act === "todo-reveal") await revealTodo(id);
    else if (act === "goal-reveal") await revealGoal(id);
  });
  overlay.addEventListener("keydown", (event) => {
    if (event.key === "Escape") close();
    else trapOverlayFocus(overlay, event);
  });
  overlay.querySelector("[data-sheet-close]")?.focus();
}

function openHorizonBucket(bucketKey) {
  const allEntries = buildFutureHorizonEntries(
    state.items.filter((item) => !isRecurringTodo(item)),
    state.goals || [],
  );
  const buckets = bucketFutureHorizonEntries(allEntries);
  const entries = buckets[bucketKey] || [];
  const labels = { within30Days: "30 天内", within90Days: "31–90 天", beyond90Days: "90 天后" };
  const returnFocus = captureFocusDescriptor();
  const overlay = document.createElement("div");
  overlay.className = "overlay overview-sheet-overlay";
  overlay.innerHTML = `<section class="dialog overview-sheet-dialog" role="dialog" aria-modal="true" aria-labelledby="horizon-sheet-title">
    <div class="dialog-head"><div><h2 id="horizon-sheet-title">${labels[bucketKey] || "未来节点"}</h2><p>${entries.length} 个节点，已按日期由近到远排列</p></div><button class="icon-btn" data-sheet-close aria-label="关闭">${ICONS.close}</button></div>
    <div class="horizon-sheet-list">${entries.map((entry) => `<button class="horizon-sheet-row ${entry.kind}" data-sheet-kind="${esc(entry.kind)}" data-sheet-id="${esc(entry.id)}">
      <span class="horizon-sheet-icon">${entry.kind === "goal" ? ICONS.target : ICONS.calendar}</span>
      <span><strong>${esc(entry.title)}</strong><small><time datetime="${esc(entry.dateKey)}">${esc(shortDateLabel(entry.dateKey))}</time> · ${esc(compactRelativeLabel(entry.dateKey))}</small></span>${ICONS.arrow}
    </button>`).join("")}</div>
  </section>`;
  document.body.appendChild(overlay);
  const close = (restoreFocus = true) => {
    dismissOverlay(overlay, restoreFocus ? () => restoreFocusDescriptor(returnFocus) : null);
  };
  overlay.addEventListener("click", async (event) => {
    if (event.target === overlay || event.target.closest("[data-sheet-close]")) return close();
    const row = event.target.closest("[data-sheet-kind]");
    if (!row) return;
    const { sheetKind, sheetId } = row.dataset;
    close(false);
    if (sheetKind === "goal") await revealGoal(sheetId);
    else await revealTodo(sheetId);
  });
  overlay.addEventListener("keydown", (event) => {
    if (event.key === "Escape") close();
    else trapOverlayFocus(overlay, event);
  });
  overlay.querySelector("[data-sheet-close]")?.focus();
}

function toggleTodayActions() {
  const dateKey = toDateKey();
  state.settings.todayActionsCollapsedDate =
    state.settings.todayActionsCollapsedDate === dateKey ? "" : dateKey;
  scheduleStateSave();
  render();
}

async function revealTodayActions() {
  state.settings.todayActionsCollapsedDate = "";
  if (compact) await expandWindow();
  scheduleStateSave();
  render();
  requestAnimationFrame(() => {
    const board = app.querySelector(".today-actions-board");
    board?.scrollIntoView({ behavior: preferredScrollBehavior(), block: "start" });
    board?.querySelector(".today-actions-head")?.focus({ preventScroll: true });
  });
}

function deleteGoal(id) {
  const goal = (state.goals || []).find((entry) => entry.id === id);
  if (!goal) return;
  const returnFocus = captureFocusDescriptor();
  const overlay = document.createElement("div");
  overlay.className = "overlay";
  overlay.innerHTML = `<section class="dialog confirm-dialog" role="alertdialog" aria-modal="true" aria-labelledby="confirm-goal-title" aria-describedby="confirm-goal-copy">
    <div class="confirm-icon">${ICONS.trash}</div>
    <h2 id="confirm-goal-title">删除“${esc(goal.title)}”？</h2>
    <p id="confirm-goal-copy">重复行动和全部历史完成记录都会一并删除，此操作无法撤销。</p>
    <div class="dialog-actions"><button class="secondary-btn" data-confirm-goal="cancel">取消</button><button class="danger-btn" data-confirm-goal="delete">删除目标</button></div>
  </section>`;
  document.body.appendChild(overlay);
  const close = () => {
    dismissOverlay(overlay, () => restoreFocusDescriptor(returnFocus));
  };
  overlay.addEventListener("click", (event) => {
    if (event.target === overlay || event.target.closest('[data-confirm-goal="cancel"]')) return close();
    if (!event.target.closest('[data-confirm-goal="delete"]')) return;
    if (!persistMutation(() => {
      const previousGoals = state.goals;
      const previousExpandedIds = state.expandedIds;
      state.goals = (state.goals || []).filter((entry) => entry.id !== id);
      state.expandedIds = state.expandedIds.filter((value) => value !== id);
      statusAnnouncement = `${goal.title}已删除`;
      return () => {
        state.goals = previousGoals;
        state.expandedIds = previousExpandedIds;
      };
    })) {
      showPersistenceError(overlay);
      return;
    }
    overlay.remove();
    render();
  });
  overlay.addEventListener("keydown", (event) => {
    if (event.key === "Escape") close();
  });
  overlay.querySelector('[data-confirm-goal="cancel"]')?.focus();
}

app.addEventListener("click", async (event) => {
  const link = event.target.closest("a[data-link]");
  if (link) {
    event.preventDefault();
    openExternal(link.dataset.link);
    return;
  }
  const target = event.target.closest("[data-act]");
  if (!target) return;
  if (lastRenderedDate !== toDateKey()) {
    updateRelativeLabels();
    return;
  }
  const id = target.dataset.id;
  switch (target.dataset.act) {
    case "toggle": toggleTodo(id); break;
    case "expand": toggleExpanded(id); break;
    case "subtask-toggle": toggleSubtask(id, target.dataset.subtaskId); break;
    case "goal-routine-toggle": toggleGoalRoutine(id, target.dataset.routineId); break;
    case "todo-reveal": await revealTodo(id); break;
    case "goal-reveal": await revealGoal(id); break;
    case "horizon-reveal": target.dataset.kind === "goal" ? await revealGoal(id) : await revealTodo(id); break;
    case "open-horizon-bucket": openHorizonBucket(target.dataset.bucket); break;
    case "open-today-sheet": openOverviewTodaySheet(); break;
    case "view-overview": switchMainView("overview"); break;
    case "view-list": switchMainView("list"); break;
    case "today-actions-toggle": toggleTodayActions(); break;
    case "today-actions-reveal": await revealTodayActions(); break;
    case "goal-pause": toggleGoalPause(id); break;
    case "goal-complete": toggleGoalComplete(id); break;
    case "goal-delete": deleteGoal(id); break;
    case "goal-edit": openGoalEditor(id); break;
    case "edit": openEditor(id); break;
    case "delete": deleteTodo(id); break;
    case "new-menu": openCreateMenu(); break;
    case "settings": openSettings(); break;
    case "completed-overflow": showAllCompleted = !showAllCompleted; render(); break;
    case "grow": if (await expandWindow()) render(); break;
  }
});

const WEEKDAY_OPTIONS = [
  { value: 1, label: "一" },
  { value: 2, label: "二" },
  { value: 3, label: "三" },
  { value: 4, label: "四" },
  { value: 5, label: "五" },
  { value: 6, label: "六" },
  { value: 0, label: "日" },
];

function routineScheduleControl(schedule, routineId) {
  const options = [
    ["daily", "每天"],
    ["weekdays", "工作日"],
    ["custom", "自定义"],
  ];
  return `<div class="routine-schedule-options" role="radiogroup" aria-label="重复日期">
    ${options.map(([value, label]) => `<label>
      <input type="radio" class="routine-schedule" name="routine-schedule-${esc(routineId)}" value="${value}" ${schedule === value ? "checked" : ""} />
      <span>${label}</span>
    </label>`).join("")}
  </div>`;
}

function readRoutineSchedule(row) {
  return row?.querySelector(".routine-schedule:checked")?.value || "daily";
}

function todoScheduleControl(schedule, itemId = "new") {
  const options = [
    ["once", "不重复"],
    ["daily", "每天"],
    ["weekdays", "工作日"],
    ["custom", "自定义"],
  ];
  return `<div class="todo-schedule-options" role="radiogroup" aria-label="重复日期">
    ${options.map(([value, label]) => `<label>
      <input type="radio" class="todo-schedule" name="todo-schedule-${esc(itemId)}" value="${value}" ${schedule === value ? "checked" : ""} />
      <span>${label}</span>
    </label>`).join("")}
  </div>`;
}

function readTodoSchedule(root) {
  return root?.querySelector(".todo-schedule:checked")?.value || "once";
}

function isRecurringTodo(item) {
  return !!item && ["daily", "weekdays", "custom"].includes(item.schedule);
}

function todoRecordForDate(item, dateKey = toDateKey()) {
  return isRecurringTodo(item) && item.records?.[dateKey] && typeof item.records[dateKey] === "object"
    ? item.records[dateKey]
    : null;
}

function todoCompletedForDate(item, dateKey = toDateKey()) {
  return isRecurringTodo(item)
    ? todoRecordForDate(item, dateKey)?.completed === true
    : item?.completed === true;
}

function todoSubtaskCompletedForDate(item, subtaskId, dateKey = toDateKey()) {
  return isRecurringTodo(item)
    ? todoRecordForDate(item, dateKey)?.subtasks?.[subtaskId] === true
    : item?.subtasks?.find((subtask) => subtask.id === subtaskId)?.completed === true;
}

function nextTodoOccurrence(item, dateKey = toDateKey()) {
  if (!isRecurringTodo(item)) return item?.dueDate || dateKey;
  let cursor = item.dueDate > dateKey ? item.dueDate : dateKey;
  for (let offset = 0; offset < 8; offset += 1) {
    if (todoOccursOnDate(item, cursor)) return cursor;
    cursor = addDays(cursor, 1);
  }
  return item.dueDate || dateKey;
}

function todoScheduleLabel(item) {
  if (!isRecurringTodo(item)) return "";
  if (item.schedule === "daily") return "每天";
  if (item.schedule === "weekdays") return "工作日";
  const labels = new Map(WEEKDAY_OPTIONS.map((day) => [day.value, day.label]));
  const selected = (item.weekdays || []).map((day) => labels.get(day)).filter(Boolean);
  return selected.length ? `每周${selected.join("、")}` : "自定义重复";
}

function openCreateMenu() {
  const returnFocus = captureFocusDescriptor();
  const overlay = document.createElement("div");
  overlay.className = "overlay create-overlay";
  overlay.innerHTML = `<section class="dialog create-dialog" role="dialog" aria-modal="true" aria-labelledby="create-title">
    <div class="dialog-head"><div><h2 id="create-title">新建</h2><p>选择最适合这件事的类型</p></div><button class="icon-btn" data-create="close" aria-label="关闭">${ICONS.close}</button></div>
    <div class="create-options">
      <button class="create-option todo-option" data-create="todo">
        <span class="create-option-icon">${ICONS.check}</span>
        <span><strong>待办或重要节点</strong><small>今天要做的事，或有日期的考试、比赛与截止</small></span>
        ${ICONS.arrow}
      </button>
      <button class="create-option goal-option" data-create="goal">
        <span class="create-option-icon">${ICONS.target}</span>
        <span><strong>阶段目标</strong><small>目标日期，以及每天、工作日或自定义星期的行动</small></span>
        ${ICONS.arrow}
      </button>
    </div>
  </section>`;
  document.body.appendChild(overlay);

  const close = (restoreFocus = true, animate = true) => {
    if (!animate) {
      overlay.remove();
      if (restoreFocus) restoreFocusDescriptor(returnFocus);
      return;
    }
    dismissOverlay(overlay, restoreFocus ? () => restoreFocusDescriptor(returnFocus) : null);
  };
  overlay.addEventListener("click", (event) => {
    if (event.target === overlay || event.target.closest('[data-create="close"]')) return close();
    const choice = event.target.closest("[data-create]")?.dataset.create;
    if (choice === "todo") {
      close(false, false);
      openEditor();
    } else if (choice === "goal") {
      close(false, false);
      openGoalEditor();
    }
  });
  overlay.addEventListener("keydown", (event) => {
    if (event.key === "Escape") close();
  });
  overlay.querySelector('[data-create="todo"]')?.focus();
}

function routineEditorRowHtml(routine = {}) {
  const routineId = routine.id || uid();
  const timeErrorId = `routine-time-error-${uid()}`;
  const timeMode = timeModeFor(routine.time, routine.endTime);
  const schedule = ["daily", "weekdays", "custom"].includes(routine.schedule)
    ? routine.schedule
    : "daily";
  const selectedDays = new Set(
    schedule === "custom" && Array.isArray(routine.weekdays) && routine.weekdays.length
      ? routine.weekdays
      : [1, 2, 3, 4, 5]
  );
  return `<div class="routine-editor-row" data-routine-row data-time-scope data-routine-id="${esc(routineId)}">
    <div class="routine-title-row">
      <span class="routine-accent" aria-hidden="true"></span>
      <input class="routine-title-input" maxlength="120" value="${esc(routine.title || "")}" placeholder="例如：背单词 30 分钟" aria-label="重复行动名称" />
      <button class="routine-remove" data-routine-remove aria-label="移除重复行动">${ICONS.close}</button>
    </div>
    <div class="routine-schedule-field">
      <span>重复日期</span>
      ${routineScheduleControl(schedule, routineId)}
    </div>
    <div class="weekday-picker-wrap ${schedule === "custom" ? "" : "hidden"}" data-weekday-picker>
      <span>选择每周执行日</span>
      <div class="weekday-picker" role="group" aria-label="选择每周执行日">
        ${WEEKDAY_OPTIONS.map((day) => `<button type="button" class="${selectedDays.has(day.value) ? "on" : ""}" data-weekday="${day.value}" aria-pressed="${selectedDays.has(day.value)}" aria-label="星期${day.label}">${day.label}</button>`).join("")}
      </div>
    </div>
    <div class="routine-config-row routine-time-config">
      <label><span>时间安排（可选）</span><select class="routine-time-mode" data-time-mode aria-label="时间安排">${timeModeOptions(timeMode)}</select></label>
    </div>
    <div class="routine-time-fields time-fields ${timeMode === "none" ? "hidden" : ""} ${timeMode === "point" ? "point" : ""}" data-time-fields>
      <label><span data-time-start-label>${timeMode === "range" ? "开始时间" : "时间点"}</span><input class="routine-time" data-time-start type="time" value="${esc(routine.time || "")}" ${timeMode === "none" ? "disabled" : ""} aria-describedby="${esc(timeErrorId)}" /></label>
      <label class="${timeMode === "range" ? "" : "hidden"}" data-time-end-field><span>结束时间</span><input class="routine-end-time" data-time-end type="time" value="${esc(routine.endTime || "")}" ${timeMode === "range" ? "" : "disabled"} aria-describedby="${esc(timeErrorId)}" /></label>
    </div>
    <p id="${esc(timeErrorId)}" class="time-editor-error hidden" data-time-error role="alert"></p>
  </div>`;
}

function removeRoutineReference(goal, collectionName, dateKey, routineId) {
  const collection = goal[collectionName];
  if (!collection?.[dateKey]) return;
  delete collection[dateKey][routineId];
  if (!Object.keys(collection[dateKey]).length) delete collection[dateKey];
}

function routineScheduleSignature(routine) {
  const weekdays = routine.schedule === "custom"
    ? [...(routine.weekdays || [])].sort((a, b) => a - b).join(",")
    : "";
  return `${routine.schedule}:${weekdays}`;
}

function mergeGoalRoutines(goal, drafts) {
  const today = toDateKey();
  const yesterday = addDays(today, -1);
  const original = goal.routines || [];
  const archived = original.filter((routine) => routine.endDate && routine.endDate < today);
  const current = original.filter((routine) => !routine.endDate || routine.endDate >= today);
  const draftById = new Map(drafts.map((routine) => [routine.id, routine]));
  const merged = [...archived];

  current.forEach((routine) => {
    const draft = draftById.get(routine.id);
    const startDate = routine.startDate || goal.startDate || today;
    if (!draft) {
      if (startDate < today) merged.push({ ...routine, endDate: yesterday });
      else {
        removeRoutineReference(goal, "records", today, routine.id);
        removeRoutineReference(goal, "notifiedRecords", today, routine.id);
      }
      return;
    }

    draftById.delete(routine.id);
    const scheduleChanged = routineScheduleSignature(routine) !== routineScheduleSignature(draft);
    const startTimeChanged = routine.time !== draft.time;
    const timeRangeChanged = startTimeChanged || (routine.endTime || "") !== (draft.endTime || "");
    if ((scheduleChanged || timeRangeChanged) && startDate < today) {
      merged.push({ ...routine, endDate: yesterday });
      const replacement = { ...draft, id: uid(), startDate: today, endDate: "" };
      const wasCompleted = goal.records?.[today]?.[routine.id] === true;
      const wasNotified = goal.notifiedRecords?.[today]?.[routine.id] === true;
      removeRoutineReference(goal, "records", today, routine.id);
      removeRoutineReference(goal, "notifiedRecords", today, routine.id);
      if (wasCompleted && routineOccursOnDate(replacement, today)) {
        goal.records ||= {};
        goal.records[today] ||= {};
        goal.records[today][replacement.id] = true;
      }
      if (wasNotified && !startTimeChanged && routineOccursOnDate(replacement, today)) {
        goal.notifiedRecords ||= {};
        goal.notifiedRecords[today] ||= {};
        goal.notifiedRecords[today][replacement.id] = true;
      }
      merged.push(replacement);
    } else {
      if (startTimeChanged) {
        removeRoutineReference(goal, "notifiedRecords", today, routine.id);
      }
      if (scheduleChanged) {
        if (!routineOccursOnDate(draft, today)) {
          removeRoutineReference(goal, "records", today, routine.id);
        }
      }
      merged.push({ ...routine, ...draft, startDate, endDate: "" });
    }
  });

  draftById.forEach((draft) => {
    merged.push({ ...draft, startDate: today, endDate: "" });
  });
  return merged;
}

function openGoalEditor(id = null, options = {}) {
  let goal = (state.goals || []).find((entry) => entry.id === id);
  const values = goal || {
    title: "",
    detail: "",
    targetDate: addDays(toDateKey(), 90),
    startDate: toDateKey(),
    routines: [],
  };
  const today = toDateKey();
  const editableRoutines = (values.routines || []).filter((routine) => !routine.endDate || routine.endDate >= today);
  const returnFocus = captureFocusDescriptor();
  const overlay = document.createElement("div");
  overlay.className = "overlay";
  overlay.innerHTML = `<section class="dialog goal-editor-dialog" role="dialog" aria-modal="true" aria-labelledby="goal-editor-title">
    <div class="dialog-head"><div><h2 id="goal-editor-title">${options.reopenOnSave ? "延长并重新开启" : goal ? "编辑阶段目标" : "新建阶段目标"}</h2><p>未来计划不会堆满列表，只显示今天要做的行动</p></div><button class="icon-btn" data-goal-dialog="close" aria-label="关闭">${ICONS.close}</button></div>
    <label class="field"><span>目标名称</span><input id="goal-title" maxlength="120" value="${esc(values.title)}" placeholder="例如：六级备考" required /></label>
    <label class="field"><span>目标日期</span><input id="goal-target-date" type="date" min="${esc(options.reopenOnSave ? today : values.startDate || today)}" value="${esc(values.targetDate)}" required /></label>
    <div class="routine-editor-block">
      <div class="routine-editor-head"><div><strong>重复行动</strong><span>每天只生成当天需要执行的内容</span></div><button data-routine-add>${ICONS.plus} 添加行动</button></div>
      <div id="routine-editor-list" class="routine-editor-list">
        ${editableRoutines.length
          ? editableRoutines.map(routineEditorRowHtml).join("")
          : '<div class="routine-editor-empty"><span>还没有行动计划</span><small>例如每天背单词、工作日刷题</small></div>'}
      </div>
    </div>
    <label class="field"><span>目标说明（可选）</span><textarea id="goal-detail" rows="3" placeholder="补充资料链接、备考范围或阶段说明…">${esc(values.detail)}</textarea></label>
    <div class="dialog-actions goal-dialog-actions"><button class="secondary-btn" data-goal-dialog="close">取消</button><button class="primary-btn" data-goal-dialog="save">${options.reopenOnSave ? "延长并重新开启" : goal ? "保存修改" : "创建目标"}</button></div>
  </section>`;
  document.body.appendChild(overlay);

  const close = () => {
    dismissOverlay(overlay, () => restoreFocusDescriptor(returnFocus));
  };
  const routineList = overlay.querySelector("#routine-editor-list");
  const addRoutine = () => {
    routineList.querySelector(".routine-editor-empty")?.remove();
    routineList.insertAdjacentHTML("beforeend", routineEditorRowHtml());
    routineList.querySelector(".routine-editor-row:last-child .routine-title-input")?.focus();
  };

  overlay.addEventListener("change", (event) => {
    const row = event.target.closest("[data-routine-row]");
    if (event.target.matches(".routine-schedule")) {
      const picker = row.querySelector("[data-weekday-picker]");
      picker.classList.toggle("hidden", readRoutineSchedule(row) !== "custom");
    } else if (event.target.matches("[data-time-mode]")) {
      syncTimeEditor(row);
    }
  });
  overlay.addEventListener("input", (event) => {
    if (event.target.matches("[data-time-start], [data-time-end]")) {
      const row = event.target.closest("[data-time-scope]");
      row.querySelector("[data-time-error]")?.classList.add("hidden");
      row.querySelectorAll("[data-time-start], [data-time-end]").forEach((input) => {
        input.removeAttribute("aria-invalid");
      });
    }
  });
  overlay.addEventListener("click", (event) => {
    if (event.target === overlay || event.target.closest('[data-goal-dialog="close"]')) return close();
    if (event.target.closest("[data-routine-add]")) return addRoutine();
    const removeButton = event.target.closest("[data-routine-remove]");
    if (removeButton) {
      removeButton.closest("[data-routine-row]")?.remove();
      if (!routineList.querySelector("[data-routine-row]")) {
        routineList.innerHTML = '<div class="routine-editor-empty"><span>还没有行动计划</span><small>例如每天背单词、工作日刷题</small></div>';
      }
      return;
    }
    const weekday = event.target.closest("[data-weekday]");
    if (weekday) {
      const selected = !weekday.classList.contains("on");
      weekday.classList.toggle("on", selected);
      weekday.setAttribute("aria-pressed", String(selected));
      return;
    }
    if (!event.target.closest('[data-goal-dialog="save"]')) return;

    const title = overlay.querySelector("#goal-title").value.trim();
    const targetDate = overlay.querySelector("#goal-target-date").value;
    const minimumTargetDate = options.reopenOnSave ? today : values.startDate || today;
    if (!title || !fromDateKey(targetDate) || targetDate < minimumTargetDate) {
      overlay.querySelector(!title ? "#goal-title" : "#goal-target-date").focus();
      overlay.querySelector(".dialog")?.classList.add("shake");
      setTimeout(() => overlay.querySelector(".dialog")?.classList.remove("shake"), 300);
      return;
    }

    const routineRows = [...overlay.querySelectorAll("[data-routine-row]")]
      .filter((row) => row.querySelector(".routine-title-input").value.trim());
    const invalidCustom = routineRows.find((row) =>
      readRoutineSchedule(row) === "custom" &&
      !row.querySelector("[data-weekday].on")
    );
    if (invalidCustom) {
      invalidCustom.querySelector("[data-weekday]")?.focus();
      invalidCustom.classList.add("shake");
      setTimeout(() => invalidCustom.classList.remove("shake"), 300);
      return;
    }
    const routineTimes = routineRows.map((row) => ({ row, result: readTimeEditor(row) }));
    const invalidTime = routineTimes.find(({ result }) => result.message);
    if (invalidTime) {
      showTimeEditorError(invalidTime.row, invalidTime.result);
      return;
    }
    const routines = routineTimes.map(({ row, result }) => ({
      id: row.dataset.routineId || uid(),
      title: row.querySelector(".routine-title-input").value.trim(),
      time: result.startTime,
      endTime: result.endTime,
      schedule: readRoutineSchedule(row),
      weekdays: [...row.querySelectorAll("[data-weekday].on")].map((button) => Number(button.dataset.weekday)),
    }));
    const next = {
      title,
      targetDate,
      detail: overlay.querySelector("#goal-detail").value.trim(),
    };
    const goalIndex = goal ? state.goals.findIndex((entry) => entry.id === goal.id) : -1;
    const previousGoal = goal ? cloneValue(goal) : null;
    const previousExpandedIds = [...state.expandedIds];
    let createdGoalId = "";
    if (goal) {
      const mergedRoutines = mergeGoalRoutines(goal, routines);
      Object.assign(goal, next, { routines: mergedRoutines });
      if (options.reopenOnSave) {
        goal.status = "active";
        goal.completedAt = null;
        closeOpenPausePeriod(goal, today);
        statusAnnouncement = `${goal.title}已重新开启`;
      }
      if (!state.expandedIds.includes(goal.id)) state.expandedIds.push(goal.id);
    } else {
      const newGoal = {
        id: uid(),
        ...next,
        startDate: today,
        status: "active",
        completedAt: null,
        routines: routines.map((routine) => ({ ...routine, startDate: today, endDate: "" })),
        records: {},
        notifiedRecords: {},
        pausePeriods: [],
        createdAt: Date.now(),
      };
      state.goals ||= [];
      state.goals.push(newGoal);
      state.expandedIds.push(newGoal.id);
      createdGoalId = newGoal.id;
    }
    if (!save()) {
      state.expandedIds = previousExpandedIds;
      if (goalIndex >= 0 && previousGoal) {
        state.goals[goalIndex] = previousGoal;
        goal = previousGoal;
      } else if (createdGoalId) {
        state.goals = state.goals.filter((entry) => entry.id !== createdGoalId);
      }
      showPersistenceError(overlay);
      return;
    }
    overlay.remove();
    render();
  });
  overlay.addEventListener("keydown", (event) => {
    if (event.key === "Escape") close();
    if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
      event.preventDefault();
      overlay.querySelector('[data-goal-dialog="save"]')?.click();
    } else if (event.key === "Enter" && event.target.matches(".routine-title-input")) {
      event.preventDefault();
      addRoutine();
    }
  });
  overlay.querySelector("#goal-title")?.focus();
}

function subtaskEditorRowHtml(subtask = {}) {
  const subtaskId = subtask.id || uid();
  return `<div class="subtask-editor-row" data-subtask-row data-subtask-id="${esc(subtaskId)}" data-completed="${!!subtask.completed}">
    <span class="subtask-editor-dot" aria-hidden="true"></span>
    <input class="subtask-editor-input" maxlength="120" value="${esc(subtask.title || "")}" placeholder="输入子待办" aria-label="子待办标题" />
    <button class="subtask-remove" data-subtask-remove aria-label="移除子待办">${ICONS.close}</button>
  </div>`;
}

function openEditor(id = null) {
  let item = state.items.find((todo) => todo.id === id);
  const values = item || {
    title: "",
    detail: "",
    subtasks: [],
    dueDate: toDateKey(),
    dueTime: "",
    dueEndTime: "",
    schedule: "once",
    weekdays: [],
  };
  const todoTimeMode = timeModeFor(values.dueTime, values.dueEndTime);
  const todoSchedule = ["once", "daily", "weekdays", "custom"].includes(values.schedule)
    ? values.schedule
    : "once";
  const selectedDays = new Set(
    todoSchedule === "custom" && Array.isArray(values.weekdays) && values.weekdays.length
      ? values.weekdays
      : [1, 2, 3, 4, 5]
  );
  const returnFocus = captureFocusDescriptor();
  const overlay = document.createElement("div");
  overlay.className = "overlay";
  overlay.innerHTML = `<section class="dialog editor-dialog" role="dialog" aria-modal="true" aria-labelledby="editor-title">
    <div class="dialog-head"><div><h2 id="editor-title">${item ? "编辑待办" : "新建待办"}</h2><p>安排日期与时间，列表会自动排序</p></div><button class="icon-btn" data-dialog="close" aria-label="关闭">${ICONS.close}</button></div>
    <label class="field"><span>待办标题</span><input id="edit-title" maxlength="120" value="${esc(values.title)}" placeholder="要完成什么？" required /></label>
    <div class="todo-schedule-field">
      <span>重复日期</span>
      ${todoScheduleControl(todoSchedule, values.id || "new")}
    </div>
    <div class="todo-weekday-picker ${todoSchedule === "custom" ? "" : "hidden"}" data-todo-weekday-picker>
      <span>选择每周执行日</span>
      <div class="weekday-picker" role="group" aria-label="选择每周执行日">
        ${WEEKDAY_OPTIONS.map((day) => `<button type="button" class="${selectedDays.has(day.value) ? "on" : ""}" data-todo-weekday="${day.value}" aria-pressed="${selectedDays.has(day.value)}" aria-label="星期${day.label}">${day.label}</button>`).join("")}
      </div>
    </div>
    <div class="todo-time-editor" data-time-scope>
      <div class="field-grid">
      <label class="field"><span data-todo-date-label>${todoSchedule === "once" ? "日期" : "开始日期"}</span><input id="edit-date" type="date" value="${esc(values.dueDate)}" required /></label>
      <label class="field"><span>时间安排</span><select id="edit-time-mode" data-time-mode>${timeModeOptions(todoTimeMode)}</select></label>
      </div>
      <div class="time-fields field-grid ${todoTimeMode === "none" ? "hidden" : ""} ${todoTimeMode === "point" ? "point" : ""}" data-time-fields>
        <label class="field"><span data-time-start-label>${todoTimeMode === "range" ? "开始时间" : "时间点"}</span><input id="edit-time" data-time-start type="time" value="${esc(values.dueTime || "")}" ${todoTimeMode === "none" ? "disabled" : ""} aria-describedby="todo-time-error" /></label>
        <label class="field ${todoTimeMode === "range" ? "" : "hidden"}" data-time-end-field><span>结束时间</span><input id="edit-end-time" data-time-end type="time" value="${esc(values.dueEndTime || "")}" ${todoTimeMode === "range" ? "" : "disabled"} aria-describedby="todo-time-error" /></label>
      </div>
      <p id="todo-time-error" class="time-editor-error hidden" data-time-error role="alert"></p>
    </div>
    <label class="field"><span>更多细节（可选）</span><textarea id="edit-detail" rows="5" placeholder="补充地点、链接、步骤或备注…">${esc(values.detail)}</textarea></label>
    <div class="subtask-editor-block">
      <div class="subtask-editor-head"><div><strong>子待办（可选）</strong><span>将任务拆分成可单独完成的小步骤</span></div><button data-subtask-add>${ICONS.plus} 添加</button></div>
      <div id="subtask-editor-list" class="subtask-editor-list">
        ${(values.subtasks || []).length
          ? values.subtasks.map(subtaskEditorRowHtml).join("")
          : '<p class="subtask-editor-empty">暂未添加子待办</p>'}
      </div>
    </div>
    <div class="dialog-actions editor-dialog-actions"><button class="secondary-btn" data-dialog="close">取消</button><button class="primary-btn" data-dialog="save">${item ? "保存修改" : "创建待办"}</button></div>
  </section>`;
  document.body.appendChild(overlay);

  const close = () => {
    dismissOverlay(overlay, () => restoreFocusDescriptor(returnFocus));
  };
  overlay.addEventListener("click", (event) => {
    if (event.target === overlay || event.target.closest('[data-dialog="close"]')) return close();
    const weekday = event.target.closest("[data-todo-weekday]");
    if (weekday) {
      const selected = !weekday.classList.contains("on");
      weekday.classList.toggle("on", selected);
      weekday.setAttribute("aria-pressed", String(selected));
      return;
    }
    if (event.target.closest("[data-subtask-add]")) {
      const list = overlay.querySelector("#subtask-editor-list");
      list.querySelector(".subtask-editor-empty")?.remove();
      list.insertAdjacentHTML("beforeend", subtaskEditorRowHtml());
      list.querySelector(".subtask-editor-row:last-child input")?.focus();
      return;
    }
    const removeSubtask = event.target.closest("[data-subtask-remove]");
    if (removeSubtask) {
      const list = overlay.querySelector("#subtask-editor-list");
      removeSubtask.closest("[data-subtask-row]")?.remove();
      if (!list.querySelector("[data-subtask-row]")) {
        list.innerHTML = '<p class="subtask-editor-empty">暂未添加子待办</p>';
      }
      return;
    }
    if (!event.target.closest('[data-dialog="save"]')) return;
    const title = overlay.querySelector("#edit-title").value.trim();
    const dueDate = overlay.querySelector("#edit-date").value;
    if (!title || !dueDate) {
      overlay.querySelector(!title ? "#edit-title" : "#edit-date").focus();
      overlay.querySelector(".dialog")?.classList.add("shake");
      setTimeout(() => overlay.querySelector(".dialog")?.classList.remove("shake"), 300);
      return;
    }
    const schedule = readTodoSchedule(overlay);
    const weekdays = [...overlay.querySelectorAll("[data-todo-weekday].on")]
      .map((button) => Number(button.dataset.todoWeekday))
      .sort((a, b) => a - b);
    if (schedule === "custom" && !weekdays.length) {
      overlay.querySelector("[data-todo-weekday]")?.focus();
      overlay.querySelector(".todo-schedule-field")?.classList.add("shake");
      setTimeout(() => overlay.querySelector(".todo-schedule-field")?.classList.remove("shake"), 300);
      return;
    }
    const timeResult = readTimeEditor(overlay.querySelector("[data-time-scope]"));
    if (timeResult.message) {
      showTimeEditorError(overlay.querySelector("[data-time-scope]"), timeResult);
      return;
    }
    const next = {
      title,
      dueDate,
      dueTime: timeResult.startTime,
      dueEndTime: timeResult.endTime,
      schedule,
      weekdays: schedule === "custom" ? weekdays : [],
      detail: overlay.querySelector("#edit-detail").value.trim(),
      subtasks: [...overlay.querySelectorAll("[data-subtask-row]")]
        .map((row) => ({
          id: row.dataset.subtaskId || uid(),
          title: row.querySelector(".subtask-editor-input").value.trim(),
          completed: row.dataset.completed === "true",
        }))
        .filter((subtask) => subtask.title),
    };
    const itemIndex = item ? state.items.findIndex((todo) => todo.id === item.id) : -1;
    const previousItem = item ? cloneValue(item) : null;
    const previousExpandedIds = [...state.expandedIds];
    let persisted = false;
    if (item) {
      const previousSchedule = item.schedule || "once";
      const scheduleChanged = previousSchedule !== next.schedule ||
        JSON.stringify(item.weekdays || []) !== JSON.stringify(next.weekdays || []);
      const reminderTriggerChanged = scheduleChanged || item.dueDate !== next.dueDate || item.dueTime !== next.dueTime;
      Object.assign(item, next);
      if (next.schedule === "once") {
        if (previousSchedule !== "once") {
          item.completed = false;
          item.completedAt = null;
        }
        item.notified = reminderTriggerChanged ? false : item.notified;
      } else {
        item.completed = false;
        item.completedAt = null;
        item.notified = false;
        item.records ||= {};
        item.notifiedRecords ||= {};
        const validSubtaskIds = new Set(item.subtasks.map((subtask) => subtask.id));
        for (const record of Object.values(item.records)) {
          if (!record || typeof record !== "object") continue;
          record.subtasks = Object.fromEntries(
            Object.entries(record.subtasks || {})
              .filter(([subtaskId, completed]) => validSubtaskIds.has(subtaskId) && completed === true),
          );
        }
        const todayRecord = todoRecordForDate(item, toDateKey());
        if (
          todayRecord?.completed === true &&
          item.subtasks.some((subtask) => todayRecord.subtasks?.[subtask.id] !== true)
        ) {
          todayRecord.completed = false;
          todayRecord.completedAt = null;
          delete item.notifiedRecords[toDateKey()];
        }
        if (reminderTriggerChanged) delete item.notifiedRecords[toDateKey()];
      }
      if (next.schedule === "once" && item.completed && item.subtasks.some((subtask) => !subtask.completed)) {
        item.completed = false;
        item.completedAt = null;
        item.notified = false;
      }
      if (!state.expandedIds.includes(item.id)) state.expandedIds.push(item.id);
      persisted = save();
    } else {
      persisted = addTodo(next);
    }
    if (!persisted) {
      state.expandedIds = previousExpandedIds;
      if (itemIndex >= 0 && previousItem) {
        state.items[itemIndex] = previousItem;
        item = previousItem;
      }
      showPersistenceError(overlay);
      return;
    }
    close();
    render();
  });
  overlay.addEventListener("keydown", (event) => {
    if (event.key === "Escape") close();
    if (event.key === "Enter" && event.target.matches(".subtask-editor-input")) {
      event.preventDefault();
      overlay.querySelector("[data-subtask-add]").click();
      return;
    }
    if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
      event.preventDefault();
      overlay.querySelector('[data-dialog="save"]').click();
    }
  });
  overlay.addEventListener("input", (event) => {
    if (event.target.matches("[data-time-start], [data-time-end]")) {
      const editor = event.target.closest("[data-time-scope]");
      editor.querySelector("[data-time-error]")?.classList.add("hidden");
      editor.querySelectorAll("[data-time-start], [data-time-end]").forEach((input) => {
        input.removeAttribute("aria-invalid");
      });
    }
  });
  overlay.addEventListener("change", (event) => {
    if (event.target.matches(".todo-schedule")) {
      const schedule = readTodoSchedule(overlay);
      overlay.querySelector("[data-todo-weekday-picker]")
        ?.classList.toggle("hidden", schedule !== "custom");
      const dateLabel = overlay.querySelector("[data-todo-date-label]");
      if (dateLabel) dateLabel.textContent = schedule === "once" ? "日期" : "开始日期";
      return;
    }
    if (event.target.matches("[data-time-mode]")) {
      const editor = event.target.closest("[data-time-scope]");
      syncTimeEditor(editor);
    }
  });
  overlay.querySelector("#edit-title")?.focus();
}

function deleteTodo(id) {
  if (!state.items.some((item) => item.id === id)) return;
  persistMutation(() => {
    const previousItems = state.items;
    const previousExpandedIds = state.expandedIds;
    state.items = state.items.filter((item) => item.id !== id);
    state.expandedIds = state.expandedIds.filter((value) => value !== id);
    return () => {
      state.items = previousItems;
      state.expandedIds = previousExpandedIds;
    };
  });
  render();
}

async function openExternal(url) {
  try {
    if (TAURI?.opener?.openUrl) await TAURI.opener.openUrl(url);
    else await TAURI?.core?.invoke("plugin:opener|open_url", { url });
  } catch (_) {
    window.open(url, "_blank", "noopener");
  }
}

function openSettings() {
  const settings = state.settings;
  let persistedOpacity = settings.opacity;
  const returnFocus = captureFocusDescriptor();
  const overlay = document.createElement("div");
  overlay.className = "overlay";
  overlay.innerHTML = `<section class="dialog settings-dialog" role="dialog" aria-modal="true" aria-labelledby="settings-title">
    <div class="dialog-head"><div><h2 id="settings-title">小组件设置</h2><p>常驻桌面，但尽量不打扰</p></div><button class="icon-btn" data-setting="close" aria-label="关闭">${ICONS.close}</button></div>
    <div class="setting-row"><div><strong>始终置顶</strong><span>保持待办一直可见</span></div><button class="switch ${settings.alwaysOnTop ? "on" : ""}" data-setting="alwaysOnTop" role="switch" aria-checked="${settings.alwaysOnTop}" aria-label="始终置顶"></button></div>
    <div class="setting-row"><div><strong>开机自启动</strong><span>登录电脑后自动显示</span></div><button id="autostart-switch" class="switch" data-setting="autostart" role="switch" aria-checked="false" aria-label="开机自启动"></button></div>
    <div class="setting-row"><div><strong>鼠标穿透</strong><span>点击会落到下方窗口</span></div><button class="switch ${settings.clickThrough ? "on" : ""}" data-setting="clickThrough" role="switch" aria-checked="${settings.clickThrough}" aria-label="鼠标穿透"></button></div>
    <div class="setting-block"><strong>外观</strong><div class="segmented" role="radiogroup" aria-label="外观主题">
      <button class="${settings.appearance === "system" ? "on" : ""}" data-theme-value="system" role="radio" aria-checked="${settings.appearance === "system"}">跟随系统</button>
      <button class="${settings.appearance === "light" ? "on" : ""}" data-theme-value="light" role="radio" aria-checked="${settings.appearance === "light"}">浅色</button>
      <button class="${settings.appearance === "dark" ? "on" : ""}" data-theme-value="dark" role="radio" aria-checked="${settings.appearance === "dark"}">深色</button>
    </div></div>
    <label class="setting-block"><span class="range-label"><strong>透明度</strong><em>${Math.round(settings.opacity * 100)}%</em></span><input id="opacity-range" type="range" min="0.72" max="0.98" step="0.01" value="${settings.opacity}" /></label>
    <div class="backup-row"><button data-setting="export">${ICONS.download}导出备份</button><button data-setting="import">${ICONS.upload}导入备份</button></div>
    <p class="settings-tip">快捷键 <b>${navigator.platform.includes("Mac") ? "⌘⇧Space" : "Ctrl+Shift+Space"}</b> 可随时唤起。开启鼠标穿透后，可从系统托盘菜单关闭。</p>
  </section>`;
  document.body.appendChild(overlay);
  const close = () => dismissOverlay(overlay, () => restoreFocusDescriptor(returnFocus));

  overlay.addEventListener("click", async (event) => {
    if (event.target === overlay || event.target.closest('[data-setting="close"]')) return close();
    const theme = event.target.closest("[data-theme-value]");
    if (theme) {
      const previousAppearance = settings.appearance;
      settings.appearance = theme.dataset.themeValue;
      if (!save()) {
        settings.appearance = previousAppearance;
        showPersistenceError(overlay);
      } else clearPersistenceError(overlay);
      overlay.querySelectorAll("[data-theme-value]").forEach((button) => {
        const selected = button.dataset.themeValue === settings.appearance;
        button.classList.toggle("on", selected);
        button.setAttribute("aria-checked", String(selected));
      });
      applyAppearance(); return;
    }
    const target = event.target.closest("[data-setting]");
    if (!target) return;
    const key = target.dataset.setting;
    if (key === "alwaysOnTop") {
      const previousValue = settings.alwaysOnTop;
      settings.alwaysOnTop = !settings.alwaysOnTop;
      if (!save()) {
        settings.alwaysOnTop = previousValue;
        showPersistenceError(overlay);
      } else clearPersistenceError(overlay);
      target.classList.toggle("on", settings.alwaysOnTop);
      target.setAttribute("aria-checked", String(settings.alwaysOnTop));
      applyAppearance();
    } else if (key === "clickThrough") {
      const previousValue = settings.clickThrough;
      settings.clickThrough = !settings.clickThrough;
      const persisted = save();
      if (!persisted) {
        settings.clickThrough = previousValue;
        showPersistenceError(overlay);
      } else clearPersistenceError(overlay);
      target.classList.toggle("on", settings.clickThrough);
      target.setAttribute("aria-checked", String(settings.clickThrough));
      if (persisted && settings.clickThrough) overlay.remove();
      applyAppearance();
    } else if (key === "autostart") {
      await toggleAutostart(target, overlay);
    } else if (key === "export") {
      await exportBackup();
    } else if (key === "import") {
      await importBackup(overlay);
    }
  });
  overlay.querySelector("#opacity-range")?.addEventListener("input", (event) => {
    settings.opacity = Number(event.target.value);
    overlay.querySelector(".range-label em").textContent = `${Math.round(settings.opacity * 100)}%`;
    scheduleAppearanceUpdate();
  });
  overlay.querySelector("#opacity-range")?.addEventListener("change", (event) => {
    flushAppearanceUpdate();
    if (save()) {
      persistedOpacity = settings.opacity;
      clearPersistenceError(overlay);
      return;
    }
    settings.opacity = persistedOpacity;
    event.target.value = String(persistedOpacity);
    overlay.querySelector(".range-label em").textContent = `${Math.round(persistedOpacity * 100)}%`;
    applyAppearance();
    showPersistenceError(overlay);
  });
  (async () => {
    try {
      const enabled = await TAURI?.autostart?.isEnabled();
      const autostartSwitch = overlay.querySelector("#autostart-switch");
      autostartSwitch?.classList.toggle("on", !!enabled);
      autostartSwitch?.setAttribute("aria-checked", String(!!enabled));
    } catch (_) {}
  })();

  overlay.addEventListener("keydown", (event) => {
    if (event.key === "Escape") close();
  });
  overlay.querySelector('[data-setting="close"]')?.focus();
}

async function toggleAutostart(button, overlay) {
  try {
    const enabled = await TAURI.autostart.isEnabled();
    if (enabled) await TAURI.autostart.disable();
    else await TAURI.autostart.enable();
    const previousInitialized = state.settings.autostartInitialized;
    state.settings.autostartInitialized = true;
    let nextEnabled = !enabled;
    if (!save()) {
      state.settings.autostartInitialized = previousInitialized;
      try {
        if (enabled) await TAURI.autostart.enable();
        else await TAURI.autostart.disable();
        nextEnabled = enabled;
        showPersistenceError(overlay);
      } catch (rollbackError) {
        console.error("Unable to restore the previous autostart setting", rollbackError);
        try { nextEnabled = await TAURI.autostart.isEnabled(); } catch (_) {}
        showPersistenceError(overlay, "设置未保存，且系统自启动状态可能未恢复，请重新检查此开关。");
      }
    } else clearPersistenceError(overlay);
    button.classList.toggle("on", nextEnabled);
    button.setAttribute("aria-checked", String(nextEnabled));
  } catch (error) {
    console.error("Unable to change the autostart setting", error);
    showPersistenceError(overlay, "无法更改系统自启动设置，请稍后重试。");
  }
}

async function ensureAutostart() {
  if (state.settings.autostartInitialized || !TAURI?.autostart) return;
  try {
    await TAURI.autostart.enable();
    state.settings.autostartInitialized = true;
    save();
  } catch (_) {}
}

async function exportBackup() {
  try {
    await TAURI?.core?.invoke("export_data", { json: JSON.stringify(state, null, 2) });
  } catch (_) {}
}

async function importBackup(overlay) {
  try {
    const content = await TAURI?.core?.invoke("import_data");
    if (!content) return;
    const previousState = state;
    state = migrateSnapshot(JSON.parse(content));
    pruneTransientState();
    if (!save()) {
      state = previousState;
      showPersistenceError(overlay);
      return;
    }
    overlay?.remove();
    render();
  } catch (_) {}
}

async function ensureNotificationPermission() {
  try {
    if (!TAURI?.notification) return false;
    const granted = await TAURI.notification.isPermissionGranted();
    if (granted) return true;
    if (notificationPermissionRequested) return false;
    notificationPermissionRequested = true;
    return (await TAURI.notification.requestPermission()) === "granted";
  } catch (_) {
    return false;
  }
}

async function runReminderCheck() {
  const now = new Date();
  const nowTimestamp = now.getTime();
  const dateKey = toDateKey(now);
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const dueTodos = state.items.filter((item) => {
    if (!item.dueTime) return false;
    if (isRecurringTodo(item)) {
      if (
        !todoOccursOnDate(item, dateKey) ||
        todoCompletedForDate(item, dateKey) ||
        item.notifiedRecords?.[dateKey] === true
      ) return false;
    } else if (item.completed || item.notified) return false;
    const timestamp = dueTimestamp({
      dueDate: isRecurringTodo(item) ? dateKey : item.dueDate,
      dueTime: item.dueTime || "",
    });
    return timestamp <= nowTimestamp && timestamp >= startOfToday;
  });
  const dueRoutines = [];
  (state.goals || []).filter((goal) => goal.status === "active").forEach((goal) => {
    routinesForDate(goal, dateKey).forEach((routine) => {
      const timestamp = dueTimestamp({ dueDate: dateKey, dueTime: routine.time || "" });
      if (
        routine.time &&
        goal.records?.[dateKey]?.[routine.id] !== true &&
        goal.notifiedRecords?.[dateKey]?.[routine.id] !== true &&
        timestamp <= nowTimestamp && timestamp >= startOfToday
      ) dueRoutines.push({ goal, routine });
    });
  });
  if (!dueTodos.length && !dueRoutines.length) return;
  if (!(await ensureNotificationPermission())) return;
  if (toDateKey() !== dateKey) return;

  let changed = false;
  for (const item of dueTodos) {
    if (toDateKey() !== dateKey) break;
    try {
      await Promise.resolve(TAURI.notification.sendNotification({
        title: "悬浮待办 · 到点提醒",
        body: `${timeRangeLabel(item.dueTime, item.dueEndTime)}　${item.title}`,
      }));
      if (isRecurringTodo(item)) {
        item.notifiedRecords ||= {};
        item.notifiedRecords[dateKey] = true;
      } else item.notified = true;
      changed = true;
    } catch (_) {}
  }
  for (const { goal, routine } of dueRoutines) {
    if (toDateKey() !== dateKey) break;
    try {
      await Promise.resolve(TAURI.notification.sendNotification({
        title: `${goal.title} · 今日计划`,
        body: `${timeRangeLabel(routine.time, routine.endTime)}　${routine.title}`,
      }));
      goal.notifiedRecords ||= {};
      goal.notifiedRecords[dateKey] ||= {};
      goal.notifiedRecords[dateKey][routine.id] = true;
      changed = true;
    } catch (_) {}
  }
  if (changed) {
    pruneTransientState(toDateKey());
    save();
  }
}

async function checkReminders() {
  if (reminderCheckRunning || !TAURI?.notification) return;
  reminderCheckRunning = true;
  try {
    await runReminderCheck();
  } catch (error) {
    console.error("Unable to check reminders", error);
  } finally {
    reminderCheckRunning = false;
  }
}

function updateRelativeLabels() {
  const today = toDateKey();
  if (today === lastRenderedDate) return;
  lastRenderedDate = today;
  pruneTransientState(today);
  save();
  render();
}

function rememberWindowGeometry(position = null) {
  if (!appWindow) return;
  const width = Math.round(window.innerWidth);
  const height = Math.round(window.innerHeight);
  const next = {
    ...(rememberedWindowState || {}),
    width,
    height,
    compact,
  };
  if (position && Number.isFinite(position.x) && Number.isFinite(position.y)) {
    next.x = position.x;
    next.y = position.y;
  }
  if (!compact && width >= COMPACT_ENTER_WIDTH && height >= COMPACT_ENTER_HEIGHT) {
    next.expandedWidth = width;
    next.expandedHeight = height;
  }
  rememberedWindowState = normalizeWindowState(next);
}

function flushWindowState() {
  if (!appWindow) return;
  if (windowStateSaveTimer !== null) {
    clearTimeout(windowStateSaveTimer);
    windowStateSaveTimer = null;
  }
  rememberWindowGeometry();
  if (!rememberedWindowState) return;
  try {
    localStorage.setItem(WINDOW_STATE_KEY, JSON.stringify(rememberedWindowState));
  } catch (error) {
    console.warn("Unable to persist window geometry", error);
  }
}

function scheduleWindowStateSave(position = null) {
  if (!appWindow) return;
  rememberWindowGeometry(position);
  if (windowStateSaveTimer !== null) clearTimeout(windowStateSaveTimer);
  windowStateSaveTimer = setTimeout(flushWindowState, WINDOW_STATE_SAVE_DELAY);
}

async function restoreWindowState() {
  if (!appWindow || !rememberedWindowState || !TAURI?.window?.LogicalSize) return;
  try {
    await appWindow.setSize(new TAURI.window.LogicalSize(
      rememberedWindowState.width,
      rememberedWindowState.height,
    ));
    if (
      rememberedWindowState.x !== undefined && rememberedWindowState.y !== undefined &&
      TAURI.window.PhysicalPosition && TAURI.window.availableMonitors
    ) {
      const monitors = await TAURI.window.availableMonitors();
      if (isWindowPositionVisible(rememberedWindowState, monitors)) {
        await appWindow.setPosition(new TAURI.window.PhysicalPosition(
          rememberedWindowState.x,
          rememberedWindowState.y,
        ));
      }
    }
  } catch (error) {
    console.warn("Unable to restore window geometry", error);
  }
}

async function bindWindowStatePersistence() {
  if (!appWindow) return;
  try {
    const position = await appWindow.outerPosition();
    rememberWindowGeometry(position);
    flushWindowState();
  } catch (_) {}
  try {
    const unlisten = await appWindow.onMoved(({ payload }) => scheduleWindowStateSave(payload));
    windowEventUnlisteners.push(unlisten);
  } catch (_) {}
}

async function listenToAppEvent(name, handler) {
  if (!TAURI?.event?.listen) return;
  try {
    const unlisten = await TAURI.event.listen(name, handler);
    windowEventUnlisteners.push(unlisten);
  } catch (error) {
    console.warn(`Unable to listen for ${name}`, error);
  }
}

async function showReadyWindow() {
  if (!appWindow) return;
  try {
    await appWindow.show();
    await appWindow.setFocus();
  } catch (error) {
    console.warn("Unable to show the ready application window", error);
  }
}

async function expandWindow() {
  if (!appWindow || !TAURI?.window?.LogicalSize) return false;
  const width = Math.max(
    COMPACT_EXIT_WIDTH,
    rememberedWindowState?.expandedWidth || WINDOW_LIMITS.defaultWidth,
  );
  const height = Math.max(
    COMPACT_EXIT_HEIGHT,
    rememberedWindowState?.expandedHeight || WINDOW_LIMITS.defaultHeight,
  );
  try {
    await appWindow.setSize(new TAURI.window.LogicalSize(width, height));
    compact = false;
    document.documentElement.classList.remove("compact");
    scheduleWindowStateSave();
    return true;
  } catch (_) {
    return false;
  }
}

function updateCompact(renderOnChange = true) {
  const next = compact
    ? window.innerWidth < COMPACT_EXIT_WIDTH || window.innerHeight < COMPACT_EXIT_HEIGHT
    : window.innerWidth < COMPACT_ENTER_WIDTH || window.innerHeight < COMPACT_ENTER_HEIGHT;
  document.documentElement.classList.toggle("compact", next);
  if (next === compact) return;
  if (next) showAllCompleted = false;
  compact = next;
  if (renderOnChange) render();
}

document.querySelectorAll(".resize").forEach((handle) => {
  handle.addEventListener("mousedown", (event) => {
    event.preventDefault();
    appWindow?.startResizeDragging(handle.dataset.dir).catch(() => {});
  });
});

const windowEventUnlisteners = [];
let maintenanceTimer = null;

async function initializeApp() {
  await restoreWindowState();
  updateCompact(false);
  overviewWidthTier = getOverviewWidthTier();
  render();

  window.addEventListener("resize", () => {
    const previousCompact = compact;
    updateCompact(false);
    const nextOverviewWidthTier = getOverviewWidthTier();
    const overviewTierChanged = nextOverviewWidthTier !== overviewWidthTier;
    overviewWidthTier = nextOverviewWidthTier;
    if (compact !== previousCompact || overviewTierChanged) render();
    scheduleWindowStateSave();
  });
  await bindWindowStatePersistence();

  await Promise.all([
    listenToAppEvent("quick-capture", async () => {
      document.querySelector(".overlay")?.remove();
      if (compact) await expandWindow();
      render();
      openEditor();
    }),
    listenToAppEvent("toggle-passthrough", () => {
      const previousValue = state.settings.clickThrough;
      state.settings.clickThrough = !state.settings.clickThrough;
      if (!save()) {
        state.settings.clickThrough = previousValue;
        render();
      }
      applyAppearance();
    }),
  ]);

  await showReadyWindow();

  ensureAutostart();
  checkReminders();
  maintenanceTimer = setInterval(() => {
    updateRelativeLabels();
    checkReminders();
  }, 60_000);
}

window.addEventListener("beforeunload", () => {
  flushStateSave();
  flushWindowState();
  if (appearanceFrame !== null) cancelAnimationFrame(appearanceFrame);
  if (maintenanceTimer !== null) clearInterval(maintenanceTimer);
  windowEventUnlisteners.splice(0).forEach((unlisten) => unlisten());
}, { once: true });

initializeApp().catch((error) => {
  console.error("Unable to initialize the application", error);
  updateCompact(false);
  overviewWidthTier = getOverviewWidthTier();
  render();
  showReadyWindow();
});
