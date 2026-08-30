export const WINDOW_LIMITS = Object.freeze({
  minWidth: 250,
  minHeight: 180,
  maxWidth: 960,
  maxHeight: 860,
  defaultWidth: 390,
  defaultHeight: 650,
});

function finiteNumber(value) {
  if (value === null || value === "" || typeof value === "boolean") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

/**
 * Validate persisted window geometry before sending it to the native window API.
 * Width and height are logical CSS pixels; x and y are physical desktop pixels.
 */
export function normalizeWindowState(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;

  const rawWidth = finiteNumber(value.width);
  const rawHeight = finiteNumber(value.height);
  if (rawWidth === null || rawHeight === null) return null;

  const normalized = {
    width: clamp(Math.round(rawWidth), WINDOW_LIMITS.minWidth, WINDOW_LIMITS.maxWidth),
    height: clamp(Math.round(rawHeight), WINDOW_LIMITS.minHeight, WINDOW_LIMITS.maxHeight),
  };

  if (typeof value.compact === "boolean") {
    normalized.compact = value.compact;
  }

  const rawX = finiteNumber(value.x);
  const rawY = finiteNumber(value.y);
  if (rawX !== null && rawY !== null) {
    normalized.x = Math.round(rawX);
    normalized.y = Math.round(rawY);
  }

  const rawExpandedWidth = finiteNumber(value.expandedWidth);
  const rawExpandedHeight = finiteNumber(value.expandedHeight);
  if (rawExpandedWidth !== null && rawExpandedHeight !== null) {
    normalized.expandedWidth = clamp(
      Math.round(rawExpandedWidth),
      WINDOW_LIMITS.minWidth,
      WINDOW_LIMITS.maxWidth,
    );
    normalized.expandedHeight = clamp(
      Math.round(rawExpandedHeight),
      WINDOW_LIMITS.minHeight,
      WINDOW_LIMITS.maxHeight,
    );
  }

  return normalized;
}

/** Return true when a useful portion of the window remains reachable on a monitor. */
export function isWindowPositionVisible(windowState, monitors) {
  const value = normalizeWindowState(windowState);
  if (!value || value.x === undefined || value.y === undefined || !Array.isArray(monitors)) {
    return false;
  }

  return monitors.some((monitor) => {
    const area = monitor?.workArea || monitor;
    const left = finiteNumber(area?.position?.x);
    const top = finiteNumber(area?.position?.y);
    const monitorWidth = finiteNumber(area?.size?.width);
    const monitorHeight = finiteNumber(area?.size?.height);
    if (
      left === null || top === null || monitorWidth === null || monitorHeight === null ||
      monitorWidth <= 0 || monitorHeight <= 0
    ) return false;

    const scaleFactor = Math.max(0.25, finiteNumber(monitor.scaleFactor) || 1);
    const windowWidth = value.width * scaleFactor;
    const windowHeight = value.height * scaleFactor;
    const headerHeight = Math.min(48 * scaleFactor, windowHeight);
    const right = left + monitorWidth;
    const bottom = top + monitorHeight;
    const visibleWidth = Math.max(0, Math.min(value.x + windowWidth, right) - Math.max(value.x, left));
    const visibleHeaderHeight = Math.max(
      0,
      Math.min(value.y + headerHeight, bottom) - Math.max(value.y, top),
    );

    return visibleWidth >= Math.min(64 * scaleFactor, windowWidth)
      && visibleHeaderHeight >= Math.min(24 * scaleFactor, headerHeight);
  });
}
