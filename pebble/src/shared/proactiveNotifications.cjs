const ACTIVE_STATE_HOLDS = new Set(["working", "asking", "error"]);
const MAX_NOTIFICATION_MESSAGE_LENGTH = 500;

function normalizeNotification(raw) {
  if (!raw || typeof raw !== "object") return null;

  const id = String(raw.id ?? "").trim();
  const message = String(raw.message ?? "").trim();
  const type = String(raw.type ?? "").trim().toLowerCase();
  const createdAt = String(raw.createdAt ?? "").trim();

  if (!id || !message || type !== "proactive") return null;

  return {
    id,
    type: "proactive",
    message: message.slice(0, MAX_NOTIFICATION_MESSAGE_LENGTH),
    createdAt,
    acknowledged: Boolean(raw.acknowledged),
  };
}

function normalizeProactiveNotifications(value) {
  if (!Array.isArray(value)) return [];

  const seen = new Set();
  const notifications = [];

  for (const raw of value) {
    const notification = normalizeNotification(raw);
    if (!notification || seen.has(notification.id) || notification.acknowledged) continue;

    seen.add(notification.id);
    notifications.push(notification);
  }

  return notifications.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

function shouldShowProactiveState(baseState, pendingCount) {
  return Number(pendingCount) > 0 && !ACTIVE_STATE_HOLDS.has(String(baseState ?? ""))
    ? "proactive"
    : baseState;
}

module.exports = {
  ACTIVE_STATE_HOLDS,
  normalizeProactiveNotifications,
  shouldShowProactiveState,
};
