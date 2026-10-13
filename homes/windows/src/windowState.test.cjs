const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  WINDOW_STATE_VERSION,
  captureWindowState,
  loadWindowState,
  normalizeWindowState,
  recoverWindowBounds,
  saveWindowState
} = require('./windowState.cjs');

function makeTempDirectory(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'selene-window-state-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

const primaryDisplay = {
  workArea: { x: 0, y: 0, width: 1920, height: 1040 }
};

test('window state round-trips outside the application source tree', (t) => {
  const directory = makeTempDirectory(t);
  const statePath = path.join(directory, 'nested', 'window-state.json');
  const state = {
    version: WINDOW_STATE_VERSION,
    bounds: { x: 120, y: 80, width: 1280, height: 760 },
    isMaximized: true
  };

  saveWindowState(statePath, state);

  assert.deepEqual(loadWindowState(statePath), state);

  const updatedState = {
    ...state,
    bounds: { x: 40, y: 30, width: 1000, height: 700 },
    isMaximized: false
  };
  saveWindowState(statePath, updatedState);
  assert.deepEqual(loadWindowState(statePath), updatedState);
});

test('missing, corrupt, and invalid preference data safely use no saved state', (t) => {
  const directory = makeTempDirectory(t);
  const statePath = path.join(directory, 'window-state.json');

  assert.equal(loadWindowState(statePath), null);

  fs.writeFileSync(statePath, '{not json', 'utf8');
  assert.equal(loadWindowState(statePath), null);

  fs.writeFileSync(statePath, JSON.stringify({
    version: WINDOW_STATE_VERSION,
    bounds: { x: 0, y: 0, width: -1, height: 800 },
    isMaximized: false
  }), 'utf8');
  assert.equal(loadWindowState(statePath), null);
});

test('a usable saved position is restored without changing native snap geometry', () => {
  const savedBounds = { x: 960, y: 0, width: 960, height: 1040 };

  assert.deepEqual(
    recoverWindowBounds(savedBounds, [primaryDisplay], primaryDisplay),
    savedBounds
  );
});

test('a usable position on a negatively located secondary display is preserved', () => {
  const leftDisplay = {
    workArea: { x: -1600, y: 40, width: 1600, height: 860 }
  };
  const savedBounds = { x: -1500, y: 100, width: 1100, height: 700 };

  assert.deepEqual(
    recoverWindowBounds(savedBounds, [primaryDisplay, leftDisplay], primaryDisplay),
    savedBounds
  );
});

test('a window from a disconnected monitor is centered on the primary display', () => {
  const recovered = recoverWindowBounds(
    { x: 4200, y: 200, width: 1200, height: 800 },
    [primaryDisplay],
    primaryDisplay
  );

  assert.deepEqual(recovered, { x: 360, y: 120, width: 1200, height: 800 });
});

test('partially visible unusable bounds are moved fully into the intersecting display', () => {
  const secondaryDisplay = {
    workArea: { x: 1920, y: 0, width: 1280, height: 984 }
  };

  const recovered = recoverWindowBounds(
    { x: 3100, y: 900, width: 1000, height: 700 },
    [primaryDisplay, secondaryDisplay],
    primaryDisplay
  );

  assert.deepEqual(recovered, { x: 2200, y: 284, width: 1000, height: 700 });
});

test('oversized saved bounds are reduced to the available primary work area', () => {
  const recovered = recoverWindowBounds(
    { x: -5000, y: -5000, width: 3000, height: 2000 },
    [primaryDisplay],
    primaryDisplay
  );

  assert.deepEqual(recovered, { x: 0, y: 0, width: 1920, height: 1040 });
});

test('normal bounds are captured while the window is maximized', () => {
  const normalBounds = { x: 240, y: 120, width: 1200, height: 800 };
  const fakeWindow = {
    getNormalBounds: () => normalBounds,
    isMaximized: () => true
  };

  assert.deepEqual(captureWindowState(fakeWindow), {
    version: WINDOW_STATE_VERSION,
    bounds: normalBounds,
    isMaximized: true
  });
});

test('unknown versions and non-boolean maximized state are rejected', () => {
  const bounds = { x: 0, y: 0, width: 1200, height: 800 };

  assert.equal(normalizeWindowState({ version: 2, bounds, isMaximized: false }), null);
  assert.equal(normalizeWindowState({ version: 1, bounds, isMaximized: 'yes' }), null);
});
