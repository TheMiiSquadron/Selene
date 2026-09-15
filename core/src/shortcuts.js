export const SHORTCUT_REGISTRY = {
  "ctrl+a": { label: "Ctrl+A", sendKeys: "^a" },
  "ctrl+c": { label: "Ctrl+C", sendKeys: "^c" },
  "ctrl+v": { label: "Ctrl+V", sendKeys: "^v" },
  "ctrl+x": { label: "Ctrl+X", sendKeys: "^x" },
  "ctrl+z": { label: "Ctrl+Z", sendKeys: "^z" },
  "ctrl+y": { label: "Ctrl+Y", sendKeys: "^y" },
  "ctrl+s": { label: "Ctrl+S", sendKeys: "^s" },
  "ctrl+f": { label: "Ctrl+F", sendKeys: "^f" },
  "ctrl+n": { label: "Ctrl+N", sendKeys: "^n" },
  "ctrl+o": { label: "Ctrl+O", sendKeys: "^o" },
  tab: { label: "Tab", sendKeys: "{TAB}" },
  "shift+tab": { label: "Shift+Tab", sendKeys: "+{TAB}" },
  enter: { label: "Enter", sendKeys: "{ENTER}" },
  escape: { label: "Escape", sendKeys: "{ESC}" },
  up: { label: "Up Arrow", sendKeys: "{UP}" },
  down: { label: "Down Arrow", sendKeys: "{DOWN}" },
  left: { label: "Left Arrow", sendKeys: "{LEFT}" },
  right: { label: "Right Arrow", sendKeys: "{RIGHT}" },
  "arrow up": { label: "Up Arrow", sendKeys: "{UP}", canonical: "up" },
  "arrow down": { label: "Down Arrow", sendKeys: "{DOWN}", canonical: "down" },
  "arrow left": { label: "Left Arrow", sendKeys: "{LEFT}", canonical: "left" },
  "arrow right": { label: "Right Arrow", sendKeys: "{RIGHT}", canonical: "right" },
};

export function normalizeShortcut(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s*\+\s*/g, "+")
    .replace(/\s+/g, " ");
}

export function resolveShortcut(value) {
  const requested = normalizeShortcut(value);
  const entry = SHORTCUT_REGISTRY[requested];
  if (!entry) return null;

  const canonical = entry.canonical ?? requested;
  return {
    id: canonical,
    label: SHORTCUT_REGISTRY[canonical]?.label ?? entry.label,
    sendKeys: SHORTCUT_REGISTRY[canonical]?.sendKeys ?? entry.sendKeys,
  };
}

export function listShortcutIds() {
  return Object.entries(SHORTCUT_REGISTRY)
    .filter(([id, entry]) => !entry.canonical && id === normalizeShortcut(id))
    .map(([id]) => id);
}
