const STEPS = [
  "Welcome",
  "Local AI",
  "Applications",
  "Interface",
  "Privacy & Awareness",
  "Authority",
  "Personality",
  "Memory",
  "Test Selene",
  "Complete",
];

const pageTitle = document.querySelector("#page-title");
const progress = document.querySelector("#progress");
const pageContent = document.querySelector("#page-content");
const stepList = document.querySelector("#step-list");
const backButton = document.querySelector("#back-button");
const nextButton = document.querySelector("#next-button");
const statusPill = document.querySelector("#status-pill");

let stepIndex = 0;
let config;
let authorityLevels = [];
let coreApi;
let localAiStatus = null;
let applicationsStatus = null;
let applicationSaveMessage = "";
let isSaving = false;

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function checked(value) {
  return value ? "checked" : "";
}

function selected(value, expected) {
  return value === expected ? "selected" : "";
}

function policySelect(key, label, hint) {
  const value = config.privacy[key];
  return `
    <label class="policy-row">
      <div>
        <span>${label}</span>
        <small>${hint}</small>
      </div>
      <select data-path="privacy.${key}">
        <option value="allow" ${selected(value, "allow")}>Allow</option>
        <option value="ask" ${selected(value, "ask")}>Ask</option>
        <option value="deny" ${selected(value, "deny")}>Deny</option>
      </select>
    </label>
  `;
}

function checkbox(path, label, hint, value) {
  return `
    <label class="setting-row">
      <div>
        <span>${label}</span>
        <small>${hint}</small>
      </div>
      <input type="checkbox" data-path="${path}" ${checked(value)}>
    </label>
  `;
}

function setByPath(path, value) {
  const parts = path.split(".");
  let target = config;
  for (let index = 0; index < parts.length - 1; index += 1) {
    target = target[parts[index]];
  }
  target[parts.at(-1)] = value;
  statusPill.textContent = "draft";
}

function bindFields() {
  pageContent.querySelectorAll("[data-path]").forEach((field) => {
    field.addEventListener("input", () => {
      const value = field.type === "checkbox" ? field.checked : field.value;
      setByPath(field.dataset.path, value);
    });
    field.addEventListener("change", () => {
      const value = field.type === "checkbox" ? field.checked : field.value;
      setByPath(field.dataset.path, value);
    });
  });
}

function renderSteps() {
  stepList.innerHTML = STEPS.map((label, index) => `
    <li>
      <button type="button" class="${index === stepIndex ? "active" : ""}" data-step="${index}">
        <span class="step-index">${index + 1}</span>
        <span>${label}</span>
      </button>
    </li>
  `).join("");

  stepList.querySelectorAll("[data-step]").forEach((button) => {
    button.addEventListener("click", () => {
      persistDraft();
      stepIndex = Number(button.dataset.step);
      render();
    });
  });
}

function statusDot(ok) {
  return `<span class="dot ${ok ? "good" : "bad"}"></span>`;
}

function renderLocalAi() {
  const coreMessage = localAiStatus?.core?.message ?? "Not checked yet.";
  const lmMessage = localAiStatus?.lmStudio?.message ?? "Not checked yet.";
  const models = localAiStatus?.models ?? [];
  const activeModel = localAiStatus?.activeModel || "";
  const canSelectModel = Boolean(localAiStatus?.modelSelectionEnabled) && models.length > 0;
  const coreOnline = Boolean(localAiStatus?.core?.online);
  const coreDetails = coreOnline
    ? `Version: ${escapeHtml(localAiStatus?.core?.coreVersion || "unknown")} · Port: ${escapeHtml(localAiStatus?.core?.port || "unknown")}`
    : "Start Selene Core with npm run server, then test again.";

  return `
    <p class="copy">Selene Core owns routing and local AI. Setup reads Core status instead of storing provider/model state in Pebble.</p>
    <div class="status-grid">
      <div class="status-card">
        <div class="status-line">${statusDot(coreOnline)}<span>Selene Core</span></div>
        <p>${escapeHtml(coreMessage)}</p>
        <p class="note">${coreDetails}</p>
      </div>
      <div class="status-card">
        <div class="status-line">${statusDot(Boolean(localAiStatus?.lmStudio?.ok))}<span>LM Studio / model</span></div>
        <p>${escapeHtml(lmMessage)}</p>
      </div>
    </div>
    <div class="field-grid" style="margin-top:14px">
      ${canSelectModel ? `
        <label class="field">
          <span>Selected model</span>
          <select disabled>
            ${models.map((model) => `<option value="${escapeHtml(model)}" ${selected(activeModel, model)}>${escapeHtml(model)}</option>`).join("")}
          </select>
          <small>Model selection is displayed from Core. Pebble does not persist provider/model state.</small>
        </label>
      ` : `
        <label class="field">
          <span>Active model</span>
          <input type="text" value="${escapeHtml(activeModel || "Not detected")}" readonly>
          <small>${coreOnline ? "Read from Selene Core /status." : "Unavailable because Selene Core is offline."}</small>
        </label>
      `}
      <div class="status-card">
        <h3>Models reported by Core</h3>
        <p>${models.length ? models.map(escapeHtml).join("<br>") : "No model list reported by Core."}</p>
      </div>
    </div>
    <div class="inline-actions">
      <button type="button" id="check-ai" class="small-button">Test connection</button>
      ${(localAiStatus?.missingCoreEndpoints ?? []).map((endpoint) => `<span class="missing">Needs ${endpoint}</span>`).join("")}
    </div>
  `;
}

