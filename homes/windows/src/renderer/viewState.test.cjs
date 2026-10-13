const assert = require('node:assert/strict');
const test = require('node:test');

const { getTimeGreeting, getUnavailableMessage } = require('./viewState.js');

test('time greeting follows local morning, afternoon, and evening boundaries', () => {
  assert.equal(getTimeGreeting(5), 'Good morning.');
  assert.equal(getTimeGreeting(11), 'Good morning.');
  assert.equal(getTimeGreeting(12), 'Good afternoon.');
  assert.equal(getTimeGreeting(16), 'Good afternoon.');
  assert.equal(getTimeGreeting(17), 'Good evening.');
  assert.equal(getTimeGreeting(23), 'Good evening.');
  assert.equal(getTimeGreeting(0), 'Good evening.');
});

test('time greeting accepts a Date and rejects invalid hours', () => {
  const morning = new Date(2026, 9, 12, 8, 30);
  assert.equal(getTimeGreeting(morning), 'Good morning.');
  assert.throws(() => getTimeGreeting(-1), /0 through 23/);
  assert.throws(() => getTimeGreeting(24), /0 through 23/);
  assert.throws(() => getTimeGreeting(9.5), /0 through 23/);
});

test('unavailable features return honest, stable messages', () => {
  assert.match(getUnavailableMessage('conversation'), /not available/i);
  assert.match(getUnavailableMessage('conversation'), /not sent/i);
  assert.match(getUnavailableMessage('devices'), /unavailable/i);
  assert.match(getUnavailableMessage('constellation'), /unavailable/i);
  assert.match(getUnavailableMessage('unknown'), /not available/i);
});
