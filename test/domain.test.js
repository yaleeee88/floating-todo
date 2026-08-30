import test from "node:test";
import assert from "node:assert/strict";

import {
  bucketFutureHorizonEntries,
  buildFutureHorizonEntries,
  dueTimestamp,
  goalIsPausedOnDate,
  goalProgressForDate,
  goalWeekStats,
  migrateSnapshot,
  parseQuickTodo,
  relativeDayLabel,
  routineOccursOnDate,
  routinesForDate,
  sortTodos,
  todoOccursOnDate,
} from "../src/domain.js";

const NOW = new Date(2026, 7, 30, 12, 0, 0);

test("解析相对日期和中文时间", () => {
  assert.deepEqual(parseQuickTodo("明天 下午3点半 提交方案", NOW), {
    title: "提交方案",
    dueDate: "2026-08-31",
    dueTime: "15:30",
    dueEndTime: "",
  });
});

test("解析跨年的简写日期", () => {
  assert.deepEqual(parseQuickTodo("1月2日 09:15 年度复盘", NOW), {
    title: "年度复盘",
    dueDate: "2027-01-02",
    dueTime: "09:15",
    dueEndTime: "",
  });
});

test("显示未来和逾期天数", () => {
  assert.equal(relativeDayLabel("2026-08-30", NOW), "今天");
  assert.equal(relativeDayLabel("2026-09-02", NOW), "剩余 3 天");
  assert.equal(relativeDayLabel("2026-08-28", NOW), "已逾期 2 天");
});

test("未完成事项按日期时间排序，已完成事项沉底", () => {
  const result = sortTodos([
    { id: "done", dueDate: "2026-08-29", dueTime: "08:00", completed: true, completedAt: 1 },
    { id: "later", dueDate: "2026-09-02", dueTime: "", dueEndTime: "10:00", completed: false, createdAt: 1 },
    { id: "point", dueDate: "2026-08-31", dueTime: "09:30", dueEndTime: "", completed: false, createdAt: 3 },
    { id: "range", dueDate: "2026-08-31", dueTime: "09:00", dueEndTime: "11:00", completed: false, createdAt: 2 },
  ]);
  assert.deepEqual(result.map((item) => item.id), ["range", "point", "later", "done"]);
});

test("时间地平线合并未来待办和阶段目标并按日期排序", () => {
  const items = [
    { id: "todo-later", title: "提交作品", dueDate: "2026-10-10", completed: false },
    { id: "todo-soon", title: "比赛报名", dueDate: "2026-09-02", completed: false },
    { id: "todo-done", title: "已完成事项", dueDate: "2026-09-01", completed: true },
    { id: "todo-today", title: "今日事项", dueDate: "2026-08-30", completed: false },
    { id: "todo-overdue", title: "逾期事项", dueDate: "2026-08-29", completed: false },
    { id: "todo-invalid", title: "非法日期", dueDate: "2026-02-30", completed: false },
  ];
  const goals = [
    { id: "goal-exam", title: "六级备考", targetDate: "2026-11-28", status: "active" },
    { id: "goal-paused", title: "暂停但仍需关注", targetDate: "2026-09-15", status: "paused" },
    { id: "goal-done", title: "已完成目标", targetDate: "2026-09-05", status: "completed" },
    { id: "goal-without-date", title: "未设日期", targetDate: "", status: "active" },
  ];

  const entries = buildFutureHorizonEntries(items, goals, NOW);

  assert.deepEqual(entries, [
    { kind: "todo", id: "todo-soon", title: "比赛报名", dateKey: "2026-09-02", distance: 3 },
    { kind: "goal", id: "goal-paused", title: "暂停但仍需关注", dateKey: "2026-09-15", distance: 16 },
    { kind: "todo", id: "todo-later", title: "提交作品", dateKey: "2026-10-10", distance: 41 },
    { kind: "goal", id: "goal-exam", title: "六级备考", dateKey: "2026-11-28", distance: 90 },
  ]);
  assert.deepEqual(items[0], {
    id: "todo-later", title: "提交作品", dueDate: "2026-10-10", completed: false,
  });
});

