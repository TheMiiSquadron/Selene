import test from "node:test";
import assert from "node:assert/strict";
import {
  NotificationValidationError,
  createNotificationService,
} from "./notifications.js";

function fixedClock() {
  let tick = 0;
  return () => new Date(Date.UTC(2026, 7, 28, 12, 0, tick++));
}

test("a valid proactive notification can be created", () => {
  const service = createNotificationService({ now: fixedClock() });
  const notification = service.createProactiveNotification("Selene has something for you.");

  assert.equal(notification.type, "proactive");
  assert.equal(notification.message, "Selene has something for you.");
  assert.equal(notification.acknowledged, false);
  assert.match(notification.id, /^[0-9a-f-]{36}$/i);
  assert.equal(notification.createdAt, "2026-08-28T12:00:00.000Z");
});

test("pending notifications can be retrieved in creation order", () => {
  const service = createNotificationService({ now: fixedClock() });
  const first = service.createProactiveNotification("First");
  const second = service.createProactiveNotification("Second");

  assert.deepEqual(
    service.getPendingNotifications().map((item) => item.id),
    [first.id, second.id],
  );
});

test("notification IDs are unique", () => {
  const service = createNotificationService();
  const ids = new Set(
    Array.from({ length: 20 }, (_, index) => (
      service.createProactiveNotification(`Notification ${index}`).id
    )),
  );

  assert.equal(ids.size, 20);
});

test("invalid, empty, and oversized messages are rejected", () => {
  const service = createNotificationService();

  assert.throws(
    () => service.createProactiveNotification(""),
    NotificationValidationError,
  );
  assert.throws(
    () => service.createProactiveNotification("x".repeat(501)),
    /500 characters/,
  );
});

test("a notification can be acknowledged", () => {
  const service = createNotificationService({ now: fixedClock() });
  const notification = service.createProactiveNotification("Done watching something.");

  const result = service.acknowledgeNotification(notification.id);

  assert.equal(result.ok, true);
  assert.equal(result.notification.id, notification.id);
  assert.equal(result.notification.acknowledged, true);
  assert.equal(result.notification.acknowledgedAt, "2026-08-28T12:00:01.000Z");
});

test("acknowledged notifications are no longer pending", () => {
  const service = createNotificationService();
  const notification = service.createProactiveNotification("Pending once.");

  service.acknowledgeNotification(notification.id);

  assert.deepEqual(service.getPendingNotifications(), []);
});

test("unknown notification IDs fail safely", () => {
  const service = createNotificationService();

  assert.deepEqual(service.acknowledgeNotification("missing_id"), {
    ok: false,
    message: "Notification not found.",
  });
});

test("malformed notification IDs fail safely", () => {
  const service = createNotificationService();

  assert.throws(
    () => service.acknowledgeNotification("../missing"),
    NotificationValidationError,
  );
});
