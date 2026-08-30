export const DAY_MS = 86_400_000;

export function pad2(value) {
  return String(value).padStart(2, "0");
}

export function toDateKey(date = new Date()) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

export function fromDateKey(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value || "");
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(year, month - 1, day);
  if (
    Number.isNaN(date.getTime()) ||
    date.getFullYear() !== year ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== day
  ) return null;
  return date;
}

export function addDays(dateKey, amount) {
  const date = fromDateKey(dateKey) || new Date();
  date.setDate(date.getDate() + amount);
  return toDateKey(date);
}

export function dayDistance(dateKey, now = new Date()) {
  const target = fromDateKey(dateKey);
  if (!target) return Number.POSITIVE_INFINITY;
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((target.getTime() - today.getTime()) / DAY_MS);
}

export function relativeDayLabel(dateKey, now = new Date()) {
  const days = dayDistance(dateKey, now);
  if (!Number.isFinite(days)) return "未设日期";
  if (days === 0) return "今天";
  if (days === 1) return "明天 · 剩余 1 天";
  if (days > 1) return `剩余 ${days} 天`;
  if (days === -1) return "昨天 · 已逾期 1 天";
  return `已逾期 ${Math.abs(days)} 天`;
}

export function dateDisplay(dateKey) {
  const date = fromDateKey(dateKey);
  if (!date) return "未设日期";
  const weekdays = ["日", "一", "二", "三", "四", "五", "六"];
  return `${date.getFullYear()}/${pad2(date.getMonth() + 1)}/${pad2(date.getDate())} 周${weekdays[date.getDay()]}`;
}

export function dueTimestamp(item) {
  const date = fromDateKey(item?.dueDate);
  if (!date) return Number.POSITIVE_INFINITY;
  const match = /^(\d{2}):(\d{2})$/.exec(validTime(item?.dueTime));
  if (match) date.setHours(Number(match[1]), Number(match[2]), 0, 0);
  else date.setHours(23, 59, 59, 999);
  return date.getTime();
}

export function sortTodos(items) {
  return [...items].sort((a, b) => {
    if (!!a.completed !== !!b.completed) return a.completed ? 1 : -1;
    if (a.completed && b.completed) {
      return (b.completedAt || 0) - (a.completedAt || 0);
    }
    const due = dueTimestamp(a) - dueTimestamp(b);
    if (due !== 0) return due;
    return (a.createdAt || 0) - (b.createdAt || 0);
  });
}

/**
 * Build the future-only entries shown by the time horizon.
 *
 * Dates are deliberately treated as local calendar days rather than timestamps:
 * the horizon is about upcoming milestones, so a todo without a time remains a
 * first-class entry and the current day never leaks into the future section.
 */
export function buildFutureHorizonEntries(items = [], goals = [], now = new Date()) {
  const sources = [
    ...(
      Array.isArray(items)
        ? items.map((item) => ({
            source: item,
            kind: "todo",
            dateKey: item?.dueDate,
            completed: item?.completed === true,
          }))
        : []
    ),
    ...(
      Array.isArray(goals)
        ? goals.map((goal) => ({
            source: goal,
            kind: "goal",
            dateKey: goal?.targetDate,
            completed: goal?.status === "completed" || goal?.completed === true,
          }))
        : []
    ),
  ];

  return sources
    .flatMap(({ source, kind, dateKey, completed }) => {
      if (!source || typeof source !== "object" || completed || !fromDateKey(dateKey)) return [];
      const distance = dayDistance(dateKey, now);
      if (!Number.isFinite(distance) || distance <= 0) return [];
      return [{
        kind,
        id: source.id,
        title: source.title,
        dateKey,
        distance,
      }];
    })
    .sort((a, b) => a.distance - b.distance);
}