test("时间地平线按 30 天、31 至 90 天和 90 天以上分桶", () => {
  const entries = [
    { kind: "todo", id: "d1", title: "一天", dateKey: "2026-08-31", distance: 1 },
    { kind: "todo", id: "d30", title: "三十天", dateKey: "2026-09-29", distance: 30 },
    { kind: "goal", id: "d31", title: "三十一天", dateKey: "2026-09-30", distance: 31 },
    { kind: "goal", id: "d90", title: "九十天", dateKey: "2026-11-28", distance: 90 },
    { kind: "goal", id: "d91", title: "九十一天", dateKey: "2026-11-29", distance: 91 },
  ];

  const buckets = bucketFutureHorizonEntries(entries);
  assert.deepEqual(buckets.within30Days.map((entry) => entry.id), ["d1", "d30"]);
  assert.deepEqual(buckets.within90Days.map((entry) => entry.id), ["d31", "d90"]);
  assert.deepEqual(buckets.beyond90Days.map((entry) => entry.id), ["d91"]);
  assert.deepEqual(bucketFutureHorizonEntries(null), {
    within30Days: [],
    within90Days: [],
    beyond90Days: [],
  });
});

test("时间戳始终按开始时间计算，未设或非法开始时间按全天事项处理", () => {
  assert.equal(
    dueTimestamp({ dueDate: "2026-08-31", dueTime: "09:00", dueEndTime: "11:00" }),
    new Date(2026, 7, 31, 9, 0, 0, 0).getTime(),
  );
  assert.equal(
    dueTimestamp({ dueDate: "2026-08-31", dueTime: "09:00", dueEndTime: "08:00" }),
    new Date(2026, 7, 31, 9, 0, 0, 0).getTime(),
  );
  const endOfDay = new Date(2026, 7, 31, 23, 59, 59, 999).getTime();
  assert.equal(dueTimestamp({ dueDate: "2026-08-31", dueTime: "", dueEndTime: "11:00" }), endOfDay);
  assert.equal(dueTimestamp({ dueDate: "2026-08-31", dueTime: "25:00", dueEndTime: "" }), endOfDay);
});

test("普通待办迁移时规范化时间点与同日时间段", () => {
  const migrated = migrateSnapshot({
    version: 4,
    items: [
      { id: "range", title: "深度工作", dueTime: "09:00", dueEndTime: "11:00" },
      { id: "point", title: "开会", dueTime: "14:00" },
      { id: "equal", title: "相同时间", dueTime: "15:00", dueEndTime: "15:00" },
      { id: "reverse", title: "逆序时间", dueTime: "16:00", dueEndTime: "15:30" },
      { id: "end-only", title: "仅结束时间", dueTime: "", dueEndTime: "18:00" },
      { id: "invalid", title: "非法时间", dueTime: "8:00", dueEndTime: "09:00" },
    ],
  }, NOW);

  assert.deepEqual(
    migrated.items.map(({ dueTime, dueEndTime }) => ({ dueTime, dueEndTime })),
    [
      { dueTime: "09:00", dueEndTime: "11:00" },
      { dueTime: "14:00", dueEndTime: "" },
      { dueTime: "15:00", dueEndTime: "" },
      { dueTime: "16:00", dueEndTime: "" },
      { dueTime: "", dueEndTime: "" },
      { dueTime: "", dueEndTime: "" },
    ],
  );
  assert.deepEqual(migrateSnapshot(migrated, NOW), migrated);
});