function renderApplications() {
  const apps = applicationsStatus?.applications ?? [];
  const coreUnavailable = applicationsStatus && !applicationsStatus.ok && !apps.length;

  if (!apps.length) {
    return `
      <p class="copy">Application launch permissions must come from Selene Core so Pebble does not maintain a second registry.</p>
      <div class="status-card">
        <div class="status-line">${statusDot(false)}<span>Applications unavailable</span></div>
        <p>${escapeHtml(applicationsStatus?.message ?? "Not checked yet.")}</p>
        <p class="note">${coreUnavailable ? "Setup is still usable, but app permissions cannot be edited until Core is online." : "Click Check Core applications to load the registry from Core."}</p>
      </div>
      <div class="inline-actions">
        <button type="button" id="load-apps" class="small-button">Check Core applications</button>
      </div>
    `;
  }

  return `
    <p class="copy">Choose which Core-approved applications Selene may launch.</p>
    <div class="option-grid">
      ${apps.map((app) => {
        const id = String(app.canonicalName ?? app.id ?? app.name ?? "");
        const name = String(app.canonicalName ?? app.name ?? id);
        const enabled = Boolean(app.enabled ?? app.allowed);
        return `
          <label class="app-row">
            <div>
              <span>${escapeHtml(name)}</span>
              <small>${enabled ? "Enabled" : "Disabled"} · ${escapeHtml(app.type ?? "unknown")}${Array.isArray(app.aliases) && app.aliases.length ? ` · aliases: ${escapeHtml(app.aliases.join(", "))}` : ""}</small>
            </div>
            <input type="checkbox" data-app-id="${escapeHtml(id)}" ${checked(enabled)}>
          </label>
        `;
      }).join("")}
    </div>
    <div class="inline-actions">
      <button type="button" id="load-apps" class="small-button">Refresh from Core</button>
      <span id="application-save-result" class="note">${escapeHtml(applicationSaveMessage)}</span>
    </div>
  `;
}