/** Split future horizon entries into its three display-density bands. */
export function bucketFutureHorizonEntries(entries = []) {
  const buckets = {
    within30Days: [],
    within90Days: [],
    beyond90Days: [],
  };

  if (!Array.isArray(entries)) return buckets;
  for (const entry of entries) {
    if (!entry || !Number.isFinite(entry.distance) || entry.distance <= 0) continue;
    if (entry.distance <= 30) buckets.within30Days.push(entry);
    else if (entry.distance <= 90) buckets.within90Days.push(entry);
    else buckets.beyond90Days.push(entry);
  }
  return buckets;
}

export function parseQuickTodo(text, now = new Date()) {
  let title = String(text || "").trim();
  let dueDate = toDateKey(now);
  let dueTime = "";

  const dateRules = [
    { regex: /(?:今天|今日)/, offset: 0 },
    { regex: /明天/, offset: 1 },
    { regex: /后天/, offset: 2 },
  ];
  for (const rule of dateRules) {
    if (rule.regex.test(title)) {
      dueDate = addDays(toDateKey(now), rule.offset);
      title = title.replace(rule.regex, " ");
      break;
    }
  }

  const absolute = title.match(/(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})日?/);
  const short = !absolute && title.match(/(\d{1,2})月(\d{1,2})日?/);
  if (absolute) {
    const candidate = `${absolute[1]}-${pad2(absolute[2])}-${pad2(absolute[3])}`;
    if (fromDateKey(candidate)) {
      dueDate = candidate;
      title = title.replace(absolute[0], " ");
    }
  } else if (short) {
    const candidate = `${now.getFullYear()}-${pad2(short[1])}-${pad2(short[2])}`;
    if (fromDateKey(candidate)) {
      dueDate = dayDistance(candidate, now) < 0
        ? `${now.getFullYear() + 1}-${pad2(short[1])}-${pad2(short[2])}`
        : candidate;
      title = title.replace(short[0], " ");
    }
  }

  const colonTime = title.match(/(?:上午|早上|中午|下午|晚上|凌晨)?\s*(\d{1,2}):(\d{2})/);
  const chineseTime = !colonTime && title.match(/(上午|早上|中午|下午|晚上|凌晨)?\s*(\d{1,2})点(半|\d{1,2}分?)?/);
  const match = colonTime || chineseTime;
  if (match) {
    let hour = Number(match[1] && colonTime ? match[1] : match[2]);
    let minute = colonTime ? Number(match[2]) : match[3] === "半" ? 30 : Number(String(match[3] || "0").replace("分", ""));
    const period = colonTime ? (match[0].match(/上午|早上|中午|下午|晚上|凌晨/) || [""])[0] : match[1] || "";
    if (["下午", "晚上"].includes(period) && hour < 12) hour += 12;
    if (period === "中午" && hour < 11) hour += 12;
    if (["上午", "早上", "凌晨"].includes(period) && hour === 12) hour = 0;
    dueTime = `${pad2(Math.min(hour, 23))}:${pad2(Math.min(minute, 59))}`;
    title = title.replace(match[0], " ");
  }

  return { title: title.replace(/\s+/g, " ").trim(), dueDate, dueTime, dueEndTime: "" };
}

function normalizeSubtasks(item, itemIndex) {
  if (!Array.isArray(item?.subtasks)) return [];
  const seen = new Set();
  const parentId = String(item.id || `item-${itemIndex}`);

  return item.subtasks.flatMap((subtask, subtaskIndex) => {
    if (!subtask || typeof subtask !== "object") return [];
    const title = String(subtask.title || "").trim();
    if (!title) return [];

    let id = String(subtask.id || "").trim();
    if (!id || seen.has(id)) {
      const fallback = `subtask-${parentId}-${subtaskIndex}`;
      id = fallback;
      let suffix = 2;
      while (seen.has(id)) id = `${fallback}-${suffix++}`;
    }
    seen.add(id);

    return [{
      id,
      title,
      completed: item.completed ? true : !!subtask.completed,
    }];
  });
}

const GOAL_STATUSES = new Set(["active", "paused", "completed"]);
const ROUTINE_SCHEDULES = new Set(["daily", "weekdays", "custom"]);

