import { posix, win32 } from "node:path";

export class PlatformPathValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "PlatformPathValidationError";
  }
}

function requireAbsoluteBasePath(value, label, pathApi) {
  const basePath = typeof value === "string" ? value.trim() : "";
  if (!basePath || !pathApi.isAbsolute(basePath)) {
    throw new PlatformPathValidationError(
      `${label} must be an absolute path before resolving Selene production storage.`,
    );
  }
  return basePath;
}

export function resolveSeleneProductionDataDirectory({
  platform = process.platform,
  env = process.env,
} = {}) {
  if (platform === "win32") {
    const localAppData = requireAbsoluteBasePath(
      env.LOCALAPPDATA,
      "LOCALAPPDATA",
      win32,
    );
    return win32.resolve(localAppData, "Selene");
  }

  if (platform === "darwin") {
    const home = requireAbsoluteBasePath(env.HOME, "HOME", posix);
    return posix.resolve(home, "Library", "Application Support", "Selene");
  }

  throw new PlatformPathValidationError(
    `Unsupported platform for Selene production storage: ${String(platform)}.`,
  );
}

export function resolveSeleneProductionPath(options = {}, ...segments) {
  const platform = options.platform ?? process.platform;
  const pathApi = platform === "win32" ? win32 : platform === "darwin" ? posix : null;
  if (!pathApi) {
    throw new PlatformPathValidationError(
      `Unsupported platform for Selene production storage: ${String(platform)}.`,
    );
  }
  return pathApi.resolve(resolveSeleneProductionDataDirectory(options), ...segments);
}