function renderPage() {
  if (stepIndex === 0) {
    return `
      <p class="copy">Selene is a local desktop companion: a small interface for talking to NOVA, this Windows PC, through Selene Core while keeping the Pebble layer focused on UI.</p>
      <label class="field">
        <span>What should Selene call you?</span>
        <input type="text" data-path="user.displayName" value="${escapeHtml(config.user.displayName)}" placeholder="Alex">
        <small>This stays in local app configuration.</small>
      </label>
    `;
  }

  if (stepIndex === 1) return renderLocalAi();
  if (stepIndex === 2) return renderApplications();

  if (stepIndex === 3) {
    return `
      <div class="option-grid">
        ${checkbox("interface.systemTray", "System tray", "Prepare Selene for tray access later.", config.interface.systemTray)}
        ${checkbox("interface.pebbleEnabled", "Pebble enabled", "Show the cursor-following Pebble interface.", config.interface.pebbleEnabled)}
        ${checkbox("interface.startWithWindows", "Start with Windows", "Preference only for now; startup registration is not changed.", config.interface.startWithWindows)}
        <label class="setting-row">
          <div>
            <span>Pebble visibility</span>
            <small>Choose whether it stays visible or is summoned later.</small>
          </div>
          <select data-path="interface.pebbleVisibility">
            <option value="always" ${selected(config.interface.pebbleVisibility, "always")}>Always visible</option>
            <option value="summon" ${selected(config.interface.pebbleVisibility, "summon")}>Summon when needed</option>
          </select>
        </label>
        <label class="field">
          <span>Global shortcut preference</span>
          <input type="text" data-path="interface.globalShortcut" value="${escapeHtml(config.interface.globalShortcut)}" placeholder="CommandOrControl+Space">
          <small>Setup tests registration before trusting the shortcut.</small>
        </label>
      </div>
      <div class="inline-actions">
        <button type="button" id="test-shortcut" class="small-button">Test shortcut</button>
        <span id="shortcut-result" class="note"></span>
      </div>
    `;
  }

  if (stepIndex === 4) {
    return `
      <p class="copy">Awareness defaults are conservative. These switches only save preferences; they do not start capture, monitoring, or microphone access.</p>
      <div class="option-grid">
        ${policySelect("activeWindowName", "Active window name", "Low sensitivity context for current task awareness.")}
        ${policySelect("clipboard", "Clipboard", "Potentially sensitive; ask before reading.")}
        ${policySelect("selectedText", "Selected text", "Potentially sensitive; ask before reading.")}
        ${policySelect("screenContents", "Screen contents", "Sensitive visual awareness; denied by default.")}
        ${policySelect("microphone", "Microphone", "Audio input; denied by default.")}
      </div>
    `;
  }

  if (stepIndex === 5) {
    return `
      <p class="copy">Authority is cumulative. Level 4 - Assist is recommended for the default, but this is only configuration for now; enforcement comes later.</p>
      <div class="authority-grid">
        ${authorityLevels.map((item) => `
          <label class="authority-row ${item.level === 4 ? "recommended" : ""}">
            <span class="level-number">${item.level}</span>
            <div>
              <span>${escapeHtml(item.title)}</span>
              <small>${escapeHtml(item.description)}</small>
            </div>
            <input type="radio" name="authority" value="${item.level}" ${checked(config.authority.defaultLevel === item.level)}>
          </label>
        `).join("")}
      </div>
    `;
  }

  if (stepIndex === 6) {
    return `
      <div class="field-grid">
        <label class="field">
          <span>Communication preset</span>
          <select data-path="personality.preset">
            <option value="professional" ${selected(config.personality.preset, "professional")}>Professional</option>
            <option value="friendly" ${selected(config.personality.preset, "friendly")}>Friendly</option>
            <option value="natural" ${selected(config.personality.preset, "natural")}>Natural</option>
            <option value="minimal" ${selected(config.personality.preset, "minimal")}>Minimal</option>
          </select>
        </label>
        ${checkbox("personality.humorOccasionally", "Use humor occasionally", "Keep it light when appropriate.", config.personality.humorOccasionally)}
        ${checkbox("personality.acknowledgeCompletedTasks", "Acknowledge completed tasks", "Confirm when work is done.", config.personality.acknowledgeCompletedTasks)}
        ${checkbox("personality.explainRoutineActions", "Explain routine actions", "Give brief context for ordinary actions.", config.personality.explainRoutineActions)}
        ${checkbox("personality.askWhenUncertain", "Ask when uncertain", "Pause for clarification when risk or ambiguity is high.", config.personality.askWhenUncertain)}
      </div>
    `;
  }

  if (stepIndex === 7) {
    return `
      <p class="copy">Memory is scaffolding only in Setup v1. These preferences do not create collection, storage, or retrieval behavior yet.</p>
      <div class="option-grid">
        ${checkbox("memory.preferences", "Preferences", "Remember user choices later.", config.memory.preferences)}
        ${checkbox("memory.appAliases", "App aliases", "Allow alias configuration later.", config.memory.appAliases)}
        ${checkbox("memory.projects", "Projects", "Project memory placeholder.", config.memory.projects)}
        ${checkbox("memory.conversationFacts", "Conversation facts", "Personal facts are off by default.", config.memory.conversationFacts)}
      </div>
    `;
  }

  if (stepIndex === 8) {
    return `
      <p class="copy">Send a real test command through Selene Core's existing <span class="missing">POST /command</span> API.</p>
      <label class="field">
        <span>Test command</span>
        <input type="text" id="test-command-input" value="Open Calculator">
      </label>
      <div class="inline-actions">
        <button type="button" id="run-test-command" class="small-button">Run test</button>
      </div>
      <div id="test-command-result" class="test-result"></div>
    `;
  }

  return `
    <p class="copy">Selene is ready.</p>
    <div class="status-card">
      <h3>Configuration</h3>
      <p>Setup will save local preferences and mark first-run onboarding complete. Closing this window before pressing Finish will not complete setup.</p>
    </div>
  `;
}