function validTimestamp(value, fallback = null) {
  const timestamp = Number(value);
  return value !== null
    && value !== ""
    && Number.isFinite(timestamp)
    && timestamp > 0
    && !Number.isNaN(new Date(timestamp).getTime())
    ? timestamp
    : fallback;
}

function validTime(value) {
  const match = /^(\d{2}):(\d{2})$/.exec(String(value || "").trim());
  if (!match || Number(match[1]) > 23 || Number(match[2]) > 59) return "";
  return `${match[1]}:${match[2]}`;
}

function normalizeTimeRange(startValue, endValue) {
  const startTime = validTime(startValue);
  const candidateEndTime = validTime(endValue);
  return {
    startTime,
    endTime: startTime && candidateEndTime > startTime ? candidateEndTime : "",
  };
}

function normalizeWeekdays(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((day) => Number.isInteger(day) && day >= 0 && day <= 6))]
    .sort((a, b) => a - b);
}

function normalizeRoutines(goal, goalId, goalStartDate) {
  if (!Array.isArray(goal?.routines)) return [];
  const seenIds = new Set();

  return goal.routines.flatMap((routine, routineIndex) => {
    if (!routine || typeof routine !== "object") return [];
    const title = String(routine.title || "").trim();
    if (!title) return [];

    let id = String(routine.id || "").trim();
    if (!id || seenIds.has(id)) {
      const fallback = `routine-${goalId}-${routineIndex}`;
      id = fallback;
      let suffix = 2;
      while (seenIds.has(id)) id = `${fallback}-${suffix++}`;
    }
    seenIds.add(id);

    const schedule = ROUTINE_SCHEDULES.has(routine.schedule) ? routine.schedule : "daily";
    const timeRange = normalizeTimeRange(routine.time, routine.endTime);
    return [{
      id,
      title,
      time: timeRange.startTime,
      endTime: timeRange.endTime,
      schedule,
      weekdays: schedule === "custom" ? normalizeWeekdays(routine.weekdays) : [],
      startDate: fromDateKey(routine.startDate) ? routine.startDate : goalStartDate,
      endDate: fromDateKey(routine.endDate) ? routine.endDate : "",
    }];
  });
}

function normalizePausePeriods(pausePeriods) {
  if (!Array.isArray(pausePeriods)) return [];
  return pausePeriods.flatMap((period) => {
    if (!period || typeof period !== "object" || !fromDateKey(period.startDate)) return [];
    return [{
      startDate: period.startDate,
      endDate: fromDateKey(period.endDate) ? period.endDate : "",
    }];
  });
}

function normalizeRecords(records, routineIds) {
  if (!records || typeof records !== "object" || Array.isArray(records)) return {};
  const normalized = {};

  for (const [dateKey, completions] of Object.entries(records)) {
    if (!fromDateKey(dateKey) || !completions || typeof completions !== "object" || Array.isArray(completions)) {
      continue;
    }
    const trueCompletions = {};
    for (const [routineId, completed] of Object.entries(completions)) {
      if (completed === true && routineIds.has(routineId)) trueCompletions[routineId] = true;
    }
    if (Object.keys(trueCompletions).length) normalized[dateKey] = trueCompletions;
  }

  return normalized;
}

function normalizeGoals(goals, now) {
  if (!Array.isArray(goals)) return [];
  const today = toDateKey(now);
  const nowTimestamp = now.getTime();
  const seenIds = new Set();

  return goals.flatMap((goal, goalIndex) => {
    if (!goal || typeof goal !== "object") return [];
    const title = String(goal.title || "").trim();
    if (!title) return [];

    let id = String(goal.id || "").trim();
    if (!id || seenIds.has(id)) {
      const fallback = `goal-${goalIndex}`;
      id = fallback;
      let suffix = 2;
      while (seenIds.has(id)) id = `${fallback}-${suffix++}`;
    }
    seenIds.add(id);

    const status = GOAL_STATUSES.has(goal.status) ? goal.status : "active";
    const startDate = fromDateKey(goal.startDate) ? goal.startDate : today;
    const routines = normalizeRoutines(goal, id, startDate);
    const routineIds = new Set(routines.map((routine) => routine.id));

    return [{
      id,
      title,
      detail: String(goal.detail || "").trim(),
      targetDate: fromDateKey(goal.targetDate) ? goal.targetDate : "",
      startDate,
      status,
      completedAt: status === "completed" ? validTimestamp(goal.completedAt, nowTimestamp) : null,
      routines,
      records: normalizeRecords(goal.records, routineIds),
      notifiedRecords: normalizeRecords(goal.notifiedRecords, routineIds),
      pausePeriods: normalizePausePeriods(goal.pausePeriods),
      createdAt: validTimestamp(goal.createdAt, nowTimestamp),
    }];
  });
}

