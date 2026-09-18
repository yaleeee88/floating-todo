// Run with: node scripts/verify-memo.mjs [absolute path to playwright/index.mjs]
// Uses an isolated browser profile and local storage, never the installed app's data.
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
    const file = new URL(`.${path}`, root);
    const content = await readFile(file);
    response.setHeader("Content-Type", path.endsWith(".js") ? "text/javascript" : path.endsWith(".css") ? "text/css" : "text/html");
    response.end(content);
  } catch { response.writeHead(404).end(); }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const browser = await chromium.launch({ channel: "msedge", headless: true });
try {
  const context = await browser.newContext({ viewport: { width: 338, height: 210 } });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() => {
    window.pinCalls = [];
    window.__TAURI__ = { window: { getCurrentWindow: () => ({
      setAlwaysOnTop: async (value) => {
        if (window.failPin) throw new Error("Simulated window failure");
        window.pinCalls.push(value);
      },
      show: async () => {}, setFocus: async () => {}, destroy: async () => { window.destroyed = true; },
    }) } };
    if (!localStorage.getItem("seeded")) {
      localStorage.setItem("floating-todo/memo-v1", "旧内容 <b>原样保留</b>\n\n第二行");
      localStorage.setItem("seeded", "true");
    }
  });
  const url = `http://127.0.0.1:${server.address().port}/memo.html`;
  const ready = async () => page.waitForFunction(() => document.body.classList.contains("ready"));
  const stored = async () => {
    await page.evaluate(() => window.dispatchEvent(new Event("blur")));
    return page.evaluate(() => JSON.parse(localStorage.getItem("floating-todo/memo-v2")));
  };
  const select = async (start, end) => page.evaluate(({ start, end }) => {
    const editor = document.getElementById("memoInput");
    editor.focus();
    const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT);
    const points = [];
    let offset = 0, node;
    while ((node = walker.nextNode())) { points.push({ node, start: offset, end: offset + node.length }); offset += node.length; }
    const a = points.find((part) => start >= part.start && start <= part.end);
    const b = points.find((part) => end >= part.start && end <= part.end);
    const range = document.createRange();
    range.setStart(a.node, start - a.start);
    range.setEnd(b.node, end - b.start);
    getSelection().removeAllRanges(); getSelection().addRange(range);
  }, { start, end });
  await page.goto(url);
  await ready();
  assert.equal(await page.locator("#memoInput").textContent(), "旧内容 <b>原样保留</b>\n\n第二行");
  assert.deepEqual(await page.evaluate(() => window.pinCalls), [true]);
  await page.locator("#memoInput").fill("考试报名材料\n每天背单词");
  await select(2, 4);
  await page.keyboard.press("Control+b");
  assert.deepEqual((await stored()).bold, [{ start: 2, end: 4 }]);
  await page.keyboard.press("Control+z");
  assert.deepEqual((await stored()).bold, []);
  await select(0, 2);
  await page.locator("#memoBold").click();
  assert.deepEqual((await stored()).bold, [{ start: 0, end: 2 }]);
  await page.keyboard.press("Control+=");
  await page.keyboard.press("Control+Shift+=");
  assert.equal((await stored()).fontSize, 15);
  assert.equal(await page.locator("#memoInput").evaluate((e) => getComputedStyle(e).fontSize), "15px");
  assert.equal(await page.evaluate(() => visualViewport.scale), 1);
  await page.keyboard.press("Control+-");
  assert.equal((await stored()).fontSize, 14);
  await page.locator("#memoPin").click();
  assert.equal((await stored()).pinned, false);
  await page.reload(); await ready();
  assert.deepEqual(await page.evaluate(() => window.pinCalls), [false]);
  assert.equal(await page.locator("#memoPin").getAttribute("aria-pressed"), "false");
  assert.deepEqual((await stored()).bold, [{ start: 0, end: 2 }]);
  assert.equal((await stored()).fontSize, 14);
  await page.evaluate(() => { window.failPin = true; });
  await page.locator("#memoPin").click();
  assert.equal((await stored()).pinned, false);
  assert.equal(await page.locator("#memoPin").getAttribute("aria-pressed"), "false");
  await page.evaluate(() => { window.failPin = false; });
  await page.keyboard.press("Control+0");
  assert.equal((await stored()).fontSize, 13);

  // Newlines, empty lines, native paragraph markup, pasted text, and safe rendering.
  await page.locator("#memoInput").fill("第一行");
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter");
  await page.keyboard.insertText("第三行");
  await page.keyboard.press("Enter");
  assert.equal((await stored()).text, "第一行\n\n第三行\n", await page.locator("#memoInput").innerHTML());
  await page.reload(); await ready();
  assert.equal((await stored()).text, "第一行\n\n第三行\n");
  await page.locator("#memoInput").click();
  await page.keyboard.press("Control+End");
  await page.keyboard.insertText("末行");
  await page.keyboard.press("Shift+Enter");
  await page.keyboard.insertText("继续");
  assert.equal((await stored()).text, "第一行\n\n第三行\n末行\n继续");
  await page.keyboard.press("Shift+Enter");
  assert.equal((await stored()).text, "第一行\n\n第三行\n末行\n继续\n");
  const domCases = await page.evaluate(async () => {
    const { serializeMemoEditor, renderMemoDocument, normalizeMemoDocument } = await import("./memo-document.js");
    const editor = document.createElement("div");
    const cases = [
      ["<div>a</div><div><br></div><div>b</div>", "a\n\nb"],
      ["a<div>b</div><div><br></div>", "a\nb\n"],
      ["<b>ab</b>cd<br>ef", "abcd\nef"],
      ["<div><br></div><div>b</div>", "\nb"],
    ];
    const results = cases.map(([html, expected]) => { editor.innerHTML = html; return { expected, actual: serializeMemoEditor(editor, {}).text }; });
    renderMemoDocument(editor, normalizeMemoDocument({ text: '<img src=x onerror="alert(1)">', bold: [{ start: 0, end: 4 }] }));
    return { results, images: editor.querySelectorAll("img").length, text: editor.textContent };
  });
  for (const { expected, actual } of domCases.results) assert.equal(actual, expected);
  assert.equal(domCases.images, 0);
  await page.locator("#memoInput").fill("");
  await page.locator("#memoInput").evaluate((editor) => {
    editor.focus();
    const clipboardData = new DataTransfer();
    clipboardData.setData("text/plain", "粘贴\n\n原文 <b>不是标记</b>");
    clipboardData.setData("text/html", '<img src=x onerror="window.unsafePaste=true">');
    editor.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData }));
  });
  assert.equal((await stored()).text, "粘贴\n\n原文 <b>不是标记</b>", await page.locator("#memoInput").innerHTML());
  assert.equal(await page.evaluate(() => !!window.unsafePaste), false);
  await page.keyboard.press("Control+a");
  await page.keyboard.press("Backspace");
  assert.equal((await stored()).text, "");

  await page.locator("#memoInput").fill("周五前提交报名材料\n记得检查身份证与准考证\n\n每日阅读，保持节奏。");
  await select(0, 10); await page.locator("#memoBold").click();
  await page.locator("#memoPin").click();
  await page.keyboard.press("Control+=");
  await page.keyboard.press("Control+=");
  for (const theme of ["light", "dark"]) {
    await page.evaluate((theme) => { document.documentElement.dataset.theme = theme; document.getElementById("memoStatus").textContent = ""; getSelection().removeAllRanges(); }, theme);
    for (const [width, height] of [[260, 150], [338, 210], [500, 420]]) {
      await page.setViewportSize({ width, height });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      for (const id of ["memoBold", "memoPin", "memoClose"]) {
        const box = await page.locator(`#${id}`).boundingBox();
        assert.ok(box.x >= 0 && box.x + box.width <= width);
      }
      if (width === 338 && process.env.MEMO_SCREENSHOT_DIR) {
        await page.screenshot({ path: `${process.env.MEMO_SCREENSHOT_DIR}/memo-${theme}.png` });
      }
    }
  }
  await page.locator("#memoClose").click();
  assert.equal(await page.evaluate(() => window.destroyed), true);
  assert.equal((await stored()).pinned, true);
  assert.deepEqual(errors, []);
  console.log("Memo browser checks passed: migration, pin/rollback, bold/undo, font shortcuts, reload, multiline/paste, safe text, empty note, compact/light/dark layout, close/save.");
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
