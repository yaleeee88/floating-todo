export const MEMO_DOCUMENT_KEY = "floating-todo/memo-v2";
export const LEGACY_MEMO_KEY = "floating-todo/memo-v1";
export const MEMO_FONT = Object.freeze({ default: 13, min: 10, max: 32 });

export function normalizeMemoDocument(value, fallbackText = "") {
  const text = typeof value?.text === "string" ? value.text : fallbackText;
  const ranges = (Array.isArray(value?.bold) ? value.bold : [])
    .filter((range) => Number.isInteger(range?.start) && Number.isInteger(range?.end))
    .map(({ start, end }) => ({ start: Math.max(0, start), end: Math.min(text.length, end) }))
    .filter(({ start, end }) => start < end)
    .sort((a, b) => a.start - b.start);
  const bold = [];
  for (const range of ranges) {
    const previous = bold.at(-1);
    if (previous && range.start <= previous.end) previous.end = Math.max(previous.end, range.end);
    else bold.push(range);
  }
  return {
    version: 2,
    text,
    bold,
    fontSize: Number.isFinite(value?.fontSize)
      ? Math.max(MEMO_FONT.min, Math.min(MEMO_FONT.max, Math.round(value.fontSize)))
      : MEMO_FONT.default,
    pinned: typeof value?.pinned === "boolean" ? value.pinned : true,
  };
}

export function isMemoDocument(value) {
  return value?.version === 2 && typeof value.text === "string"
    && Array.isArray(value.bold) && value.bold.every((range) =>
      Number.isInteger(range?.start) && Number.isInteger(range?.end)
      && range.start >= 0 && range.end > range.start && range.end <= value.text.length)
    && Number.isFinite(value.fontSize) && typeof value.pinned === "boolean";
}

export function readMemoDocument(storage) {
  const raw = storage.getItem(MEMO_DOCUMENT_KEY);
  if (raw !== null) {
    const value = JSON.parse(raw);
    if (!isMemoDocument(value)) throw new Error("Invalid memo document");
    return normalizeMemoDocument(value);
  }
  // Legacy notes are literal text, even when they happen to contain HTML or JSON.
  return normalizeMemoDocument(null, storage.getItem(LEGACY_MEMO_KEY) || "");
}

// Only text and bold ranges are persisted. No pasted/imported HTML is executed.
export function renderMemoDocument(editor, value) {
  const memo = normalizeMemoDocument(value);
  const fragment = editor.ownerDocument.createDocumentFragment();
  let offset = 0;
  for (const range of memo.bold) {
    fragment.append(memo.text.slice(offset, range.start));
    const strong = editor.ownerDocument.createElement("strong");
    strong.textContent = memo.text.slice(range.start, range.end);
    fragment.append(strong);
    offset = range.end;
  }
  fragment.append(memo.text.slice(offset));
  // Give a trailing blank line a real caret position after reopening the note.
  if (memo.text.endsWith("\n")) fragment.append(editor.ownerDocument.createElement("br"));
  editor.replaceChildren(fragment);
}

export function serializeMemoEditor(editor, preferences) {
  let text = "";
  const bold = [];
  const isBlock = (node) => /^(DIV|P|LI)$/.test(node.nodeName);
  function isCaretPlaceholder(node) {
    let current = node;
    while (current !== editor) {
      if (current.nextSibling) return false;
      if (isBlock(current.parentNode)) return true;
      current = current.parentNode;
    }
    return true;
  }
  function append(value, emphasized) {
    const start = text.length;
    text += value;
    if (emphasized && value.length) bold.push({ start, end: text.length });
  }
  function walk(parent, inheritedBold = false) {
    const nodes = Array.from(parent.childNodes);
    nodes.forEach((node, index) => {
      if (node.nodeType === 3) {
        append(node.nodeValue, inheritedBold);
      } else if (node.nodeType === 1) {
        if (/^(SCRIPT|STYLE|IFRAME|OBJECT)$/.test(node.nodeName)) return;
        if (node.nodeName === "BR") {
          // The final BR in an editable line is the browser's caret placeholder.
          if (!isCaretPlaceholder(node)) {
            append("\n", inheritedBold);
          }
          return;
        }
        const block = isBlock(node);
        if (block && index > 0 && text.length > 0 && !text.endsWith("\n")) append("\n", false);
        const weight = node.style.fontWeight;
        const emphasized = weight
          ? weight === "bold" || Number(weight) >= 600
          : inheritedBold || /^(B|STRONG)$/.test(node.nodeName);
        walk(node, emphasized);
        if (block && index < nodes.length - 1) append("\n", false);
      }
    });
  }
  walk(editor);
  return normalizeMemoDocument({ ...preferences, text, bold });
}
