import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { coreConfigPath } from "./paths.js";

export const DEFAULT_MEMORY_PATH = coreConfigPath("memory.json");
const MAX_KEY_LENGTH = 80;
const MAX_VALUE_BYTES = 4096;

export const MEMORY_CATEGORIES = Object.freeze(["preferences", "appAliases"]);

export const DEFAULT_MEMORY = Object.freeze({
  preferences: Object.freeze({}),
  appAliases: Object.freeze({}),
});

export class MemoryValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "MemoryValidationError";
  }
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function cloneDefaultMemory() {
  return {
    preferences: {},
    appAliases: {},
  };
}

export function validateMemoryCategory(category) {
  const normalized = String(category ?? "").trim();
  if (!MEMORY_CATEGORIES.includes(normalized)) {
    throw new MemoryValidationError(`Unknown memory category: ${normalized || "(empty)"}.`);
  }
  return normalized;
}

export function validateMemoryKey(key) {
  const normalized = String(key ?? "").trim();
  if (!normalized) {
    throw new MemoryValidationError("Memory key is required.");
  }
  if (normalized.length > MAX_KEY_LENGTH) {
    throw new MemoryValidationError(`Memory key must be ${MAX_KEY_LENGTH} characters or fewer.`);
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9_. -]*$/.test(normalized)) {
    throw new MemoryValidationError("Memory key contains unsupported characters.");
  }
  if (normalized.includes("..") || normalized.includes("/") || normalized.includes("\\")) {
    throw new MemoryValidationError("Memory key cannot contain path segments.");
  }
  return normalized;
}

export function validateMemoryValue(category, value) {
  const normalizedCategory = validateMemoryCategory(category);

  if (typeof value === "undefined") {
    throw new MemoryValidationError("Memory value is required.");
  }

  if (normalizedCategory === "appAliases") {
    if (typeof value !== "string" || !value.trim()) {
      throw new MemoryValidationError("App alias memory values must be non-empty strings.");
    }
    return value.trim().slice(0, 120);
  }

  try {
    const serialized = JSON.stringify(value);
    if (typeof serialized !== "string") {
      throw new MemoryValidationError("Memory value must be JSON serializable.");
    }
    if (Buffer.byteLength(serialized, "utf-8") > MAX_VALUE_BYTES) {
      throw new MemoryValidationError(`Memory value must be ${MAX_VALUE_BYTES} bytes or fewer.`);
    }
    return JSON.parse(serialized);
  } catch (error) {
    if (error instanceof MemoryValidationError) throw error;
    throw new MemoryValidationError("Memory value must be JSON serializable.");
  }
}

export function validateMemoryStore(value) {
  const source = isPlainObject(value) ? value : {};
  const next = cloneDefaultMemory();

  for (const category of MEMORY_CATEGORIES) {
    if (!isPlainObject(source[category])) continue;

    for (const [rawKey, rawValue] of Object.entries(source[category])) {
      try {
        const key = validateMemoryKey(rawKey);
        next[category][key] = validateMemoryValue(category, rawValue);
      } catch {
        // Skip malformed entries. A bad entry should not make Core fail to boot.
      }
    }
  }

  return next;
}

async function writeJsonSafely(filePath, value) {
  const directory = dirname(filePath);
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  const body = `${JSON.stringify(value, null, 2)}\n`;

  await mkdir(directory, { recursive: true });
  await writeFile(tempPath, body, "utf-8");
  await rename(tempPath, filePath);
}

export function createMemoryService({ memoryPath = DEFAULT_MEMORY_PATH } = {}) {
  const resolvedMemoryPath = resolve(memoryPath);

  async function loadMemory() {
    try {
      const parsed = JSON.parse(await readFile(resolvedMemoryPath, "utf-8"));
      return validateMemoryStore(parsed);
    } catch {
      return cloneDefaultMemory();
    }
  }

  async function saveMemory(memory) {
    const next = validateMemoryStore(memory);
    await writeJsonSafely(resolvedMemoryPath, next);
    return next;
  }

  async function readMemory(category, key) {
    const memory = await loadMemory();

    if (typeof category === "undefined" || category === null || String(category).trim() === "") {
      return memory;
    }

    const normalizedCategory = validateMemoryCategory(category);
    if (typeof key === "undefined" || key === null || String(key).trim() === "") {
      return memory[normalizedCategory];
    }

    const normalizedKey = validateMemoryKey(key);
    return memory[normalizedCategory][normalizedKey] ?? null;
  }

  async function setMemoryEntry(category, key, value) {
    const normalizedCategory = validateMemoryCategory(category);
    const normalizedKey = validateMemoryKey(key);
    const normalizedValue = validateMemoryValue(normalizedCategory, value);
    const memory = await loadMemory();

    memory[normalizedCategory][normalizedKey] = normalizedValue;
    await saveMemory(memory);

    return {
      category: normalizedCategory,
      key: normalizedKey,
      value: normalizedValue,
    };
  }

  async function deleteMemoryEntry(category, key) {
    const normalizedCategory = validateMemoryCategory(category);
    const normalizedKey = validateMemoryKey(key);
    const memory = await loadMemory();
    const existed = Object.hasOwn(memory[normalizedCategory], normalizedKey);

    delete memory[normalizedCategory][normalizedKey];
    await saveMemory(memory);

    return {
      category: normalizedCategory,
      key: normalizedKey,
      deleted: existed,
    };
  }

  return {
    memoryPath: resolvedMemoryPath,
    loadMemory,
    saveMemory,
    readMemory,
    setMemoryEntry,
    deleteMemoryEntry,
  };
}

const defaultMemoryService = createMemoryService();

export const MEMORY_PATH = defaultMemoryService.memoryPath;
export const loadMemory = defaultMemoryService.loadMemory;
export const readMemory = defaultMemoryService.readMemory;
export const setMemoryEntry = defaultMemoryService.setMemoryEntry;
export const deleteMemoryEntry = defaultMemoryService.deleteMemoryEntry;