export function routineOccursOnDate(routine, dateKey) {
  const date = fromDateKey(dateKey);
  if (!date || !routine || typeof routine !== "object") return false;

  const schedule = ROUTINE_SCHEDULES.has(routine.schedule) ? routine.schedule : "daily";
  const weekday = date.getDay();
  if (schedule === "daily") return true;
  if (schedule === "weekdays") return weekday >= 1 && weekday <= 5;
  return normalizeWeekdays(routine.weekdays).includes(weekday);
}

export function routinesForDate(goal, dateKey) {
  if (!goal || typeof goal !== "object" || !fromDateKey(dateKey)) return [];
  const startDate = fromDateKey(goal.startDate) ? goal.startDate : "";
  const targetDate = fromDateKey(goal.targetDate) ? goal.targetDate : "";
  if ((startDate && dateKey < startDate) || (targetDate && dateKey > targetDate)) return [];
  if (!Array.isArray(goal.routines)) return [];
  return goal.routines.filter((routine) => {
    const routineStart = fromDateKey(routine?.startDate) ? routine.startDate : startDate;
    const routineEnd = fromDateKey(routine?.endDate) ? routine.endDate : "";
    return (!routineStart || dateKey >= routineStart)
      && (!routineEnd || dateKey <= routineEnd)
      && routineOccursOnDate(routine, dateKey);
  });
}

export function goalIsPausedOnDate(goal, dateKey) {
  if (!goal || typeof goal !== "object" || !fromDateKey(dateKey) || !Array.isArray(goal.pausePeriods)) {
    return false;
  }
  return goal.pausePeriods.some((period) => {
    if (!period || typeof period !== "object" || !fromDateKey(period.startDate)) return false;
    const endDate = fromDateKey(period.endDate) ? period.endDate : "";
    return dateKey >= period.startDate && (!endDate || dateKey <= endDate);
  });
}

export function goalProgressForDate(goal, dateKey) {
  const routines = routinesForDate(goal, dateKey);
  const record = goal?.records?.[dateKey];
  const completed = routines.reduce(
    (count, routine) => count + (record?.[routine.id] === true ? 1 : 0),
    0,
  );
  const total = routines.length;
  return {
    completed,
    total,
    remaining: total - completed,
    ratio: total ? completed / total : 0,
    isComplete: total > 0 && completed === total,
    routines,
  };
}

