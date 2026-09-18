// Compare working tree with a release: node scripts/benchmark-performance.mjs [playwright path] [git ref]
// Synthetic data and isolated profiles only; timings are JS/DOM work, NOT native process memory.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { pathToFileURL, fileURLToPath } from "node:url";
const { chromium } = await import(process.argv[2] ? pathToFileURL(process.argv[2]).href : "playwright");
const root = new URL("../", import.meta.url);
const ref = process.argv[3];
if (ref && !/^[a-zA-Z0-9._/-]+$/.test(ref)) throw new Error("Invalid git ref");
const sources = new Map();
const server = createServer(async (request, response) => {
  try {
    const path = new URL(request.url, "http://localhost").pathname;
    if (path === "/favicon.ico") { response.writeHead(404).end(); return; }
    if (!/^\/[\w.-]+$/.test(path)) throw new Error("Invalid path");
    if (!sources.has(path)) sources.set(path, ref
      ? execFileSync("git", ["show", `${ref}:src${path}`], { cwd: fileURLToPath(root), encoding: "utf8" })
      : await readFile(new URL(`src${path}`, root), "utf8"));
    let source = sources.get(path);
    if (path === "/main.js") source += "\nwindow.auditMain={state,render,save,toggleTodo,switchMainView};";
    response.setHeader("Content-Type", path.endsWith(".js") ? "text/javascript" : path.endsWith(".css") ? "text/css" : "text/html");
    response.end(source);
  } catch { response.writeHead(404).end(); }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const browser = await chromium.launch({ channel: "msedge", headless: true });
try {
  const context = await browser.newContext({ viewport: { width: 390, height: 650 } });
  await context.addInitScript(() => {
    window.metrics = { writes: {}, parses: 0, parseCharacters: 0 };
    const set = Storage.prototype.setItem;
    Storage.prototype.setItem = function(key, value) {
      window.metrics.writes[key] = (window.metrics.writes[key] || 0) + 1;
      return set.call(this, key, value);
    };
    const parse = JSON.parse;
    JSON.parse = function(value, ...args) {
      window.metrics.parses++; window.metrics.parseCharacters += typeof value === "string" ? value.length : 0;
      return parse.call(this, value, ...args);
    };
  });
  const page = await context.newPage();
  const base = `http://127.0.0.1:${server.address().port}/`;
  await page.goto(base + "index.html");
  await page.waitForFunction(() => !!window.auditMain);
  await page.evaluate(async () => {
    const { migrateSnapshot, toDateKey, addDays } = await import("./domain.js");
    const today = toDateKey();
    Object.assign(window.auditMain.state, migrateSnapshot({ version: 6,
      items: Array.from({ length: 12 }, (_, i) => ({ id: `test-${i}`, title: `测试待办 ${i}`, dueDate: today, completed: false })),
      goals: Array.from({ length: 8 }, (_, i) => ({ id: `goal-${i}`, title: `阶段计划 ${i}`, status: "active", startDate: addDays(today, -365), targetDate: addDays(today, 60 + i),
        routines: [{ id: "routine", title: "今日重复行动", schedule: "daily" }],
        records: Object.fromEntries(Array.from({ length: 365 }, (_, j) => [addDays(today, -j), { routine: true }])) })),
    }));
    window.auditMain.save(); window.auditMain.render();
    localStorage.setItem("floating-todo/memo-v2", JSON.stringify({ version: 2, text: "备忘录内容".repeat(200), bold: [{ start: 0, end: 20 }], fontSize: 13, pinned: true }));
  });
  const memo = await context.newPage();
  await memo.goto(base + "memo.html");
  await memo.waitForFunction(() => document.body.classList.contains("ready"));
  const reset = (target) => target.evaluate(() => { window.metrics = { writes: {}, parses: 0, parseCharacters: 0 }; });
  const output = { source: ref || "working-tree" };
  await reset(memo);
  output.unchangedBlur = await memo.evaluate(() => {
    for (let i = 0; i < 20; i++) window.dispatchEvent(new Event("blur"));
    return window.metrics;
  });
  await reset(memo);
  for (let i = 0; i < 10; i++) { await page.evaluate(() => window.auditMain.toggleTodo("test-0")); await memo.waitForTimeout(25); }
  output.memoParsesAfter10TodoToggles = await memo.evaluate(() => window.metrics);
  await reset(page);
  await memo.locator("#memoInput").focus(); await memo.keyboard.press("Control+End");
  await memo.keyboard.type("abcdefghijklmnopqrst", { delay: 75 }); await memo.waitForTimeout(250);
  output.mainParsesDuringMemoTyping = await page.evaluate(() => window.metrics);
  await page.bringToFront();
  output.domRetention = await page.evaluate(() => {
    const app = document.getElementById("app");
    const nodes = [...app.querySelectorAll("*")];
    window.auditMain.toggleTodo("test-0");
    return { before: nodes.length, retained: nodes.filter((node) => app.contains(node)).length };
  });
  output.toggleMedianMs = await page.evaluate(async () => {
    const times = [];
    for (let i = 0; i < 30; i++) {
      await new Promise(requestAnimationFrame);
      const start = performance.now(); window.auditMain.toggleTodo("test-0");
      times.push(performance.now() - start);
    }
    times.sort((a, b) => a - b); return times[15];
  });
  output.history = [];
  for (const count of [0, 1000, 10000]) output.history.push(await page.evaluate(async (count) => {
    const { toDateKey } = await import("./domain.js");
    const a = window.auditMain;
    a.state.items = a.state.items.filter((item) => !item.id.startsWith("history-"));
    for (let i = 0; i < count; i++) a.state.items.push({ id: `history-${i}`, title: "历史完成项", dueDate: toDateKey(), completed: true, completedAt: Date.now() - i, createdAt: i, subtasks: [], schedule: "once" });
    a.switchMainView("list");
    const times = [];
    for (let i = 0; i < 30; i++) {
      await new Promise(requestAnimationFrame);
      const start = performance.now(); a.render(); times.push(performance.now() - start);
    }
    times.sort((a, b) => a - b);
    return { completedItems: count, medianRenderMs: times[15], renderedRows: document.querySelectorAll(".todo-row").length };
  }, count));
  console.log(JSON.stringify(output, null, 2));
} finally { await browser.close(); await new Promise((resolve) => server.close(resolve)); }