test("普通待办迁移时补齐重复规则并规范化逐日记录", () => {
  const migrated = migrateSnapshot({
    version: 5,
    items: [
      {
        id: "legacy",
        title: "旧的一次性事项",
        dueDate: "2026-08-31",
        completed: true,
        completedAt: 123,
        notified: true,
      },
      {
        id: "custom",
        title: "自定义日期",
        dueDate: "2026-08-30",
        schedule: "custom",
        weekdays: [6, 0, 2, 6, 7, "1", -1],
        subtasks: [
          { id: "read", title: "阅读", completed: false },
          { id: "write", title: "写作", completed: false },
        ],
        records: {
          "2026-08-30": {
            completed: true,
            completedAt: 456,
            subtasks: { read: true, write: false, removed: true },
          },
          "2026-09-01": {
            completed: false,
            completedAt: 789,
            subtasks: { write: true },
          },
          invalid: { completed: true, completedAt: 999, subtasks: { read: true } },
          "2026-09-06": true,
        },
        notifiedRecords: {
          "2026-08-30": true,
          "2026-09-01": false,
          invalid: true,
        },
      },
      {
        id: "invalid",
        title: "非法规则",
        dueDate: "2026-09-01",
        schedule: "weekly",
        weekdays: [2],
        records: [],
        notifiedRecords: [],
      },
    ],
  }, NOW);

  assert.deepEqual(
    migrated.items.map(({ schedule, weekdays }) => ({ schedule, weekdays })),
    [
      { schedule: "once", weekdays: [] },
      { schedule: "custom", weekdays: [0, 2, 6] },
      { schedule: "once", weekdays: [] },
    ],
  );
  assert.equal(migrated.items[0].completed, true);
  assert.equal(migrated.items[0].completedAt, 123);
  assert.equal(migrated.items[0].notified, true);
  assert.deepEqual(migrated.items[0].records, {});
  assert.deepEqual(migrated.items[0].notifiedRecords, {});
  assert.deepEqual(migrated.items[1].records, {
    "2026-08-30": {
      completed: true,
      completedAt: 456,
      subtasks: { read: true },
    },
    "2026-09-01": {
      completed: false,
      completedAt: null,
      subtasks: { write: true },
    },
  });
  assert.deepEqual(migrated.items[1].notifiedRecords, { "2026-08-30": true });
  assert.deepEqual(migrateSnapshot(migrated, NOW), migrated);
});

test("普通待办迁移时会补齐空 id 并修复重复 id", () => {
  const migrated = migrateSnapshot({
    version: 6,
    items: [
      { title: "缺少 id", dueDate: "2026-08-30" },
      { id: "same", title: "第一条", dueDate: "2026-08-30" },
      { id: "same", title: "第二条", dueDate: "2026-08-31" },
      { id: "  kept  ", title: "会去除空格", dueDate: "2026-09-01" },
    ],
  }, NOW);

  assert.deepEqual(migrated.items.map((item) => item.id), ["todo-0", "same", "todo-2", "kept"]);
  assert.equal(new Set(migrated.items.map((item) => item.id)).size, 4);
  assert.deepEqual(migrateSnapshot(migrated, NOW), migrated);
});

test("普通待办支持一次、每天、工作日和自定义星期", () => {
  const base = { dueDate: "2026-08-30" };

  assert.equal(todoOccursOnDate({ ...base, schedule: "once" }, "2026-08-29"), false);
  assert.equal(todoOccursOnDate({ ...base, schedule: "once" }, "2026-08-30"), true);
  assert.equal(todoOccursOnDate({ ...base, schedule: "once" }, "2026-08-31"), false);
  assert.equal(todoOccursOnDate({ ...base }, "2026-08-30"), true);
  assert.equal(todoOccursOnDate({ ...base }, "2026-08-31"), false);

  assert.equal(todoOccursOnDate({ ...base, schedule: "daily" }, "2026-08-29"), false);
  assert.equal(todoOccursOnDate({ ...base, schedule: "daily" }, "2026-08-30"), true);
  assert.equal(todoOccursOnDate({ ...base, schedule: "daily" }, "2026-09-01"), true);

  assert.equal(todoOccursOnDate({ ...base, schedule: "weekdays" }, "2026-08-30"), false);
  assert.equal(todoOccursOnDate({ ...base, schedule: "weekdays" }, "2026-08-31"), true);
  assert.equal(todoOccursOnDate({ ...base, schedule: "weekdays" }, "2026-09-05"), false);

  const custom = { ...base, schedule: "custom", weekdays: [0, 2, 0, 8] };
  assert.equal(todoOccursOnDate(custom, "2026-08-30"), true);
  assert.equal(todoOccursOnDate(custom, "2026-08-31"), false);
  assert.equal(todoOccursOnDate(custom, "2026-09-01"), true);
  assert.equal(todoOccursOnDate({ ...custom, dueDate: "2026-09-01" }, "2026-08-30"), false);
  assert.equal(todoOccursOnDate({ ...custom, weekdays: [] }, "2026-09-01"), false);
  assert.equal(todoOccursOnDate(custom, "2026-02-30"), false);
  assert.equal(todoOccursOnDate({ ...custom, dueDate: "invalid" }, "2026-09-01"), false);
});