async function persistDraft() {
  if (isSaving || !config) return;
  isSaving = true;
  try {
    config = await window.novaSetup.saveDraft(config);
    statusPill.textContent = "saved";
  } finally {
    isSaving = false;
  }
}

function bindPageActions() {
  bindFields();

  pageContent.querySelector("#check-ai")?.addEventListener("click", async () => {
    localAiStatus = await window.novaSetup.checkLocalAi();
    render();
  });

  pageContent.querySelector("#load-apps")?.addEventListener("click", async () => {
    applicationsStatus = await window.novaSetup.getApplications();
    render();
  });

  pageContent.querySelectorAll("[data-app-id]").forEach((field) => {
    field.addEventListener("change", async () => {
      field.disabled = true;
      applicationSaveMessage = "Saving...";
      const patch = { [field.dataset.appId]: field.checked };
      const result = await window.novaSetup.setApplicationPermissions(patch);
      applicationSaveMessage = result.message;

      if (result.ok) {
        applicationsStatus = {
          ok: true,
          applications: result.applications,
          message: result.message,
          missingEndpoint: "",
        };
      } else {
        field.checked = !field.checked;
      }

      render();
    });
  });

  pageContent.querySelectorAll("input[name='authority']").forEach((field) => {
    field.addEventListener("change", () => {
      config.authority.defaultLevel = Number(field.value);
      statusPill.textContent = "draft";
    });
  });

  pageContent.querySelector("#test-shortcut")?.addEventListener("click", async () => {
    const resultNode = pageContent.querySelector("#shortcut-result");
    resultNode.textContent = "Testing...";
    const result = await window.novaSetup.testShortcut(config.interface.globalShortcut);
    resultNode.textContent = result.message;
  });

  pageContent.querySelector("#run-test-command")?.addEventListener("click", async () => {
    const input = pageContent.querySelector("#test-command-input");
    const resultNode = pageContent.querySelector("#test-command-result");
    resultNode.className = "test-result";
    resultNode.textContent = "Sending...";
    const result = await window.novaSetup.testCommand(input.value);
    resultNode.textContent = result.message;
    resultNode.classList.toggle("good", Boolean(result.ok));
    resultNode.classList.toggle("error", !result.ok);
  });
}

function render() {
  pageTitle.textContent = stepIndex === 0 ? "Meet Selene" : STEPS[stepIndex];
  progress.textContent = `${stepIndex + 1} of ${STEPS.length}`;
  pageContent.innerHTML = renderPage();
  backButton.disabled = stepIndex === 0;
  nextButton.textContent = stepIndex === STEPS.length - 1 ? "Finish" : "Next";
  renderSteps();
  bindPageActions();
}

backButton.addEventListener("click", () => {
  if (stepIndex === 0) return;
  persistDraft();
  stepIndex -= 1;
  render();
});

nextButton.addEventListener("click", async () => {
  if (stepIndex === STEPS.length - 1) {
    statusPill.textContent = "saving";
    await window.novaSetup.complete(config);
    return;
  }

  await persistDraft();
  stepIndex += 1;
  render();
});

async function init() {
  const initial = await window.novaSetup.getInitialState();
  config = initial.config;
  authorityLevels = initial.authorityLevels;
  coreApi = initial.coreApi;
  render();

  localAiStatus = await window.novaSetup.checkLocalAi();
  applicationsStatus = await window.novaSetup.getApplications();
  render();
}

init();
