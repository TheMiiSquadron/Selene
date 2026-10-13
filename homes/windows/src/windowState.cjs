const fs = require('node:fs');
const path = require('node:path');

const WINDOW_STATE_VERSION = 1;
const WINDOW_STATE_FILENAME = 'window-state.json';
const MIN_VISIBLE_WIDTH = 160;
const MIN_VISIBLE_TITLEBAR_HEIGHT = 24;
const TITLEBAR_HEIGHT = 40;

function isFiniteInteger(value) {
  return Number.isFinite(value) && Number.isInteger(value);
}

function normalizeBounds(value) {
  if (
    !value
    || typeof value !== 'object'
    || !isFiniteInteger(value.x)
    || !isFiniteInteger(value.y)
    || !isFiniteInteger(value.width)
    || !isFiniteInteger(value.height)
    || value.width <= 0
    || value.height <= 0
  ) {
    return null;
  }

  return {
    x: value.x,
    y: value.y,
    width: value.width,
    height: value.height
  };
}

function normalizeWindowState(value) {
  if (
    !value
    || typeof value !== 'object'
    || value.version !== WINDOW_STATE_VERSION
    || typeof value.isMaximized !== 'boolean'
  ) {
    return null;
  }

  const bounds = normalizeBounds(value.bounds);
  if (!bounds) {
    return null;
  }

  return {
    version: WINDOW_STATE_VERSION,
    bounds,
    isMaximized: value.isMaximized
  };
}

function loadWindowState(filePath, fileSystem = fs) {
  try {
    const contents = fileSystem.readFileSync(filePath, 'utf8');
    return normalizeWindowState(JSON.parse(contents));
  } catch {
    return null;
  }
}

function saveWindowState(filePath, state, fileSystem = fs) {
  const normalized = normalizeWindowState(state);
  if (!normalized) {
    throw new TypeError('Refusing to save invalid window state.');
  }

  const directory = path.dirname(filePath);
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  fileSystem.mkdirSync(directory, { recursive: true });

  try {
    fileSystem.writeFileSync(
      temporaryPath,
      `${JSON.stringify(normalized, null, 2)}\n`,
      'utf8'
    );
    fileSystem.renameSync(temporaryPath, filePath);
  } catch (error) {
    try {
      fileSystem.rmSync(temporaryPath, { force: true });
    } catch {
      // Preserve the original persistence error.
    }
    throw error;
  }
}

function intersectionSize(first, second) {
  const width = Math.max(
    0,
    Math.min(first.x + first.width, second.x + second.width)
      - Math.max(first.x, second.x)
  );
  const height = Math.max(
    0,
    Math.min(first.y + first.height, second.y + second.height)
      - Math.max(first.y, second.y)
  );

  return { width, height, area: width * height };
}

function isBoundsUsable(bounds, workAreas) {
  const titlebar = {
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: Math.min(TITLEBAR_HEIGHT, bounds.height)
  };

  return workAreas.some((workArea) => {
    const visibleTitlebar = intersectionSize(titlebar, workArea);
    return (
      visibleTitlebar.width >= Math.min(MIN_VISIBLE_WIDTH, bounds.width)
      && visibleTitlebar.height >= Math.min(MIN_VISIBLE_TITLEBAR_HEIGHT, titlebar.height)
    );
  });
}

function fitBoundsToWorkArea(bounds, workArea, { center = false } = {}) {
  const width = Math.min(bounds.width, workArea.width);
  const height = Math.min(bounds.height, workArea.height);

  if (center) {
    return {
      x: workArea.x + Math.floor((workArea.width - width) / 2),
      y: workArea.y + Math.floor((workArea.height - height) / 2),
      width,
      height
    };
  }

  return {
    x: Math.min(Math.max(bounds.x, workArea.x), workArea.x + workArea.width - width),
    y: Math.min(Math.max(bounds.y, workArea.y), workArea.y + workArea.height - height),
    width,
    height
  };
}

function recoverWindowBounds(bounds, displays, primaryDisplay) {
  const normalizedBounds = normalizeBounds(bounds);
  const workAreas = displays
    .map((display) => normalizeBounds(display?.workArea))
    .filter(Boolean);
  const primaryWorkArea = normalizeBounds(primaryDisplay?.workArea) ?? workAreas[0] ?? null;

  if (!normalizedBounds || !primaryWorkArea) {
    return null;
  }

  if (isBoundsUsable(normalizedBounds, workAreas)) {
    return normalizedBounds;
  }

  let bestWorkArea = primaryWorkArea;
  let bestIntersectionArea = 0;

  for (const workArea of workAreas) {
    const { area } = intersectionSize(normalizedBounds, workArea);
    if (area > bestIntersectionArea) {
      bestIntersectionArea = area;
      bestWorkArea = workArea;
    }
  }

  return fitBoundsToWorkArea(normalizedBounds, bestWorkArea, {
    center: bestIntersectionArea === 0
  });
}

function captureWindowState(window) {
  return normalizeWindowState({
    version: WINDOW_STATE_VERSION,
    bounds: window.getNormalBounds(),
    isMaximized: window.isMaximized()
  });
}

module.exports = {
  WINDOW_STATE_FILENAME,
  WINDOW_STATE_VERSION,
  captureWindowState,
  fitBoundsToWorkArea,
  isBoundsUsable,
  loadWindowState,
  normalizeBounds,
  normalizeWindowState,
  recoverWindowBounds,
  saveWindowState
};
