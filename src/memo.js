"use strict";

const TAURI = window.__TAURI__;
const appWindow = TAURI?.window?.getCurrentWindow?.();

const MEMO_KEY = "floating-todo/memo-v1";
const WINDOW_STATE_KEY = "floating-todo/memo-window-state-v1";
const SNAPSHOT_KEY = "floating-todo/snapshot";
const SAVE_INTERVAL = 220;
const WINDOW_LIMITS = Object.freeze({
  minWidth: 260,
  minHeight: 150,
  maxWidth: 500,
  maxHeight: 420,
});

const memoInput = document.getElementById("memoInput");
const closeButton = document.getElementById("memoClose");

let textSaveTimer = null;
let geometrySaveTimer = null;
let lastTextSaveAt = 0;
let rememberedGeometry = readWindowGeometry();
let closing = false;
const unlisteners = [];

function finiteNumber(value) {
  if (value === null || value === "" || typeof value === "boolean") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function normalizeWindowGeometry(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const width = finiteNumber(value.width);
  const height = finiteNumber(value.height);
  if (width === null || height === null) return null;

  const normalized = {
    width: clamp(Math.round(width), WINDOW_LIMITS.minWidth, WINDOW_LIMITS.maxWidth),
    height: clamp(Math.round(height), WINDOW_LIMITS.minHeight, WINDOW_LIMITS.maxHeight),
  };
  const x = finiteNumber(value.x);
  const y = finiteNumber(value.y);
  if (x !== null && y !== null) {
    normalized.x = Math.round(x);
    normalized.y = Math.round(y);
  }
  return normalized;
}

function readWindowGeometry() {
  try {
    return normalizeWindowGeometry(JSON.parse(localStorage.getItem(WINDOW_STATE_KEY)));
  } catch (_) {
    return null;
  }
}

function readMemo() {
  try {
    return localStorage.getItem(MEMO_KEY) || "";
  } catch (_) {
    return "";
  }
}

async function reloadMemoFromStorage({ restoreGeometry = false } = {}) {
  if (textSaveTimer !== null) {
    clearTimeout(textSaveTimer);
    textSaveTimer = null;
  }
  memoInput.value = readMemo();
  rememberedGeometry = readWindowGeometry();
  if (restoreGeometry) await restoreWindowGeometry();
}

function readAppearanceSettings() {
  try {
    const settings = JSON.parse(localStorage.getItem(SNAPSHOT_KEY))?.settings;
    const appearance = ["light", "dark", "system"].includes(settings?.appearance)
      ? settings.appearance
      : "system";
    const opacity = finiteNumber(settings?.opacity);
    return {
      appearance,
      opacity: opacity === null ? 0.9 : clamp(opacity, 0.45, 1),
      customBg: typeof settings?.customBg === "string" && settings.customBg.trim()
        ? settings.customBg.trim()
        : null,
    };
  } catch (_) {
    return { appearance: "system", opacity: 0.9, customBg: null };
  }
}

function applyAppearance() {
  const root = document.documentElement;
  const settings = readAppearanceSettings();
  root.dataset.theme = settings.appearance;
  root.style.setProperty("--opacity", String(settings.opacity));
  if (settings.customBg) {
    root.style.setProperty("--panel-top", settings.customBg);
    root.style.setProperty("--panel-bottom", settings.customBg);
  } else {
    root.style.removeProperty("--panel-top");
    root.style.removeProperty("--panel-bottom");
  }
}

function persistMemo() {
  if (textSaveTimer !== null) {
    clearTimeout(textSaveTimer);
    textSaveTimer = null;
  }
  lastTextSaveAt = performance.now();
  try {
    localStorage.setItem(MEMO_KEY, memoInput.value);
  } catch (error) {
    console.warn("Unable to persist memo", error);
  }
}

function scheduleMemoSave() {
  const remaining = SAVE_INTERVAL - (performance.now() - lastTextSaveAt);
  if (remaining <= 0 && textSaveTimer === null) {
    persistMemo();
    return;
  }
  if (textSaveTimer !== null) return;
  textSaveTimer = setTimeout(persistMemo, Math.max(0, remaining));
}

function rememberWindowGeometry(position = null) {
  const next = {
    ...(rememberedGeometry || {}),
    width: window.innerWidth,
    height: window.innerHeight,
  };
  if (position && Number.isFinite(position.x) && Number.isFinite(position.y)) {
    next.x = position.x;
    next.y = position.y;
  }
  rememberedGeometry = normalizeWindowGeometry(next);
}

function persistWindowGeometry() {
  if (geometrySaveTimer !== null) {
    clearTimeout(geometrySaveTimer);
    geometrySaveTimer = null;
  }
  const browserPosition = appWindow
    ? null
    : { x: window.screenX, y: window.screenY };
  rememberWindowGeometry(browserPosition);
  if (!rememberedGeometry) return;
  try {
    localStorage.setItem(WINDOW_STATE_KEY, JSON.stringify(rememberedGeometry));
  } catch (error) {
    console.warn("Unable to persist memo window geometry", error);
  }
}

function scheduleWindowGeometrySave(position = null) {
  rememberWindowGeometry(position);
  if (geometrySaveTimer !== null) clearTimeout(geometrySaveTimer);
  geometrySaveTimer = setTimeout(persistWindowGeometry, SAVE_INTERVAL);
}

function isWindowPositionVisible(geometry, monitors) {
  if (
    geometry?.x === undefined || geometry?.y === undefined ||
    !Array.isArray(monitors)
  ) return false;

  return monitors.some((monitor) => {
    const area = monitor?.workArea || monitor;
    const left = finiteNumber(area?.position?.x);
    const top = finiteNumber(area?.position?.y);
    const width = finiteNumber(area?.size?.width);
    const height = finiteNumber(area?.size?.height);
    if (left === null || top === null || width === null || height === null) return false;

    const scaleFactor = Math.max(0.25, finiteNumber(monitor?.scaleFactor) || 1);
    const right = left + width;
    const bottom = top + height;
    const windowWidth = geometry.width * scaleFactor;
    const titleHeight = Math.min(46 * scaleFactor, geometry.height * scaleFactor);
    const visibleWidth = Math.max(
      0,
      Math.min(geometry.x + windowWidth, right) - Math.max(geometry.x, left),
    );
    const visibleTitleHeight = Math.max(
      0,
      Math.min(geometry.y + titleHeight, bottom) - Math.max(geometry.y, top),
    );
    return visibleWidth >= Math.min(64 * scaleFactor, windowWidth)
      && visibleTitleHeight >= Math.min(24 * scaleFactor, titleHeight);
  });
}

async function restoreWindowGeometry() {
  if (!rememberedGeometry) return;
  if (!appWindow || !TAURI?.window?.LogicalSize) {
    try {
      window.resizeTo(rememberedGeometry.width, rememberedGeometry.height);
      if (rememberedGeometry.x !== undefined && rememberedGeometry.y !== undefined) {
        window.moveTo(rememberedGeometry.x, rememberedGeometry.y);
      }
    } catch (_) {}
    return;
  }
  try {
    await appWindow.setSize(new TAURI.window.LogicalSize(
      rememberedGeometry.width,
      rememberedGeometry.height,
    ));
    if (
      rememberedGeometry.x !== undefined && rememberedGeometry.y !== undefined &&
      TAURI.window.PhysicalPosition && TAURI.window.availableMonitors
    ) {
      const monitors = await TAURI.window.availableMonitors();
      if (isWindowPositionVisible(rememberedGeometry, monitors)) {
        await appWindow.setPosition(new TAURI.window.PhysicalPosition(
          rememberedGeometry.x,
          rememberedGeometry.y,
        ));
      }
    }
  } catch (error) {
    console.warn("Unable to restore memo window geometry", error);
  }
}

async function bindWindowPersistence() {
  if (!appWindow) return;
  try {
    const position = await appWindow.outerPosition();
    rememberWindowGeometry(position);
    persistWindowGeometry();
  } catch (_) {}
  try {
    const unlisten = await appWindow.onMoved(({ payload }) => {
      scheduleWindowGeometrySave(payload);
    });
    unlisteners.push(unlisten);
  } catch (_) {}
  try {
    const unlisten = await appWindow.onCloseRequested((event) => {
      if (closing) return;
      event.preventDefault();
      void closeMemo();
    });
    unlisteners.push(unlisten);
  } catch (_) {}
  if (TAURI?.event?.listen) {
    try {
      const unlisten = await TAURI.event.listen("memo-data-imported", () => {
        void reloadMemoFromStorage({ restoreGeometry: true });
      });
      unlisteners.push(unlisten);
    } catch (_) {}
  }
}

async function notifyMain(open) {
  const payload = {
    hasContent: memoInput.value.trim().length > 0,
    open,
    source: "floating-todo-memo",
  };
  if (TAURI?.event?.emitTo) {
    try {
      await TAURI.event.emitTo("main", "memo-state-changed", payload);
    } catch (_) {}
  }
  try {
    window.opener?.postMessage(payload, window.location.origin);
  } catch (_) {}
}

async function closeMemo() {
  if (closing) return;
  closing = true;
  persistMemo();
  persistWindowGeometry();

  await notifyMain(false);

  try {
    if (appWindow?.destroy) {
      await appWindow.destroy();
    } else if (appWindow?.close) {
      await appWindow.close();
    } else {
      window.close();
    }
  } catch (error) {
    closing = false;
    console.warn("Unable to close memo window", error);
  }
}

function bindInteractions() {
  memoInput.addEventListener("input", scheduleMemoSave);
  closeButton.addEventListener("mousedown", (event) => event.stopPropagation());
  closeButton.addEventListener("click", closeMemo);
  document.querySelectorAll("[data-resize-direction]").forEach((handle) => {
    handle.addEventListener("mousedown", (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      appWindow?.startResizeDragging(handle.dataset.resizeDirection).catch(() => {});
    });
  });
  window.addEventListener("resize", () => scheduleWindowGeometrySave());
  window.addEventListener("blur", persistMemo);
  window.addEventListener("storage", (event) => {
    if (event.key === SNAPSHOT_KEY) {
      applyAppearance();
    } else if (event.key === MEMO_KEY) {
      void reloadMemoFromStorage();
    } else if (event.key === WINDOW_STATE_KEY) {
      void reloadMemoFromStorage({ restoreGeometry: true });
    }
  });
  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeMemo();
  });
}

function flushAndCleanUp() {
  persistMemo();
  persistWindowGeometry();
  if (!closing) void notifyMain(false);
  unlisteners.splice(0).forEach((unlisten) => unlisten());
}

async function initializeMemo() {
  applyAppearance();
  memoInput.value = readMemo();
  bindInteractions();
  await restoreWindowGeometry();
  await bindWindowPersistence();

  document.body.classList.add("ready");
  if (appWindow) {
    try {
      await appWindow.show();
      await appWindow.setFocus();
    } catch (error) {
      console.warn("Unable to show memo window", error);
    }
  }
  await notifyMain(true);
  requestAnimationFrame(() => memoInput.focus({ preventScroll: true }));
}

window.addEventListener("beforeunload", flushAndCleanUp, { once: true });
window.addEventListener("pagehide", flushAndCleanUp, { once: true });

initializeMemo().catch((error) => {
  console.error("Unable to initialize memo", error);
  document.body.classList.add("ready");
});
