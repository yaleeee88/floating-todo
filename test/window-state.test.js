import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  isWindowPositionVisible,
  normalizeWindowState,
  WINDOW_LIMITS,
} from "../src/window-state.js";

test("窗口状态边界与 Tauri 窗口配置保持一致", () => {
  const config = JSON.parse(readFileSync(new URL("../src-tauri/tauri.conf.json", import.meta.url), "utf8"));
  const windowConfig = config.app.windows.find((entry) => entry.label === "main");
  assert.deepEqual({
    minWidth: windowConfig.minWidth,
    minHeight: windowConfig.minHeight,
    maxWidth: windowConfig.maxWidth,
    maxHeight: windowConfig.maxHeight,
    defaultWidth: windowConfig.width,
    defaultHeight: windowConfig.height,
  }, WINDOW_LIMITS);
});

test("窗口状态会被限制在应用允许的尺寸范围内", () => {
  assert.deepEqual(normalizeWindowState({
    width: 100,
    height: 2000,
    x: -125.4,
    y: 82.6,
    expandedWidth: 1200,
    expandedHeight: 20,
  }), {
    width: WINDOW_LIMITS.minWidth,
    height: WINDOW_LIMITS.maxHeight,
    x: -125,
    y: 83,
    expandedWidth: WINDOW_LIMITS.maxWidth,
    expandedHeight: WINDOW_LIMITS.minHeight,
  });
  assert.equal(normalizeWindowState(null), null);
  assert.equal(normalizeWindowState({ width: null, height: 650 }), null);
  assert.equal(normalizeWindowState({ width: "bad", height: 650 }), null);
});

test("窗口状态仅保留严格的 compact 布尔值", () => {
  assert.deepEqual(normalizeWindowState({ width: 390, height: 650, compact: true }), {
    width: 390,
    height: 650,
    compact: true,
  });
  assert.deepEqual(normalizeWindowState({ width: 390, height: 650, compact: false }), {
    width: 390,
    height: 650,
    compact: false,
  });
  assert.deepEqual(normalizeWindowState({ width: 390, height: 650, compact: "true" }), {
    width: 390,
    height: 650,
  });
  assert.deepEqual(normalizeWindowState({ width: 390, height: 650 }), {
    width: 390,
    height: 650,
  });
});

test("窗口位置仅在仍有可操作区域位于显示器内时恢复", () => {
  const monitors = [
    { position: { x: 0, y: 0 }, size: { width: 1920, height: 1080 }, scaleFactor: 1 },
    { position: { x: -2560, y: 0 }, size: { width: 2560, height: 1440 }, scaleFactor: 1.25 },
  ];

  assert.equal(isWindowPositionVisible({ width: 390, height: 650, x: 100, y: 80 }, monitors), true);
  assert.equal(isWindowPositionVisible({ width: 390, height: 650, x: -1800, y: 100 }, monitors), true);
  assert.equal(isWindowPositionVisible({ width: 390, height: 650, x: 100, y: -620 }, monitors), false);
  assert.equal(isWindowPositionVisible({ width: 390, height: 650, x: 4000, y: 100 }, monitors), false);
  assert.equal(isWindowPositionVisible({ width: 390, height: 650 }, monitors), false);

  const taskbarMonitor = [{
    position: { x: 0, y: 0 },
    size: { width: 1920, height: 1080 },
    workArea: { position: { x: 0, y: 0 }, size: { width: 1920, height: 1040 } },
    scaleFactor: 1,
  }];
  assert.equal(isWindowPositionVisible({ width: 390, height: 650, x: 100, y: 1030 }, taskbarMonitor), false);
});