test("迁移 v0.3 的三日数据", () => {
  const migrated = migrateSnapshot({
    itemsByDay: {
      today: [{ id: "a", title: "今天事项", time: "10:00", completed: false }],
      tomorrow: [{ id: "b", title: "明天事项", completed: false }],
      dayAfterTomorrow: [],
    },
    settings: { opacity: 0.7 },
  }, NOW);

  assert.equal(migrated.version, 6);
  assert.deepEqual(migrated.goals, []);
  assert.deepEqual(migrated.items.map((item) => item.dueDate), ["2026-08-30", "2026-08-31"]);
  assert.deepEqual(
    migrated.items.map(({ dueTime, dueEndTime }) => ({ dueTime, dueEndTime })),
    [
      { dueTime: "10:00", dueEndTime: "" },
      { dueTime: "", dueEndTime: "" },
    ],
  );
  assert.deepEqual(migrated.items.map((item) => item.subtasks), [[], []]);
  assert.equal(migrated.settings.opacity, 0.7);
  assert.equal(migrated.settings.alwaysOnTop, true);
});

test("旧版每日常驻待办迁移为每天重复并保留当天状态", () => {
  const migrated = migrateSnapshot({
    recurringItems: [
      { id: "habit", title: "拉伸", time: "07:30", completed: true, notified: true, createdAt: 100 },
    ],
  }, NOW);
  const [item] = migrated.items;

  assert.equal(item.title, "拉伸");
  assert.equal(item.detail, "");
  assert.equal(item.schedule, "daily");
  assert.deepEqual(item.weekdays, []);
  assert.equal(item.completed, false);
  assert.equal(item.notified, false);
  assert.equal(item.records["2026-08-30"].completed, true);
  assert.equal(typeof item.records["2026-08-30"].completedAt, "number");
  assert.deepEqual(item.records["2026-08-30"].subtasks, {});
  assert.deepEqual(item.notifiedRecords, { "2026-08-30": true });
  assert.equal(todoOccursOnDate(item, "2026-08-31"), true);
  assert.deepEqual(migrateSnapshot(migrated, NOW), migrated);
});

test("经 v0.5 中转的旧版每日待办会在 v6 恢复为每天重复", () => {
  const migrated = migrateSnapshot({
    version: 5,
    items: [{
      id: "legacy-v5-habit",
      title: "每日 · 复习单词",
      detail: "自定义过的说明",
      dueDate: "2026-08-29",
      dueTime: "07:30",
      completed: true,
      completedAt: 123456,
      notified: true,
      subtasks: [{ id: "words", title: "20 个单词", completed: true }],
      createdAt: 100,
    }],
  }, NOW);
  const [item] = migrated.items;

  assert.equal(migrated.version, 6);
  assert.equal(item.title, "复习单词");
  assert.equal(item.detail, "自定义过的说明");
  assert.equal(item.schedule, "daily");
  assert.equal(item.completed, false);
  assert.equal(item.notified, false);
  assert.deepEqual(item.records["2026-08-29"], {
    completed: true,
    completedAt: 123456,
    subtasks: { words: true },
  });
  assert.deepEqual(item.notifiedRecords, { "2026-08-29": true });
  assert.equal(todoOccursOnDate(item, "2026-08-30"), true);
  assert.deepEqual(migrateSnapshot(migrated, NOW), migrated);
});

