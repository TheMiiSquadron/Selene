import test from "node:test";
import assert from "node:assert/strict";
import {
  authorizeAction,
  authorizeToolAction,
  elevateAuthority,
  loadAuthorityConfig,
  resetAuthority,
  saveAuthorityConfig,
  setDefaultAuthority,
} from "./authority.js";

const baseConfig = {
  defaultLevel: 4,
  currentLevel: 4,
  temporaryElevation: null,
  oneActionElevation: null,
  alwaysConfirmActions: [],
  updatedAt: null,
};

test("allowed action below current level", () => {
  const decision = authorizeAction("open_app", baseConfig);

  assert.equal(decision.allowed, true);
  assert.equal(decision.requiredLevel, 3);
  assert.equal(decision.currentLevel, 4);
});

test("denied action above current level", () => {
  const decision = authorizeAction("close_window", baseConfig);

  assert.equal(decision.allowed, false);
  assert.equal(decision.needsApproval, true);
  assert.equal(decision.requiredLevel, 6);
  assert.equal(decision.currentLevel, 4);
  assert.match(decision.reason, /Level 6 - Control/);
});

test("temporary elevation allows higher-level action", () => {
  const decision = authorizeAction("close_window", {
    ...baseConfig,
    temporaryElevation: {
      level: 6,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    },
  });

  assert.equal(decision.allowed, true);
  assert.equal(decision.currentLevel, 6);
  assert.equal(decision.authoritySource, "temporary");
});

test("expired temporary elevation is ignored", () => {
  const decision = authorizeAction("close_window", {
    ...baseConfig,
    temporaryElevation: {
      level: 6,
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
    },
  });

  assert.equal(decision.allowed, false);
  assert.equal(decision.currentLevel, 4);
});

test("one-action elevation is consumed after one authorized action", async () => {
  const original = await loadAuthorityConfig();

  try {
    await setDefaultAuthority(4);
    const elevated = await elevateAuthority({ level: 6, oneAction: true });
    const token = elevated.oneActionElevation.token;

    const allowed = await authorizeToolAction("close_window", { authorityToken: token });
    assert.equal(allowed.allowed, true);
    assert.equal(allowed.authoritySource, "one_action");

    const after = await loadAuthorityConfig();
    assert.equal(after.oneActionElevation, null);

    const denied = await authorizeToolAction("close_window", { authorityToken: token });
    assert.equal(denied.allowed, false);
    assert.equal(denied.needsApproval, true);
  } finally {
    await saveAuthorityConfig(original);
  }
});

test("malformed authority token is rejected", async () => {
  const original = await loadAuthorityConfig();

  try {
    await setDefaultAuthority(4);
    await elevateAuthority({ level: 5, oneAction: true });

    const denied = await authorizeToolAction("type_text", {
      authorityToken: "not-the-issued-token",
    });

    assert.equal(denied.allowed, false);
    assert.equal(denied.needsApproval, true);
    assert.equal(denied.requiredLevel, 5);
    assert.equal(denied.currentLevel, 4);
  } finally {
    await saveAuthorityConfig(original);
  }
});

test("one-action elevation is not consumed by actions already allowed at current level", async () => {
  const original = await loadAuthorityConfig();

  try {
    await setDefaultAuthority(4);
    const elevated = await elevateAuthority({ level: 5, oneAction: true });
    const token = elevated.oneActionElevation.token;

    const launch = await authorizeToolAction("open_app", { authorityToken: token });
    assert.equal(launch.allowed, true);
    assert.equal(launch.authoritySource, "current");

    const afterLaunch = await loadAuthorityConfig();
    assert.equal(afterLaunch.oneActionElevation.token, token);

    const typing = await authorizeToolAction("type_text", { authorityToken: token });
    assert.equal(typing.allowed, true);
    assert.equal(typing.authoritySource, "one_action");

    const afterTyping = await loadAuthorityConfig();
    assert.equal(afterTyping.oneActionElevation, null);
  } finally {
    await saveAuthorityConfig(original);
  }
});

test("Level 4 blocks typing", () => {
  const decision = authorizeAction("type_text", baseConfig);

  assert.equal(decision.allowed, false);
  assert.equal(decision.needsApproval, true);
  assert.equal(decision.requiredLevel, 5);
  assert.equal(decision.currentLevel, 4);
});

test("Level 10 alwaysConfirm behavior scaffold denies without explicit confirmation path", () => {
  const decision = authorizeAction("critical_action", {
    ...baseConfig,
    currentLevel: 10,
  });

  assert.equal(decision.allowed, false);
  assert.equal(decision.needsApproval, true);
  assert.equal(decision.alwaysConfirm, true);
  assert.equal(decision.requiredLevel, 10);
});

test("reset returns current authority to the configured default", async () => {
  const original = await loadAuthorityConfig();

  try {
    await setDefaultAuthority(5);
    await elevateAuthority({ level: 6, minutes: 1 });
    const reset = await resetAuthority();

    assert.equal(reset.defaultLevel, 5);
    assert.equal(reset.currentLevel, 5);
    assert.equal(reset.temporaryElevation, null);
    assert.equal(reset.oneActionElevation, null);
  } finally {
    await saveAuthorityConfig(original);
  }
});

test("reset clears temporary and one-action elevation", async () => {
  const original = await loadAuthorityConfig();

  try {
    await setDefaultAuthority(4);
    await elevateAuthority({ level: 5, minutes: 5 });
    await elevateAuthority({ level: 5, oneAction: true });

    const reset = await resetAuthority();

    assert.equal(reset.defaultLevel, 4);
    assert.equal(reset.currentLevel, 4);
    assert.equal(reset.temporaryElevation, null);
    assert.equal(reset.oneActionElevation, null);
  } finally {
    await saveAuthorityConfig(original);
  }
});
