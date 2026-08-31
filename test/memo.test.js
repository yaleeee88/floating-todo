import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const projectUrl = new URL("../", import.meta.url);

async function source(path) {
  return readFile(new URL(path, projectUrl), "utf8");
}

test("the memo is a lazy standalone WebView instead of a startup window", async () => {
  const config = JSON.parse(await source("src-tauri/tauri.conf.json"));
  const backend = await source("src-tauri/src/lib.rs");

  assert.deepEqual(config.app.windows.map(({ label }) => label), ["main"]);
  assert.match(backend, /async fn open_memo_window/);
  assert.match(backend, /WebviewUrl::App\("memo\.html"\.into\(\)\)/);
  assert.match(backend, /\.visible\(false\)/);
  assert.match(backend, /\.general_autofill_enabled\(false\)/);
  assert.match(backend, /\.browser_extensions_enabled\(false\)/);
  assert.match(backend, /\.prevent_overflow\(\)/);
  assert.match(backend, /get_webview_window\(MEMO_WINDOW_LABEL\)/);
});

test("the memo surface stays focused on one input and one close action", async () => {
  const html = await source("src/memo.html");
  const css = await source("src/memo.css");

  assert.equal((html.match(/<textarea\b/g) || []).length, 1);
  assert.equal((html.match(/<button\b/g) || []).length, 1);
  assert.doesNotMatch(html, /main\.js|styles\.css/);
  assert.doesNotMatch(css, /backdrop-filter|\bfilter\s*:/);
});

test("memo content and geometry are saved and closing releases its WebView", async () => {
  const memo = await source("src/memo.js");

  assert.match(memo, /floating-todo\/memo-v1/);
  assert.match(memo, /floating-todo\/memo-window-state-v1/);
  assert.match(memo, /setTimeout\(persistMemo/);
  assert.match(memo, /pagehide/);
  assert.match(memo, /await notifyMain\(false\)/);
  assert.match(memo, /await appWindow\.destroy\(\)/);
  assert.match(memo, /window\.close\(\)/);
  assert.match(memo, /memo-data-imported/);
});

test("the main panel exposes and tracks the memo entry", async () => {
  const main = await source("src/main.js");
  const styles = await source("src/styles.css");

  assert.match(main, /data-act="memo"/);
  assert.match(main, /invoke\("open_memo_window"\)/);
  assert.match(main, /memo-state-changed/);
  assert.match(main, /onMemoWindowMessage/);
  assert.match(styles, /\.compact \.icon-btn:not\(\.memo-entry\)/);
});

test("main and memo WebViews enter the low-memory target when unfocused", async () => {
  const backend = await source("src-tauri/src/lib.rs");

  assert.match(backend, /WindowEvent::Focused\(focused\)/);
  assert.match(backend, /set_webview_memory_usage\(&webview_window, !\*focused\)/);
  assert.match(backend, /COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW/);
});