test("迁移并规范化多条子待办", () => {
  const source = {
    version: 2,
    items: [
      {
        id: "parent",
        title: "发布产品方案",
        completed: false,
        subtasks: [
          { id: "step", title: "  确认数据  ", completed: true },
          { id: "step", title: "补充风险说明", completed: 0 },
          { title: "发送给项目组", completed: 1 },
          { title: "   ", completed: true },
          null,
        ],
      },
      { id: "without-children", title: "普通待办", completed: false },
    ],
  };

  const migrated = migrateSnapshot(source, NOW);
  assert.equal(migrated.version, 6);
  assert.deepEqual(migrated.items[0].subtasks, [
    { id: "step", title: "确认数据", completed: true },
    { id: "subtask-parent-1", title: "补充风险说明", completed: false },
    { id: "subtask-parent-2", title: "发送给项目组", completed: true },
  ]);
  assert.deepEqual(migrated.items[1].subtasks, []);
  assert.equal(source.items[0].subtasks[0].title, "  确认数据  ");
  assert.deepEqual(migrateSnapshot(migrated, NOW), migrated);
});

test("已完成父待办迁移时会补全其子待办", () => {
  const migrated = migrateSnapshot({
    version: 3,
    items: [{
      id: "done-parent",
      title: "已完成事项",
      completed: true,
      subtasks: [
        { id: "a", title: "步骤一", completed: false },
        { id: "b", title: "步骤二", completed: true },
      ],
    }],
  }, NOW);

  assert.deepEqual(migrated.items[0].subtasks.map((item) => item.completed), [true, true]);
});

test("迁移并规范化阶段目标、重复行动和完成记录", () => {
  const migrated = migrateSnapshot({
    version: 3,
    items: [],
    goals: [
      {
        id: "exam",
        title: "  六级备考  ",
        detail: "  每天稳定推进  ",
        targetDate: "2026-12-12",
        startDate: "not-a-date",
        status: "unknown",
        createdAt: 100,
        routines: [
          { id: "words", title: "  背单词  ", time: "07:30", endTime: "08:15", schedule: "daily", weekdays: [1] },
          {
            id: "words",
            title: "刷真题",
            time: "25:00",
            endTime: "09:30",
            schedule: "custom",
            weekdays: [6, 1, 1, 7, "2"],
            startDate: "2026-09-01",
            endDate: "2026-10-01",
          },
          { title: "  听力练习  ", time: "8:00", endTime: "09:00", schedule: "unsupported", startDate: "bad", endDate: "bad" },
          { id: "duplicate-title", title: "听力练习", time: "08:00", endTime: "08:00", schedule: "weekdays" },
          { id: "blank", title: "   ", schedule: "daily" },
          null,
        ],
        records: {
          "2026-08-30": {
            words: true,
            "routine-exam-1": true,
            "routine-exam-2": false,
            unknown: true,
          },
          "2026-08-31": { words: false },
          invalid: { words: true },
        },
        notifiedRecords: {
          "2026-08-30": { words: true, "routine-exam-1": false, unknown: true },
          "2026-08-31": { "routine-exam-1": true },
          invalid: { words: true },
        },
        pausePeriods: [
          { startDate: "2026-09-10", endDate: "2026-09-12" },
          { startDate: "2026-10-01" },
          { startDate: "invalid", endDate: "2026-10-02" },
        ],
      },
      {
        id: "exam",
        title: "另一个目标",
        targetDate: "2026-02-30",
        startDate: "2026-08-01",
        status: "completed",
        completedAt: null,
        routines: [],
      },
      { id: "blank-goal", title: "   ", routines: [] },
    ],
  }, NOW);

  assert.equal(migrated.version, 6);
  assert.equal(migrated.goals.length, 2);
  assert.deepEqual(migrated.goals[0], {
    id: "exam",
    title: "六级备考",
    detail: "每天稳定推进",
    targetDate: "2026-12-12",
    startDate: "2026-08-30",
    status: "active",
    completedAt: null,
    routines: [
      {
        id: "words", title: "背单词", time: "07:30", endTime: "08:15", schedule: "daily", weekdays: [], startDate: "2026-08-30", endDate: "",
      },
      {
        id: "routine-exam-1", title: "刷真题", time: "", endTime: "", schedule: "custom", weekdays: [1, 6], startDate: "2026-09-01", endDate: "2026-10-01",
      },
      {
        id: "routine-exam-2", title: "听力练习", time: "", endTime: "", schedule: "daily", weekdays: [], startDate: "2026-08-30", endDate: "",
      },
      {
        id: "duplicate-title", title: "听力练习", time: "08:00", endTime: "", schedule: "weekdays", weekdays: [], startDate: "2026-08-30", endDate: "",
      },
    ],
    records: {
      "2026-08-30": { words: true, "routine-exam-1": true },
    },
    notifiedRecords: {
      "2026-08-30": { words: true },
      "2026-08-31": { "routine-exam-1": true },
    },
    pausePeriods: [
      { startDate: "2026-09-10", endDate: "2026-09-12" },
      { startDate: "2026-10-01", endDate: "" },
    ],
    createdAt: 100,
  });
  assert.equal(migrated.goals[0].routines.filter((routine) => routine.title === "听力练习").length, 2);
  assert.equal(migrated.goals[1].id, "goal-1");
  assert.equal(migrated.goals[1].targetDate, "");
  assert.equal(migrated.goals[1].status, "completed");
  assert.equal(migrated.goals[1].completedAt, NOW.getTime());
  assert.deepEqual(migrateSnapshot(migrated, NOW), migrated);
});