export function goalWeekStats(goal, now = new Date()) {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (Number.isNaN(today.getTime())) {
    return {
      weekStart: "",
      throughDate: "",
      days: [],
      scheduledDays: 0,
      completedDays: 0,
      completed: 0,
      total: 0,
      remaining: 0,
      ratio: 0,
    };
  }

  const todayKey = toDateKey(today);
  const monday = new Date(today);
  monday.setDate(today.getDate() - ((today.getDay() + 6) % 7));
  const weekStart = toDateKey(monday);
  const goalStart = fromDateKey(goal?.startDate) ? goal.startDate : "";
  const goalTarget = fromDateKey(goal?.targetDate) ? goal.targetDate : "";
  const completedTimestamp = validTimestamp(goal?.completedAt);
  const completedDate = goal?.status === "completed"
    && completedTimestamp !== null
    ? toDateKey(new Date(completedTimestamp))
    : "";
  const firstDate = goalStart && goalStart > weekStart ? goalStart : weekStart;
  let throughDate = goalTarget && goalTarget < todayKey ? goalTarget : todayKey;
  if (completedDate && completedDate < throughDate) throughDate = completedDate;
  const days = [];

  if (firstDate <= throughDate) {
    for (let dateKey = firstDate; dateKey <= throughDate; dateKey = addDays(dateKey, 1)) {
      if (!goalIsPausedOnDate(goal, dateKey)) {
        days.push({ dateKey, ...goalProgressForDate(goal, dateKey) });
      }
    }
  }

  const scheduledDays = days.filter((day) => day.total > 0).length;
  const completedDays = days.filter((day) => day.isComplete).length;
  const completed = days.reduce((sum, day) => sum + day.completed, 0);
  const total = days.reduce((sum, day) => sum + day.total, 0);

  return {
    weekStart,
    throughDate,
    days,
    scheduledDays,
    completedDays,
    completed,
    total,
    remaining: total - completed,
    ratio: total ? completed / total : 0,
  };
}

export function migrateSnapshot(snapshot, now = new Date()) {
  const base = {
    version: 5,
    items: [],
    goals: [],
    filter: "open",
    expandedIds: [],
    settings: {
      alwaysOnTop: true,
      opacity: 0.9,
      appearance: "system",
      customBg: null,
      clickThrough: false,
      autostartInitialized: false,
      todayActionsCollapsedDate: "",
    },
  };
  if (!snapshot || typeof snapshot !== "object") return base;

  if (Array.isArray(snapshot.items)) {
    return {
      ...base,
      ...snapshot,
      version: 5,
      items: snapshot.items
        .filter((item) => item && typeof item === "object")
        .map((item, index) => {
          const timeRange = normalizeTimeRange(item.dueTime ?? item.time, item.dueEndTime ?? item.endTime);
          const { time: _legacyTime, endTime: _legacyEndTime, ...normalizedItem } = item;
          return {
            ...normalizedItem,
            dueTime: timeRange.startTime,
            dueEndTime: timeRange.endTime,
            subtasks: normalizeSubtasks(item, index),
          };
        }),
      goals: normalizeGoals(snapshot.goals, now),
      expandedIds: Array.isArray(snapshot.expandedIds) ? snapshot.expandedIds : [],
      settings: { ...base.settings, ...(snapshot.settings || {}) },
    };
  }

  const today = toDateKey(now);
  const offsets = { today: 0, tomorrow: 1, dayAfterTomorrow: 2 };
  const migrated = [];
  for (const [day, offset] of Object.entries(offsets)) {
    for (const item of snapshot.itemsByDay?.[day] || []) {
      const timeRange = normalizeTimeRange(item.time ?? item.dueTime, item.endTime ?? item.dueEndTime);
      migrated.push({
        id: item.id,
        title: item.title,
        detail: item.detail || "",
        subtasks: [],
        dueDate: addDays(today, offset),
        dueTime: timeRange.startTime,
        dueEndTime: timeRange.endTime,
        completed: !!item.completed,
        completedAt: item.completed ? Date.now() : null,
        notified: !!item.notified,
        createdAt: item.createdAt || Date.now(),
      });
    }
  }
  for (const item of snapshot.recurringItems || []) {
    const timeRange = normalizeTimeRange(item.time ?? item.dueTime, item.endTime ?? item.dueEndTime);
    migrated.push({
      id: item.id,
      title: `每日 · ${item.title}`,
      detail: item.detail || "原版本中的“每天”待办，已迁移为今天的普通待办。",
      subtasks: [],
      dueDate: today,
      dueTime: timeRange.startTime,
      dueEndTime: timeRange.endTime,
      completed: !!item.completed,
      completedAt: item.completed ? Date.now() : null,
      notified: !!item.notified,
      createdAt: item.createdAt || Date.now(),
    });
  }

  return {
    ...base,
    items: migrated,
    goals: normalizeGoals(snapshot.goals, now),
    settings: { ...base.settings, ...(snapshot.settings || {}) },
  };
}
