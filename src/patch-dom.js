// Small native-DOM renderer: unchanged regions are not parsed, and changed
// regions reconcile keyed children instead of discarding live DOM and focus.
const regionsByParent = new WeakMap();

function nodeKey(node) {
  if (node.nodeType !== 1) return String(node.nodeType);
  if (node.id) return `${node.nodeName}:id:${node.id}`;
  if (node.hasAttribute("data-dom-key")) return `${node.nodeName}:key:${node.getAttribute("data-dom-key")}`;
  if (node.hasAttribute("data-act")) {
    return `${node.nodeName}:act:${JSON.stringify(["act", "kind", "id", "routine-id", "subtask-id", "bucket"]
      .map((key) => node.getAttribute(`data-${key}`)))}`;
  }
  return `${node.nodeName}:${node.getAttribute("class")?.split(/\s+/)[0] || ""}`;
}

function patchNode(current, next, preserveChildren = false) {
  if (current.nodeType !== next.nodeType || current.nodeName !== next.nodeName || current.namespaceURI !== next.namespaceURI) {
    current.replaceWith(next);
    return next;
  }
  if (!preserveChildren && current.isEqualNode(next)) return current;
  if (current.nodeType !== 1) {
    if (current.nodeValue !== next.nodeValue) current.nodeValue = next.nodeValue;
    return current;
  }
  // These classes are transient effects, not data. Leave a running animation
  // intact until its animationend handler removes it.
  const motion = [...current.classList].filter((name) => name.startsWith("motion-"));
  for (const attribute of [...current.attributes]) {
    if (!next.hasAttribute(attribute.name)) current.removeAttribute(attribute.name);
  }
  for (const attribute of next.attributes) {
    let value = attribute.value;
    if (attribute.name === "class" && motion.length) value = [...new Set([...value.split(/\s+/), ...motion])].join(" ");
    if (current.getAttribute(attribute.name) !== value) current.setAttribute(attribute.name, value);
  }
  if (preserveChildren) return current;
  const candidates = new Map();
  for (const child of current.childNodes) {
    const key = nodeKey(child);
    if (!candidates.has(key)) candidates.set(key, []);
    candidates.get(key).push(child);
  }
  let cursor = current.firstChild;
  for (const desired of [...next.childNodes]) {
    const old = candidates.get(nodeKey(desired))?.shift();
    const child = old ? patchNode(old, desired) : desired;
    if (child !== cursor) current.insertBefore(child, cursor);
    cursor = child.nextSibling;
  }
  while (cursor) {
    const nextSibling = cursor.nextSibling;
    cursor.remove();
    cursor = nextSibling;
  }
  return current;
}

export function updateRegions(parent, regions) {
  const previous = regionsByParent.get(parent) || new Map();
  const current = new Map();
  let cursor = parent.firstChild;
  for (const { key, html, preserveChildren = false } of regions) {
    if (!html) continue;
    const old = previous.get(key);
    let node = old?.node;
    if (!node || node.parentNode !== parent || old.html !== html) {
      const template = parent.ownerDocument.createElement("template");
      template.innerHTML = html.trim();
      const desired = template.content.firstElementChild;
      if (!desired || template.content.children.length !== 1) throw new Error(`Invalid render region: ${key}`);
      const replacingCursor = node === cursor;
      node = node?.parentNode === parent ? patchNode(node, desired, preserveChildren) : desired;
      if (replacingCursor) cursor = node;
    }
    if (node !== cursor) parent.insertBefore(node, cursor);
    cursor = node.nextSibling;
    current.set(key, { html, node });
  }
  while (cursor) {
    const next = cursor.nextSibling;
    cursor.remove();
    cursor = next;
  }
  regionsByParent.set(parent, current);
}