test("重复行动支持每天、工作日和自定义星期", () => {
  const daily = { schedule: "daily" };
  const weekdays = { schedule: "weekdays" };
  const custom = { schedule: "custom", weekdays: [2, 0, 2, 9] };

  assert.equal(routineOccursOnDate(daily, "2026-08-30"), true);
  assert.equal(routineOccursOnDate(weekdays, "2026-08-30"), false);
  assert.equal(routineOccursOnDate(weekdays, "2026-08-31"), true);
  assert.equal(routineOccursOnDate(custom, "2026-08-30"), true);
  assert.equal(routineOccursOnDate(custom, "2026-08-31"), false);
  assert.equal(routineOccursOnDate(custom, "2026-09-01"), true);
  assert.equal(routineOccursOnDate({ schedule: "invalid" }, "2026-08-30"), true);
  assert.equal(routineOccursOnDate(daily, "2026-02-30"), false);
});

test("日期行动尊重目标起止日期但不抹掉暂停目标的历史", () => {
  const goal = {
    startDate: "2026-08-31",
    targetDate: "2026-09-02",
    status: "paused",
    routines: [
      { id: "daily", schedule: "daily" },
      { id: "weekday", schedule: "weekdays" },
    ],
  };

  assert.deepEqual(routinesForDate(goal, "2026-08-30"), []);
  assert.deepEqual(routinesForDate(goal, "2026-08-31").map((routine) => routine.id), ["daily", "weekday"]);
  assert.deepEqual(routinesForDate(goal, "2026-09-03"), []);
  assert.deepEqual(routinesForDate(null, "2026-08-31"), []);
});

test("每条重复行动可拥有独立的生效与结束日期", () => {
  const goal = {
    startDate: "2026-08-01",
    targetDate: "2026-12-12",
    routines: [
      { id: "phase-one", schedule: "daily", startDate: "2026-08-27", endDate: "2026-08-29" },
      { id: "ongoing", schedule: "daily", startDate: "2026-08-29", endDate: "" },
      { id: "fallback", schedule: "daily" },
    ],
  };

  assert.deepEqual(routinesForDate(goal, "2026-08-26").map((routine) => routine.id), ["fallback"]);
  assert.deepEqual(routinesForDate(goal, "2026-08-28").map((routine) => routine.id), ["phase-one", "fallback"]);
  assert.deepEqual(routinesForDate(goal, "2026-08-29").map((routine) => routine.id), ["phase-one", "ongoing", "fallback"]);
  assert.deepEqual(routinesForDate(goal, "2026-08-30").map((routine) => routine.id), ["ongoing", "fallback"]);
});

