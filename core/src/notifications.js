import { randomUUID } from "node:crypto";

const MAX_MESSAGE_LENGTH = 500;

export class NotificationValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "NotificationValidationError";
  }
}

function validateMessage(message) {
  const value = String(message ?? "").trim();
  if (!value) {
    throw new NotificationValidationError("Notification message is required.");
  }
  if (value.length > MAX_MESSAGE_LENGTH) {
    throw new NotificationValidationError(`Notification message must be ${MAX_MESSAGE_LENGTH} characters or fewer.`);
  }
  return value;
}

function validateId(id) {
  const value = String(id ?? "").trim();
  if (!value || value.length > 120 || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new NotificationValidationError("Notification ID is invalid.");
  }
  return value;
}

export function createNotificationService({ now = () => new Date() } = {}) {
  const notifications = new Map();

  function createProactiveNotification(message) {
    const notification = {
      id: randomUUID(),
      type: "proactive",
      message: validateMessage(message),
      createdAt: now().toISOString(),
      acknowledged: false,
    };

    notifications.set(notification.id, notification);
    return { ...notification };
  }

  function getPendingNotifications() {
    return [...notifications.values()]
      .filter((notification) => notification.type === "proactive" && !notification.acknowledged)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map((notification) => ({ ...notification }));
  }

  function acknowledgeNotification(id) {
    const notificationId = validateId(id);
    const notification = notifications.get(notificationId);

    if (!notification) {
      return {
        ok: false,
        message: "Notification not found.",
      };
    }

    notification.acknowledged = true;
    notification.acknowledgedAt = now().toISOString();
    notifications.set(notificationId, notification);

    return {
      ok: true,
      notification: { ...notification },
    };
  }

  return {
    createProactiveNotification,
    getPendingNotifications,
    acknowledgeNotification,
  };
}

export const notificationService = createNotificationService();
