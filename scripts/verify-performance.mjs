// Isolated browser regression checks; never connects to the installed app/profile.
// node scripts/verify-performance.mjs [absolute path to playwright/index.mjs]
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
const { chromium } = await import(process.argv[2] ? pathToFileURL(process.argv[2]).href : "playwright");
const root = new URL("../src/", import.meta.url);
const server = createServer(async (request, response) => {
  try {
    const path = new URL(request.url, "http://localhost").pathname;
    if (!/^\/[\w.-]+$/.test(path)) throw new Error("Invalid path");
    let source = await readFile(new URL(`.${path}`, root), "utf8");
    if (path === "/main.js") source += "\nwindow.auditMain={state,render,save,toggleTodo,toggleExpanded,toggleSubtask,toggleGoalRoutine,switchMainView,openEditor};";
    response.setHeader("Content-Type", path.endsWith(".js") ? "text/javascript" : path.endsWith(".css") ? "text/css" : "text/html");
    response.end(source);
  } catch { response.writeHead(404).end(); }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const browser = await chromium.launch({ channel: "msedge", headless: true });
try {
  const context = await browser.newContext({ viewport: { width: 480, height: 700 } });
  const errors = [];
  context.on("page", (page) => page.on("pageerror", (error) => errors.push(error.message)));
  await context.addInitScript(() => {
    window.metrics = { writes: {}, parses: 0, walks: 0 };
    const setItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function(key, value) {
      if (window.failMemoWrite && key === "floating-todo/memo-v2") throw new Error("Simulated quota failure");
      window.metrics.writes[key] = (window.metrics.writes[key] || 0) + 1;
      return setItem.call(this, key, value);
    };
    const parse = JSON.parse;
    JSON.parse = function(...args) { window.metrics.parses++; return parse(...args); };
  });
  const base = `http://127.0.0.1:${server.address().port}/`;
  const page = await context.newPage();
  await page.goto(base + "index.html");
  await page.waitForFunction(() => !!window.auditMain);
  await page.evaluate(async () => {
    const { migrateSnapshot, toDateKey, addDays } = await import("./domain.js");
    const today = toDateKey();
    const state = migrateSnapshot({ version: 6,
      items: [
        ...Array.from({ length: 12 }, (_, id) => ({ id: `task-${id}`, title: `行动 ${id}`, dueDate: today, subtasks: [{ id: "sub", title: "步骤" }], detail: "详情" })),
        ...Array.from({ length: 80 }, (_, id) => ({ id: `history-${id}`, title: "已完成事项", dueDate: today, completed: true, completedAt: id })),
        { id: "future", title: "考试节点", dueDate: addDays(today, 40) },
      ],
      goals: [{ id: "goal", title: "目标", startDate: today, targetDate: addDays(today, 90), routines: [{ id: "routine", title: "每天练习", schedule: "daily" }] }],
    });
    Object.assign(window.auditMain.state, state);
    window.auditMain.save(); window.auditMain.render();
    localStorage.setItem("floating-todo/memo-v2", JSON.stringify({ version: 2, text: "已保存便签", bold: [], fontSize: 13, pinned: true }));
  });
  const memo = await context.newPage();
  await memo.goto(base + "memo.html");
  await memo.waitForFunction(() => document.body.classList.contains("ready"));
  const editor = memo.locator("#memoInput");
  const reset = (target) => target.evaluate(() => { window.metrics = { writes: {}, parses: 0, walks: 0 }; });
  // Count serialization by intercepting the editor.childNodes walk (not selection updates).
  await memo.evaluate(() => {
    const input = document.getElementById("memoInput");
    const getter = Object.getOwnPropertyDescriptor(Node.prototype, "childNodes").get;
    Object.defineProperty(input, "childNodes", { get() { window.metrics.walks++; return getter.call(this); } });
  });
  await reset(memo);
  await memo.evaluate(() => { for (let i = 0; i < 20; i++) window.dispatchEvent(new Event("blur")); });
  const unchanged = await memo.evaluate(() => window.metrics);
  assert.equal(unchanged.writes["floating-todo/memo-v2"] || 0, 0);
  assert.equal(unchanged.walks, 0);
  for (let i = 0; i < 10; i++) await page.evaluate(() => window.auditMain.toggleTodo("task-0"));
  await memo.waitForTimeout(100);
  assert.equal(await memo.evaluate(() => window.metrics.parses), 0);
  await reset(page);
  await editor.focus(); await memo.keyboard.press("Control+End");
  await memo.keyboard.type("abcdefghijklmnopqrst", { delay: 75 });
  await memo.waitForTimeout(250);
  assert.equal(await page.evaluate(() => window.metrics.parses), 0);
  assert.match(await memo.evaluate(() => JSON.parse(localStorage.getItem("floating-todo/memo-v2")).text), /abcdefghijklmnopqrst$/);
  await reset(memo);
  await memo.keyboard.press("Control+=");
  assert.equal(await memo.evaluate(() => window.metrics.walks), 0, "font changes must not serialize unchanged text");
  assert.equal(await memo.evaluate(() => window.metrics.writes["floating-todo/memo-v2"]), 1);
  // Presence signals, theme signals, retry after failure, composition and immediate blur.
  await editor.fill(""); await memo.evaluate(() => window.dispatchEvent(new Event("blur")));
  await page.waitForFunction(() => document.querySelector('[data-act="memo"]').title === "新建备忘录");
  await editor.fill("恢复文字"); await memo.evaluate(() => window.dispatchEvent(new Event("blur")));
  await page.waitForFunction(() => document.querySelector('[data-act="memo"]').title === "打开备忘录");
  await page.evaluate(() => { window.auditMain.state.settings.appearance = "dark"; window.auditMain.save(); window.auditMain.render(); });
  await memo.waitForFunction(() => document.documentElement.dataset.theme === "dark");
  await memo.evaluate(() => { window.failMemoWrite = true; });
  await editor.fill("失败后不能丢失"); await memo.evaluate(() => window.dispatchEvent(new Event("blur")));
  assert.equal(await memo.evaluate(() => JSON.parse(localStorage.getItem("floating-todo/memo-v2")).text), "恢复文字");
  assert.match(await memo.locator("#memoStatus").textContent(), /保存失败/);
  await memo.evaluate(() => { window.failMemoWrite = false; window.dispatchEvent(new Event("blur")); });
  assert.equal(await memo.evaluate(() => JSON.parse(localStorage.getItem("floating-todo/memo-v2")).text), "失败后不能丢失");
  await memo.evaluate(() => {
    const input = document.getElementById("memoInput");
    input.dispatchEvent(new CompositionEvent("compositionstart"));
    input.textContent = "输入法完成";
    input.dispatchEvent(new InputEvent("input", { isComposing: true }));
    input.dispatchEvent(new CompositionEvent("compositionend"));
    window.dispatchEvent(new Event("blur"));
  });
  assert.equal(await memo.evaluate(() => JSON.parse(localStorage.getItem("floating-todo/memo-v2")).text), "输入法完成");
  await memo.reload(); await memo.waitForFunction(() => document.body.classList.contains("ready"));
  assert.equal(await editor.textContent(), "输入法完成");

  // Main panel keeps unchanged nodes, animations, focus and scroll position.
  await page.bringToFront();
  const retention = await page.evaluate(() => {
    const root = document.getElementById("app");
    const before = [...root.querySelectorAll("*")];
    const header = root.querySelector("header");
    const horizon = root.querySelector(".horizon-card");
    window.auditMain.toggleTodo("task-0");
    return { total: before.length, retained: before.filter((node) => root.contains(node)).length,
      header: header === root.querySelector("header"), horizon: horizon === root.querySelector(".horizon-card") };
  });
  assert.ok(retention.retained > retention.total * 0.8);
  assert.ok(retention.header && retention.horizon);
  await page.evaluate(() => window.auditMain.switchMainView("list"));
  assert.equal(await page.locator("article.todo-row.done").count(), 16);
  const ordering = await page.locator("article.todo-row.done").evaluateAll((rows) => rows.map((row) => row.dataset.id));
  assert.equal(ordering[0], "task-0");
  assert.equal(ordering[1], "history-79");
  await page.locator('[data-act="completed-overflow"]').click();
  assert.equal(await page.locator("article.todo-row.done").count(), 81);
  await page.locator('[data-act="completed-overflow"]').click();
  assert.equal(await page.locator("article.todo-row.done").count(), 16);
  const effects = await page.evaluate(() => {
    const a = window.auditMain;
    const row = document.querySelector('article[data-id="task-1"]');
    const main = document.querySelector("main");
    const control = row.querySelector('[data-act="expand"]');
    control.focus({ preventScroll: true });
    main.scrollTo({ top: 50, behavior: "instant" });
    const scroll = main.scrollTop;
    a.toggleExpanded("task-1");
    const expanded = row.querySelector(".todo-expanded");
    const result = { row: row === document.querySelector('article[data-id="task-1"]'),
      focus: document.activeElement === control, scroll: main.scrollTop === scroll,
      reveal: getComputedStyle(expanded).animationName };
    a.toggleSubtask("task-1", "sub");
    result.check = getComputedStyle(row.querySelector(".subtask-check")).animationName;
    result.state = getComputedStyle(row).animationName;
    return result;
  });
  assert.deepEqual(effects, { row: true, focus: true, scroll: true, reveal: "reveal", check: "check-pop", state: "state-settle" });
  await page.waitForFunction(() => !document.querySelector(".motion-state-change,.motion-check-pop,.motion-reveal"));
  await page.evaluate(() => { window.auditMain.toggleSubtask("task-1", "sub"); window.auditMain.toggleSubtask("task-1", "sub"); });
  assert.equal(await page.locator('article[data-id="task-1"] .subtask-check').evaluate((node) => getComputedStyle(node).animationName), "check-pop");
  await page.evaluate(() => window.auditMain.toggleGoalRoutine("goal", "routine"));
  assert.equal(await page.locator('[data-act="goal-routine-toggle"][data-id="goal"]').getAttribute("aria-checked"), "true");
  await page.evaluate(() => window.auditMain.switchMainView("overview"));
  assert.equal(await page.locator("main").evaluate((node) => getComputedStyle(node).animationName), "view-enter");
  for (const [width, height] of [[280, 220], [480, 700], [1100, 850], [480, 700]]) {
    await page.setViewportSize({ width, height });
    await page.waitForTimeout(100);
    assert.equal(await page.locator("#app > main").count(), 1);
    assert.equal(await page.locator("#app > header").count(), 1);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  }
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.evaluate(() => window.auditMain.switchMainView("list"));
  await page.waitForTimeout(250);
  assert.equal(await page.locator("main").evaluate((node) => getComputedStyle(node).animationName), "none");

  // Renderer keys preserve identities through reorder/removal/insertion and tag changes.
  const patchResult = await page.evaluate(async () => {
    const { updateRegions } = await import("./patch-dom.js");
    const fixture = document.createElement("div");
    const region = (key, text = key, tag = "div") => ({ key, html: `<${tag}>${text}</${tag}>` });
    updateRegions(fixture, [region("a"), region("b"), region("c")]);
    const [a, b, c] = fixture.children;
    updateRegions(fixture, [region("c"), region("b", "changed"), region("d")]);
    const identities = fixture.children[0] === c && fixture.children[1] === b && !fixture.contains(a);
    updateRegions(fixture, [region("b", "button", "button"), region("c")]);
    return { identities, tags: [...fixture.children].map((node) => node.tagName), text: fixture.textContent };
  });
  assert.deepEqual(patchResult, { identities: true, tags: ["BUTTON", "DIV"], text: "buttonc" });
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ result: "Performance regressions passed", unchangedBlur: unchanged, domRetention: retention, effects }, null, 2));
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
