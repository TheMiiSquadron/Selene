import test from "node:test";
import assert from "node:assert/strict";
import {
  elevateAuthority,
  loadAuthorityConfig,
  saveAuthorityConfig,
  setDefaultAuthority,
} from "./authority.js";
import { keyboardShortcut, typeText } from "./interact.js";
import { resolveShortcut } from "./shortcuts.js";

function createInputAdapter(overrides = {}) {
  return {
    typed: [],
    shortcuts: [],
    async typeText(text, options = {}) {
      this.typed.push({ text, options });
      return { ok: true };
    },
    async keyboardShortcut(shortcut, options = {}) {
      this.shortcuts.push({ shortcut, options });
      return { ok: true };
    },
    ...overrides,
  };
}

test("type_text requires Level 5", async () => {
  const original = await loadAuthorityConfig();

  try {
    await setDefaultAuthority(4);
    const result = await typeText("Hello", {
      inputAdapter: createInputAdapter(),
    });

    assert.equal(result.ok, false);
    assert.equal(result.needsApproval, true);
    assert.equal(result.action, "type_text");
    assert.equal(result.requiredLevel, 5);
    assert.equal(result.currentLevel, 4);
  } finally {
    await saveAuthorityConfig(original);
  }
});

test("Level 5 permits typing", async () => {
  const original = await loadAuthorityConfig();
  const adapter = createInputAdapter();

  try {
    await setDefaultAuthority(5);
    const result = await typeText("Hello", {
      inputAdapter: adapter,
      expectedWindowTitle: "Notepad",
    });

    assert.equal(result.ok, true);
    assert.equal(result.action, "type_text");
    assert.equal(result.typedCharacters, 5);
    assert.deepEqual(adapter.typed, [{
      text: "Hello",
      options: { expectedWindowTitle: "Notepad" },
    }]);
  } finally {
    await saveAuthorityConfig(original);
  }
});

test("unsupported shortcut is denied", async () => {
  const original = await loadAuthorityConfig();
  const adapter = createInputAdapter();

  try {
    await setDefaultAuthority(5);
    const result = await keyboardShortcut("alt+f4", {
      inputAdapter: adapter,
    });

    assert.equal(result.ok, false);
    assert.equal(result.action, "keyboard_shortcut");
    assert.match(result.reason, /Unsupported keyboard shortcut/);
    assert.equal(adapter.shortcuts.length, 0);
  } finally {
    await saveAuthorityConfig(original);
  }
});

test("supported shortcut is accepted", async () => {
  const original = await loadAuthorityConfig();
  const adapter = createInputAdapter();

  try {
    await setDefaultAuthority(5);
    const result = await keyboardShortcut("ctrl+a", {
      inputAdapter: adapter,
      expectedWindowTitle: "Notepad",
    });

    assert.equal(result.ok, true);
    assert.equal(result.shortcut, "ctrl+a");
    assert.deepEqual(adapter.shortcuts, [{
      shortcut: "ctrl+a",
      options: { expectedWindowTitle: "Notepad" },
    }]);
  } finally {
    await saveAuthorityConfig(original);
  }
});

test("keyboard_shortcut is blocked at Level 4", async () => {
  const original = await loadAuthorityConfig();

  try {
    await setDefaultAuthority(4);
    const result = await keyboardShortcut("ctrl+a", {
      inputAdapter: createInputAdapter(),
    });

    assert.equal(result.ok, false);
    assert.equal(result.needsApproval, true);
    assert.equal(result.action, "keyboard_shortcut");
    assert.equal(result.requiredLevel, 5);
    assert.equal(result.currentLevel, 4);
  } finally {
    await saveAuthorityConfig(original);
  }
});

test("one-action Level 5 approval can authorize one shortcut action", async () => {
  const original = await loadAuthorityConfig();

  try {
    await setDefaultAuthority(4);
    const elevated = await elevateAuthority({ level: 5, oneAction: true });
    const token = elevated.oneActionElevation.token;

    const result = await keyboardShortcut("ctrl+a", {
      authorityToken: token,
      inputAdapter: createInputAdapter(),
    });

    assert.equal(result.ok, true);

    const denied = await keyboardShortcut("ctrl+c", {
      authorityToken: token,
      inputAdapter: createInputAdapter(),
    });
    assert.equal(denied.ok, false);
    assert.equal(denied.needsApproval, true);
  } finally {
    await saveAuthorityConfig(original);
  }
});

test("keyboard shortcut focus mismatch fails safely", async () => {
  const original = await loadAuthorityConfig();

  try {
    await setDefaultAuthority(5);
    const result = await keyboardShortcut("ctrl+a", {
      expectedWindowTitle: "Notepad",
      inputAdapter: createInputAdapter({
        async keyboardShortcut() {
          return {
            ok: false,
            focusMismatch: true,
            reason: "wrong window",
          };
        },
      }),
    });

    assert.equal(result.ok, false);
    assert.equal(result.action, "keyboard_shortcut");
    assert.equal(result.message, "Keyboard shortcut cancelled.");
    assert.equal(result.reason, "The intended application is no longer in the foreground.");
  } finally {
    await saveAuthorityConfig(original);
  }
});

test("keyboard shortcut adapter receives process focus hints", async () => {
  const original = await loadAuthorityConfig();
  const adapter = createInputAdapter();

  try {
    await setDefaultAuthority(5);
    const result = await keyboardShortcut("ctrl+a", {
      expectedWindowTitle: "Notepad",
      expectedProcessId: 42,
      inputAdapter: adapter,
    });

    assert.equal(result.ok, true);
    assert.deepEqual(adapter.shortcuts, [{
      shortcut: "ctrl+a",
      options: {
        expectedWindowTitle: "Notepad",
        expectedProcessId: 42,
      },
    }]);
  } finally {
    await saveAuthorityConfig(original);
  }
});

test("one-action Level 5 approval can authorize one typing action", async () => {
  const original = await loadAuthorityConfig();

  try {
    await setDefaultAuthority(4);
    const elevated = await elevateAuthority({ level: 5, oneAction: true });
    const token = elevated.oneActionElevation.token;

    const result = await typeText("Hello", {
      authorityToken: token,
      inputAdapter: createInputAdapter(),
    });

    assert.equal(result.ok, true);

    const denied = await typeText("again", {
      authorityToken: token,
      inputAdapter: createInputAdapter(),
    });
    assert.equal(denied.ok, false);
    assert.equal(denied.needsApproval, true);
  } finally {
    await saveAuthorityConfig(original);
  }
});

test("focus mismatch fails safely", async () => {
  const original = await loadAuthorityConfig();

  try {
    await setDefaultAuthority(5);
    const result = await typeText("Hello", {
      expectedWindowTitle: "Notepad",
      inputAdapter: createInputAdapter({
        async typeText() {
          return {
            ok: false,
            focusMismatch: true,
            reason: "wrong window",
          };
        },
      }),
    });

    assert.equal(result.ok, false);
    assert.equal(result.action, "type_text");
    assert.equal(result.message, "Typing cancelled.");
    assert.equal(result.reason, "The intended application is no longer in the foreground.");
  } finally {
    await saveAuthorityConfig(original);
  }
});

test("shortcut aliases resolve to canonical arrow shortcuts", () => {
  assert.deepEqual(resolveShortcut("arrow left"), {
    id: "left",
    label: "Left Arrow",
    sendKeys: "{LEFT}",
  });
});
