// Derived, disposable signals. The snapshot and memo document remain authoritative.
export const APPEARANCE_KEY = "floating-todo/appearance-v1";
export const MEMO_PRESENCE_KEY = "floating-todo/memo-presence-v1";

export function appearanceSettings(settings) {
  const opacity = settings?.opacity;
  return {
    appearance: ["light", "dark", "system"].includes(settings?.appearance) ? settings.appearance : "system",
    opacity: typeof opacity === "number" && Number.isFinite(opacity) ? Math.min(1, Math.max(0.45, opacity)) : 0.9,
    customBg: typeof settings?.customBg === "string" && settings.customBg.trim() ? settings.customBg.trim() : null,
  };
}

export function publishSignal(storage, key, value) {
  try {
    if (storage.getItem(key) !== value) storage.setItem(key, value);
    return true;
  } catch (_) {
    // A failed hint must never invalidate an already saved document.
    return false;
  }
}

export function publishAppearance(storage, settings) {
  return publishSignal(storage, APPEARANCE_KEY, JSON.stringify(appearanceSettings(settings)));
}
