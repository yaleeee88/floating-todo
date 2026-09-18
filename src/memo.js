import {
  MEMO_DOCUMENT_KEY, MEMO_FONT, readMemoDocument,
  normalizeMemoDocument, renderMemoDocument, serializeMemoEditor,
} from "./memo-document.js";

const TAURI = window.__TAURI__;
const appWindow = TAURI?.window?.getCurrentWindow?.();

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
const pinButton = document.getElementById("memoPin");
const boldButton = document.getElementById("memoBold");
const status = document.getElementById("memoStatus");

let textSaveTimer = null;
let geometrySaveTimer = null;
let lastTextSaveAt = 0;
let rememberedGeometry = readWindowGeometry();
let closing = false;
let memoDocument = normalizeMemoDocument(null);
let memoLoaded = false;
let savedSelection = null;
let statusTimer = null;
let composing = false;
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

async function reloadMemoFromStorage({ restoreGeometry = false } = {}) {
  if (textSaveTimer !== null) {
    clearTimeout(textSaveTimer);
    textSaveTimer = null;
  }
  memoDocument = readMemoDocument(localStorage);
  renderMemoDocument(memoInput, memoDocument);
  savedSelection = null;
  memoLoaded = true;
  applyFontSize();
  updateEditorState();
  await applyPinState();
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
  if (!memoLoaded) return false;
  try {
    memoDocument = serializeMemoEditor(memoInput, memoDocument);
    localStorage.setItem(MEMO_DOCUMENT_KEY, JSON.stringify(memoDocument));
    return true;
  } catch (error) {
    console.warn("Unable to persist memo", error);
    showStatus("保存失败，请暂时保留窗口并复制内容", false);
    return false;
  }
}

function showStatus(message, temporary = true) {
  clearTimeout(statusTimer);
  status.textContent = message;
  if (temporary) statusTimer = setTimeout(() => { status.textContent = ""; }, 1800);
}

function applyFontSize() {
  memoInput.style.setProperty("--memo-font-size", `${memoDocument.fontSize}px`);
}

function changeFontSize(delta) {
  memoDocument.fontSize = delta === 0 ? MEMO_FONT.default
    : clamp(memoDocument.fontSize + delta, MEMO_FONT.min, MEMO_FONT.max);
  applyFontSize();
  if (persistMemo()) showStatus(`字号 ${memoDocument.fontSize}`);
}

function updatePinButton() {
  pinButton.setAttribute("aria-pressed", String(memoDocument.pinned));
  pinButton.title = memoDocument.pinned ? "取消置顶" : "置顶备忘录";
  pinButton.setAttribute("aria-label", pinButton.title);
}

async function applyPinState() {
  if (appWindow) {
    try {
      await appWindow.setAlwaysOnTop(memoDocument.pinned);
    } catch (error) {
      console.warn("Unable to set memo pin state", error);
      showStatus("无法设置置顶，请重新打开备忘录", false);
      return false;
    }
  }
  updatePinButton();
  return true;
}

async function togglePin() {
  if (pinButton.disabled) return;
  pinButton.disabled = true;
  const previous = memoDocument.pinned;
  memoDocument.pinned = !previous;
  if (await applyPinState()) {
    persistMemo();
    if (!appWindow) showStatus("已记住选择，桌面版支持窗口置顶");
  } else {
    memoDocument.pinned = previous;
    updatePinButton();
  }
  pinButton.disabled = false;
}

function editorSelection() {
  const selection = window.getSelection();
  if (!selection?.rangeCount) return null;
  const range = selection.getRangeAt(0);
  return memoInput.contains(range.startContainer) && memoInput.contains(range.endContainer)
    ? range : null;
}

function updateEditorState() {
  memoInput.dataset.empty = String(!memoInput.textContent && !memoInput.innerText.trim());
  const range = editorSelection();
  if (range) savedSelection = range.cloneRange();
  boldButton.setAttribute("aria-pressed", String(!!range && document.queryCommandState("bold")));
}

function toggleBold() {
  if (composing || !memoLoaded) return;
  memoInput.focus({ preventScroll: true });
  if (savedSelection && memoInput.contains(savedSelection.commonAncestorContainer)) {
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(savedSelection);
  }
  // Native editing commands retain selection and the browser's undo history.
  document.execCommand("bold", false);
  updateEditorState();
  scheduleMemoSave();
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
    hasContent: memoInput.textContent.trim().length > 0,
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
  if (memoLoaded && !persistMemo()) return;
  closing = true;
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
  memoInput.addEventListener("input", () => {
    updateEditorState();
    if (!composing) scheduleMemoSave();
  });
  memoInput.addEventListener("compositionstart", () => { composing = true; });
  memoInput.addEventListener("compositionend", () => {
    composing = false;
    updateEditorState();
    scheduleMemoSave();
  });
  memoInput.addEventListener("paste", (event) => {
    event.preventDefault();
    const text = event.clipboardData?.getData("text/plain");
    if (text) document.execCommand("insertText", false, text);
  });
  // Keep external HTML/files out of the small text-only editor.
  memoInput.addEventListener("drop", (event) => event.preventDefault());
  memoInput.addEventListener("dragover", (event) => event.preventDefault());
  memoInput.addEventListener("beforeinput", (event) => {
    if (event.inputType === "insertLineBreak" && !event.isComposing) {
      event.preventDefault();
      document.execCommand("insertText", false, "\n");
    } else if (event.inputType === "formatItalic" || event.inputType === "formatUnderline") {
      event.preventDefault();
    }
  });
  document.addEventListener("selectionchange", updateEditorState);
  document.querySelectorAll(".memo-tool").forEach((button) => {
    button.addEventListener("mousedown", (event) => {
      event.stopPropagation();
      // Preserve the selected words when clicking the formatting button.
      if (button === boldButton) event.preventDefault();
    });
  });
  boldButton.addEventListener("click", toggleBold);
  pinButton.addEventListener("click", togglePin);
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
    } else if (event.key === MEMO_DOCUMENT_KEY) {
      void reloadMemoFromStorage();
    } else if (event.key === WINDOW_STATE_KEY) {
      void reloadMemoFromStorage({ restoreGeometry: true });
    }
  });
  window.addEventListener("keydown", (event) => {
    if (event.isComposing || composing) return;
    if ((event.ctrlKey || event.metaKey) && !event.altKey) {
      if (["+", "=", "-", "_", "0"].includes(event.key)) {
        event.preventDefault();
        changeFontSize(event.key === "0" ? 0 : ["-", "_"].includes(event.key) ? -1 : 1);
        return;
      }
      if (event.key.toLowerCase() === "b") {
        event.preventDefault();
        toggleBold();
        return;
      }
    }
    if (event.key === "Escape") closeMemo();
  });
}

function flushAndCleanUp() {
  persistMemo();
  persistWindowGeometry();
  if (!closing) void notifyMain(false);
  unlisteners.splice(0).forEach((unlisten) => unlisten());
  clearTimeout(statusTimer);
  document.removeEventListener("selectionchange", updateEditorState);
}

async function initializeMemo() {
  applyAppearance();
  bindInteractions();
  await reloadMemoFromStorage();
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

initializeMemo().catch(async (error) => {
  console.error("Unable to initialize memo", error);
  memoInput.contentEditable = "false";
  pinButton.disabled = true;
  boldButton.disabled = true;
  showStatus("无法读取备忘录，原有内容已保留", false);
  document.body.classList.add("ready");
  try { await appWindow?.show(); } catch (_) {}
});