test("暂停区间按日期生效，开放区间会持续暂停", () => {
  const goal = {
    pausePeriods: [
      { startDate: "2026-08-26", endDate: "2026-08-27" },
      { startDate: "2026-08-29", endDate: "" },
      { startDate: "invalid", endDate: "" },
    ],
  };

  assert.equal(goalIsPausedOnDate(goal, "2026-08-25"), false);
  assert.equal(goalIsPausedOnDate(goal, "2026-08-26"), true);
  assert.equal(goalIsPausedOnDate(goal, "2026-08-27"), true);
  assert.equal(goalIsPausedOnDate(goal, "2026-08-28"), false);
  assert.equal(goalIsPausedOnDate(goal, "2026-08-30"), true);
  assert.equal(goalIsPausedOnDate(goal, "invalid"), false);
});

test("单日进度只将严格为 true 的计划内记录计为完成", () => {
  const goal = {
    startDate: "2026-08-01",
    targetDate: "2026-12-12",
    routines: [
      { id: "words", title: "背单词", schedule: "daily" },
      { id: "paper", title: "刷题", schedule: "weekdays" },
      { id: "sunday", title: "周复盘", schedule: "custom", weekdays: [0] },
    ],
    records: {
      "2026-08-31": { words: true, paper: 1, sunday: true, stale: true },
    },
  };

  const progress = goalProgressForDate(goal, "2026-08-31");
  assert.equal(progress.completed, 1);
  assert.equal(progress.total, 2);
  assert.equal(progress.remaining, 1);
  assert.equal(progress.ratio, 0.5);
  assert.equal(progress.isComplete, false);
  assert.deepEqual(progress.routines.map((routine) => routine.id), ["words", "paper"]);
});

test("周统计从周一累计到今天，并按目标起止日期裁剪", () => {
  const goal = {
    startDate: "2026-08-26",
    targetDate: "2026-08-29",
    routines: [
      { id: "daily", title: "背单词", schedule: "daily" },
      { id: "weekday", title: "刷题", schedule: "weekdays" },
      { id: "saturday", title: "模考", schedule: "custom", weekdays: [6] },
    ],
    records: {
      "2026-08-26": { daily: true, weekday: true },
      "2026-08-27": { daily: true },
      "2026-08-28": { daily: true, weekday: true },
      "2026-08-29": { daily: true, saturday: true },
      "2026-08-30": { daily: true },
    },
    pausePeriods: [
      { startDate: "2026-08-27", endDate: "2026-08-27" },
    ],
  };

  const stats = goalWeekStats(goal, NOW);
  assert.equal(stats.weekStart, "2026-08-24");
  assert.equal(stats.throughDate, "2026-08-29");
  assert.deepEqual(stats.days.map((day) => day.dateKey), [
    "2026-08-26",
    "2026-08-28",
    "2026-08-29",
  ]);
  assert.equal(stats.scheduledDays, 3);
  assert.equal(stats.completedDays, 3);
  assert.equal(stats.completed, 6);
  assert.equal(stats.total, 6);
  assert.equal(stats.remaining, 0);
  assert.equal(stats.ratio, 1);
  assert.deepEqual(goalWeekStats(goal, NOW), stats);

  assert.equal(goalWeekStats({ ...goal, targetDate: "2026-08-20" }, NOW).days.length, 0);
});

test("已完成目标的周统计截止到本地完成日并包含当天", () => {
  const goal = {
    startDate: "2026-08-01",
    targetDate: "2026-12-12",
    status: "completed",
    completedAt: new Date(2026, 7, 28, 15, 30).getTime(),
    routines: [{ id: "daily", title: "每日练习", schedule: "daily" }],
    records: {
      "2026-08-24": { daily: true },
      "2026-08-25": { daily: true },
      "2026-08-26": { daily: true },
      "2026-08-27": { daily: true },
      "2026-08-28": { daily: true },
      "2026-08-29": { daily: true },
    },
  };

  const stats = goalWeekStats(goal, NOW);
  assert.equal(stats.throughDate, "2026-08-28");
  assert.deepEqual(stats.days.map((day) => day.dateKey), [
    "2026-08-24",
    "2026-08-25",
    "2026-08-26",
    "2026-08-27",
    "2026-08-28",
  ]);
  assert.equal(stats.total, 5);
  assert.equal(stats.completed, 5);
});
