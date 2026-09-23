const panel = document.querySelector("#panel");
const conversation = document.querySelector("#conversation");
const messageList = document.querySelector("#message-list");
const input = document.querySelector("#nova-input");
const sendButton = document.querySelector("#send-command");
const closeButton = document.querySelector("#close-panel");
const responseMessage = document.querySelector("#response-message");
const approvalCard = document.querySelector("#approval-card");
const pairingCard = document.querySelector("#pairing-card");
const pairingMessage = document.querySelector("#pairing-message");
const pairingBadge = document.querySelector("#pairing-badge");
const pairingSecretWrap = document.querySelector("#pairing-secret-wrap");
const pairingSecretText = document.querySelector("#pairing-secret");
const pairingExpiration = document.querySelector("#pairing-expiration");
const pairingSecureCoreButton = document.querySelector("#pairing-secure-core");
const pairingCheckButton = document.querySelector("#pairing-check");
const pairingStartButton = document.querySelector("#pairing-start");
const pairingCancelButton = document.querySelector("#pairing-cancel");
const stateSwitcher = document.querySelector("#state-switcher");
const statusText = document.querySelector("#panel-status-text");

const stateDefinitions = window.novaPanel.getStateDefinitions();
const stateById = new Map(
  stateDefinitions.states.map((state) => [state.id, state]),
);
const stateAliases = stateDefinitions.aliases ?? {};

const STATE_LABELS = {
  idle: "Ready",
  working: "Working",
  success: "Done",
  asking: "Needs approval",
  error: "Error",
  proactive: "New",
};

let currentState = "idle";
let isSubmitting = false;
let idleTimer = 0;
let resizeFrame = 0;
let lastRequestedHeight = -1;
let stateButtons = [];
let pendingApproval = null;
let approvalBusy = false;
let pairingState = window.SelenePairingPanelState.createInitialPairingState();
let pairingCountdownTimer = 0;
let pairingRefreshTimer = 0;
let pairingBusy = false;
const displayedProactiveNotifications = new Set();
const ACTIVE_STATES = new Set([
  "working",
  "asking",
  "error",
]);
const PAIRING_REFRESH_MS = 15000;


/* ============================================================
   General helpers
   ============================================================ */

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}


function normalizeState(state) {
  const normalized = String(state ?? "")
    .trim()
    .toLowerCase();

  const canonical =
    stateAliases[normalized] ??
    normalized;

  return stateById.has(canonical)
    ? canonical
    : "idle";
}


/* ============================================================
   Dynamic panel sizing
   ============================================================ */

/*
 * Measure Selene's natural content height without using the
 * live Electron window's current height.
 *
 * The previous approach could ratchet upward because:
 *
 *   Electron window grows
 *       ↓
 *   live panel reports that larger height
 *       ↓
 *   renderer asks Electron for the same large height again
 *
 * Instead, we clone the panel off-screen and remove all
 * height/overflow constraints from the clone before measuring.
 */
function measureIntrinsicPanelHeight() {
  if (!panel) {
    return 152;
  }

  const liveWidth =
    panel.getBoundingClientRect().width ||
    360;

  const clone = panel.cloneNode(true);

  clone.removeAttribute("id");

  clone.classList.remove(
    "panel--closed",
    "panel--height-capped",
  );

  clone.classList.add("panel--open");

  Object.assign(clone.style, {
    position: "fixed",
    left: "-10000px",
    top: "0",
    width: `${liveWidth}px`,
    height: "auto",
    minHeight: "0",
    maxHeight: "none",
    visibility: "hidden",
    opacity: "1",
    pointerEvents: "none",
    overflow: "visible",
    transform: "none",
    transition: "none",
  });

  /*
   * The conversation is normally the flexible/scrollable region.
   * For measurement, let it expand to its full natural height.
   */
  const cloneConversation =
    clone.querySelector("#conversation") ||
    clone.querySelector(".conversation");

  if (cloneConversation) {
    Object.assign(
      cloneConversation.style,
      {
        flex: "none",
        height: "auto",
        minHeight: "0",
        maxHeight: "none",
        overflow: "visible",
      },
    );
  }

  /*
   * Do the same for the message container in case CSS places a
   * max-height or scrolling constraint on it.
   */
  const cloneMessageList =
    clone.querySelector("#message-list");

  if (cloneMessageList) {
    Object.assign(
      cloneMessageList.style,
      {
        height: "auto",
        minHeight: "0",
        maxHeight: "none",
        overflow: "visible",
      },
    );
  }

  const cloneResponse =
    clone.querySelector("#response-message");

  if (cloneResponse) {
    Object.assign(
      cloneResponse.style,
      {
        height: "auto",
        minHeight: "0",
        maxHeight: "none",
        overflow: "visible",
      },
    );
  }

  document.body.appendChild(clone);

  const measured = Math.ceil(
    Math.max(
      clone.scrollHeight,
      clone.getBoundingClientRect().height,
    ),
  );

  clone.remove();

  return Math.max(152, measured);
}


function requestPanelResize({
  force = false,
} = {}) {
  if (resizeFrame) {
    cancelAnimationFrame(resizeFrame);
  }

  resizeFrame = requestAnimationFrame(() => {
    resizeFrame = 0;

    const height =
      measureIntrinsicPanelHeight();

    /*
     * Avoid a resize feedback loop when nothing actually changed.
     */
    if (
      !force &&
      height === lastRequestedHeight
    ) {
      return;
    }

    lastRequestedHeight = height;

    window.novaPanel.resizeToContent(
      height,
    );
  });
}


function resetResizeMeasurement() {
  lastRequestedHeight = -1;

  requestPanelResize({
    force: true,
  });
}


/* ============================================================
   Conversation scrolling
   ============================================================ */

function scrollConversationToBottom() {
  requestAnimationFrame(() => {
    if (conversation) {
      conversation.scrollTop =
        conversation.scrollHeight;
    }

    if (messageList) {
      const lastMessage =
        messageList.lastElementChild;

      lastMessage?.scrollIntoView({
        block: "end",
      });
    }
  });
}


/* ============================================================
   Chat history
   ============================================================ */

function appendMessage(
  role,
  message,
  {
    error = false,
  } = {},
) {
  const text = String(message ?? "").trim();

  if (!text || !messageList) {
    return null;
  }

  const item =
    document.createElement("div");

  item.className =
    `chat-message chat-message--${role}`;

  if (error) {
    item.classList.add(
      "chat-message--error",
    );
  }

  const bubble =
    document.createElement("div");

  bubble.className = "chat-bubble";
  bubble.textContent = text;

  item.appendChild(bubble);
  messageList.appendChild(item);

  requestPanelResize();
  scrollConversationToBottom();

  return item;
}


function appendUserMessage(message) {
  return appendMessage(
    "user",
    message,
  );
}


function appendSeleneMessage(
  message,
  options = {},
) {
  return appendMessage(
    "selene",
    message,
    options,
  );
}


/* ============================================================
   Transient activity message
   ============================================================ */

function showActivity(
  message,
  variant = "normal",
) {
  if (!responseMessage) {
    return;
  }

  responseMessage.textContent =
    String(message ?? "");

  responseMessage.classList.toggle(
    "error",
    variant === "error",
  );

  responseMessage.hidden = false;

  requestPanelResize();
  scrollConversationToBottom();
}


function clearActivity() {
  if (!responseMessage) {
    return;
  }

  responseMessage.textContent = "";
  responseMessage.classList.remove(
    "error",
  );

  responseMessage.hidden = true;

  requestPanelResize();
}


/* ============================================================
   Pebble state
   ============================================================ */

function setState(state) {
  currentState =
    normalizeState(state);

  panel.dataset.state =
    currentState;

  if (statusText) {
    statusText.textContent =
      STATE_LABELS[currentState] ??
      stateById.get(currentState)?.label ??
      "Ready";
  }

  stateButtons.forEach((button) => {
    button.classList.toggle(
      "active",
      button.dataset.state === currentState,
    );
  });

  window.novaPanel.setPebbleState(
    currentState,
  );
}


function shouldDeferProactiveDisplay() {
  return ACTIVE_STATES.has(currentState);
}


function scheduleIdle(delayMs) {
  window.clearTimeout(idleTimer);

  idleTimer = window.setTimeout(
    () => {
      setState("idle");
    },
    delayMs,
  );
}


/* ============================================================
   Busy state
   ============================================================ */

function setBusy(busy) {
  isSubmitting =
    Boolean(busy);

  input.disabled =
    isSubmitting;

  if (sendButton) {
    sendButton.disabled =
      isSubmitting;
  }

  stateButtons.forEach((button) => {
    button.disabled =
      isSubmitting;
  });

  requestPanelResize();
}


/* ============================================================
   Authority helpers
   ============================================================ */

function isValidAuthorityLevel(level) {
  return (
    Number.isInteger(level) &&
    level >= 1 &&
    level <= 10
  );
}


function clearApprovalCard() {
  pendingApproval = null;
  approvalBusy = false;

  approvalCard.hidden = true;
  approvalCard.innerHTML = "";

  requestPanelResize();
}


function setApprovalBusy(busy) {
  approvalBusy =
    Boolean(busy);

  approvalCard
    .querySelectorAll(
      "button, select",
    )
    .forEach((control) => {
      control.disabled =
        approvalBusy;
    });

  requestPanelResize();
}


function showApprovalStatus(
  message,
  variant = "normal",
) {
  const status =
    approvalCard.querySelector(
      "#approval-status",
    );

  if (!status) {
    return;
  }

  status.textContent =
    String(message ?? "");

  status.classList.toggle(
    "error",
    variant === "error",
  );

  status.classList.toggle(
    "good",
    variant === "good",
  );

  requestPanelResize();
  scrollConversationToBottom();
}


/* ============================================================
   Approval card
   ============================================================ */

function renderApprovalCard(
  decision,
  originalCommand,
) {
  const requiredLevel =
    Number(decision.requiredLevel);

  const currentLevel =
    Number(decision.currentLevel);

  if (
    !isValidAuthorityLevel(requiredLevel) ||
    !isValidAuthorityLevel(currentLevel)
  ) {
    clearActivity();

    appendSeleneMessage(
      "Selene Core returned an invalid authority decision.",
      {
        error: true,
      },
    );

    setState("error");
    scheduleIdle(1400);

    return;
  }

  pendingApproval = {
    originalCommand,

    decision: {
      action:
        String(
          decision.action ??
          "unknown",
        ),

      currentLevel,
      requiredLevel,

      reason:
        String(
          decision.reason ??
          decision.message ??
          "Approval required.",
        ),

      alwaysConfirm:
        Boolean(
          decision.alwaysConfirm,
        ),
    },
  };

  const safeAction =
    escapeHtml(
      pendingApproval.decision.action,
    );

  const safeReason =
    escapeHtml(
      pendingApproval.decision.reason,
    );

  approvalCard.innerHTML = `
    <div class="approval-header">
      <span>Approval required</span>
      <span class="approval-badge">asking</span>
    </div>

    <dl class="approval-facts">
      <div>
        <dt>Action</dt>
        <dd>${safeAction}</dd>
      </div>

      <div>
        <dt>Current</dt>
        <dd>Level ${currentLevel}</dd>
      </div>

      <div>
        <dt>Required</dt>
        <dd>Level ${requiredLevel}</dd>
      </div>
    </dl>

    <p class="approval-reason">
      ${safeReason}
    </p>

    ${
      pendingApproval.decision.alwaysConfirm
        ? `
          <p class="approval-note">
            This action requires explicit approval even at Level 10.
          </p>
        `
        : ""
    }

    <div class="approval-actions">
      <button
        type="button"
        class="approval-button approval-button--primary"
        data-approval="once"
      >
        Allow once
      </button>

      <label class="duration-field">
        <span>Temporary</span>

        <select id="approval-duration">
          <option value="5">
            5 minutes
          </option>

          <option value="15">
            15 minutes
          </option>

          <option value="30">
            30 minutes
          </option>
        </select>
      </label>

      <button
        type="button"
        class="approval-button"
        data-approval="temporary"
      >
        Allow temporarily
      </button>

      <button
        type="button"
        class="approval-button"
        data-approval="deny"
      >
        Deny
      </button>
    </div>

    <div
      id="approval-status"
      class="approval-status"
    ></div>
  `;

  approvalCard.hidden = false;

  clearActivity();
  setApprovalBusy(false);
  setState("asking");

  requestPanelResize();
  scrollConversationToBottom();
}


/* ============================================================
   Retry approved command
   ============================================================ */

async function retryApprovedCommand(
  authorityToken = "",
) {
  if (!pendingApproval) {
    return;
  }

  const originalCommand =
    pendingApproval.originalCommand;

  setState("working");

  showApprovalStatus(
    "Retrying...",
  );

  const result =
    await window.novaPanel.submitCommand({
      text: originalCommand,
      authorityToken,
    });

  if (result.ok) {
    clearApprovalCard();
    clearActivity();

    appendSeleneMessage(
      result.message ||
      "Done.",
    );

    setState("success");
    scheduleIdle(900);

    input.focus();

    return;
  }

  if (result.needsApproval) {
    renderApprovalCard(
      result,
      originalCommand,
    );

    input.focus();

    return;
  }

  clearApprovalCard();
  clearActivity();

  appendSeleneMessage(
    result.message ||
    "The approved command failed.",
    {
      error: true,
    },
  );

  setState("error");
  scheduleIdle(1400);

  input.focus();
}


/* ============================================================
   Authority actions
   ============================================================ */

async function allowOnce() {
  if (
    !pendingApproval ||
    approvalBusy
  ) {
    return;
  }

  setApprovalBusy(true);

  showApprovalStatus(
    "Requesting one-action approval...",
  );

  const result =
    await window.novaPanel.elevateAuthority({
      level:
        pendingApproval
          .decision
          .requiredLevel,

      oneAction: true,
    });

  if (
    !result.ok ||
    !result.oneActionElevation?.token
  ) {
    showApprovalStatus(
      result.message ||
      "Approval failed.",
      "error",
    );

    setApprovalBusy(false);

    return;
  }

  await retryApprovedCommand(
    result.oneActionElevation.token,
  );

  setApprovalBusy(false);
}


async function allowTemporarily() {
  if (
    !pendingApproval ||
    approvalBusy
  ) {
    return;
  }

  const selectedMinutes =
    Number(
      approvalCard
        .querySelector(
          "#approval-duration",
        )
        ?.value,
    );

  if (
    ![5, 15, 30]
      .includes(selectedMinutes)
  ) {
    showApprovalStatus(
      "Choose 5, 15, or 30 minutes.",
      "error",
    );

    return;
  }

  setApprovalBusy(true);

  showApprovalStatus(
    `Requesting ${selectedMinutes} minute approval...`,
  );

  const result =
    await window.novaPanel.elevateAuthority({
      level:
        pendingApproval
          .decision
          .requiredLevel,

      minutes:
        selectedMinutes,
    });

  if (!result.ok) {
    showApprovalStatus(
      result.message ||
      "Approval failed.",
      "error",
    );

    setApprovalBusy(false);

    return;
  }

  await retryApprovedCommand();

  setApprovalBusy(false);
}


function denyApproval() {
  if (
    !pendingApproval ||
    approvalBusy
  ) {
    return;
  }

  clearApprovalCard();
  clearActivity();

  appendSeleneMessage(
    "Denied.",
  );

  setState("idle");

  input.focus();
}


/* ============================================================
   Submit command
   ============================================================ */

async function submitCommand() {
  if (isSubmitting) {
    return;
  }

  const text =
    input.value.trim();

  if (!text) {
    return;
  }

  window.clearTimeout(
    idleTimer,
  );

  clearApprovalCard();
  clearActivity();

  appendUserMessage(text);

  /*
   * Clear immediately so the composer feels like a chat input.
   * The original command is preserved separately if approval
   * is later required.
   */
  input.value = "";

  setBusy(true);
  setState("working");

  showActivity(
    "Working...",
  );

  try {
    const result =
      await window.novaPanel.submitCommand({
        text,
      });

    if (result.ok) {
      clearActivity();

      appendSeleneMessage(
        result.message ||
        "Done.",
      );

      setState("success");
      scheduleIdle(900);
    }

    else if (
      result.needsApproval
    ) {
      setBusy(false);

      renderApprovalCard(
        result,
        text,
      );

      input.focus();

      return;
    }

    else {
      clearActivity();

      appendSeleneMessage(
        result.message ||
        "Selene Core returned an error.",
        {
          error: true,
        },
      );

      setState("error");
      scheduleIdle(1400);
    }
  }

  catch (error) {
    clearActivity();

    appendSeleneMessage(
      error?.message ||
      "Selene Core could not be reached.",
      {
        error: true,
      },
    );

    setState("error");
    scheduleIdle(1400);
  }

  finally {
    setBusy(false);
    input.focus();
  }
}


/* ============================================================
   Panel open / close
   ============================================================ */

function markOpen() {
  panel.classList.remove(
    "panel--closed",
  );

  panel.classList.add(
    "panel--open",
  );

  startPairingTimers();
  void refreshPairingStatus();

  /*
   * Force a fresh intrinsic measurement on every open.
   */
  lastRequestedHeight = -1;

  requestAnimationFrame(() => {
    input.focus();

    requestPanelResize({
      force: true,
    });

    scrollConversationToBottom();
  });
}


async function handleProactiveNotifications(notifications) {
  if (!Array.isArray(notifications) || shouldDeferProactiveDisplay()) {
    return;
  }

  const unseen = notifications.filter((notification) => {
    const id = String(notification?.id ?? "").trim();
    const message = String(notification?.message ?? "").trim();

    return id && message && !displayedProactiveNotifications.has(id);
  });

  if (!unseen.length) {
    return;
  }

  window.clearTimeout(idleTimer);
  setState("proactive");

  for (const notification of unseen) {
    const id = String(notification.id).trim();
    const message = String(notification.message).trim();

    displayedProactiveNotifications.add(id);
    appendSeleneMessage(message);

    await window.novaPanel.acknowledgeNotification(id);
  }

  setState("idle");
  input.focus();
}


/* ============================================================
   Pairing UI
   ============================================================ */

function setPairingState(nextState) {
  pairingState = nextState;
  renderPairingCard();
}

function formatPairingTime(value) {
  if (!value) return "";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "";

  return date.toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  });
}

function pairingSecondsRemaining() {
  const expiresAtMs = pairingState.session?.expiresAtMs;
  if (!Number.isFinite(expiresAtMs)) return null;
  return Math.max(0, Math.ceil((expiresAtMs - Date.now()) / 1000));
}

function renderPairingCard() {
  if (!pairingCard) return;

  const hasSecret = typeof pairingState.pairingSecret === "string"
    && pairingState.pairingSecret.length > 0
    && pairingState.phase === "active";
  const canStart = pairingState.availability === "available"
    && !pairingBusy
    && pairingState.phase !== "active";
  const canCancel = pairingState.availability === "available"
    && !pairingBusy
    && pairingState.phase === "active";
  const canStartSecureCore = pairingState.availability !== "available"
    && pairingState.phase === "no-core"
    && pairingState.secureCoreBusy !== true;
  const canCheckAgain = pairingState.availability !== "available"
    && pairingState.secureCoreBusy !== true;

  if (pairingMessage) {
    const remaining = pairingSecondsRemaining();
    pairingMessage.textContent = remaining !== null && pairingState.phase === "active"
      ? `${pairingState.message} Expires in ${remaining}s.`
      : pairingState.message;
  }

  if (pairingBadge) {
    pairingBadge.textContent = ({
      unavailable: "Unavailable",
      ready: "Ready",
      active: "Active",
      expired: "Expired",
      "no-core": "Secure Core required",
      "external-core": "External Core",
      "secure-core-launching": "Starting",
      "secure-core-connecting": "Securing",
      "secure-core-failed": "Check",
      error: "Check",
    })[pairingState.phase] ?? "Unavailable";
  }

  if (pairingSecretWrap) {
    pairingSecretWrap.hidden = !hasSecret;
  }

  if (pairingSecretText) {
    pairingSecretText.textContent = hasSecret
      ? pairingState.pairingSecret
      : "";
  }

  if (pairingExpiration) {
    const expiration = formatPairingTime(pairingState.session?.expiresAt);
    pairingExpiration.textContent = expiration
      ? `Expires at ${expiration}`
      : "";
  }

  if (pairingStartButton) {
    pairingStartButton.disabled = !canStart;
    pairingStartButton.hidden = pairingState.availability !== "available";
  }

  if (pairingCancelButton) {
    pairingCancelButton.disabled = !canCancel;
    pairingCancelButton.hidden = pairingState.availability !== "available";
  }

  if (pairingSecureCoreButton) {
    pairingSecureCoreButton.disabled = !canStartSecureCore;
    pairingSecureCoreButton.hidden = pairingState.availability === "available";
  }

  if (pairingCheckButton) {
    pairingCheckButton.disabled = !canCheckAgain;
    pairingCheckButton.hidden = pairingState.availability === "available";
  }

  requestPanelResize();
}

function clearDisplayedPairingSecret(message = pairingState.message) {
  setPairingState(
    window.SelenePairingPanelState.clearSecret(
      pairingState,
      message,
    ),
  );
}

function stopPairingTimers() {
  if (pairingCountdownTimer) {
    window.clearInterval(pairingCountdownTimer);
    pairingCountdownTimer = 0;
  }

  if (pairingRefreshTimer) {
    window.clearInterval(pairingRefreshTimer);
    pairingRefreshTimer = 0;
  }
}

function updatePairingExpiration() {
  const nextState =
    window.SelenePairingPanelState.expireIfNeeded(
      pairingState,
      Date.now(),
    );

  if (nextState !== pairingState) {
    setPairingState(nextState);
    return;
  }

  renderPairingCard();
}

async function refreshPairingStatus() {
  try {
    const response =
      await window.novaPanel.getPairingStatus();
    setPairingState(
      window.SelenePairingPanelState.applyStatus(
        pairingState,
        response,
        Date.now(),
      ),
    );
  } catch {
    setPairingState(
      window.SelenePairingPanelState.applyUnavailable(
        pairingState,
        "Secure pairing status is unavailable.",
      ),
    );
  }
}

async function startSecureCoreFromUi() {
  if (pairingBusy || pairingState.secureCoreBusy) return;

  setPairingState(
    window.SelenePairingPanelState.withSecureCoreBusy(
      {
        ...pairingState,
        phase: "secure-core-launching",
        message: "Starting Secure Core…",
      },
      true,
    ),
  );

  try {
    const response =
      await window.novaPanel.startSecureCore();
    setPairingState(
      window.SelenePairingPanelState.applySecureCoreStartResult(
        pairingState,
        response,
      ),
    );
    if (response?.ok === true) {
      await refreshPairingStatus();
    }
  } catch {
    setPairingState(
      window.SelenePairingPanelState.applySecureCoreStartResult(
        pairingState,
        {
          ok: false,
          state: "secure-core-failed",
          message: "Secure Core launch failed.",
        },
      ),
    );
  }
}

function startPairingTimers() {
  if (!pairingCountdownTimer) {
    pairingCountdownTimer = window.setInterval(
      updatePairingExpiration,
      1000,
    );
  }

  if (!pairingRefreshTimer) {
    pairingRefreshTimer = window.setInterval(
      () => {
        void refreshPairingStatus();
      },
      PAIRING_REFRESH_MS,
    );
  }
}

async function startPairingFromUi() {
  if (pairingBusy) return;

  pairingBusy = true;
  setPairingState(
    window.SelenePairingPanelState.withBusy(
      pairingState,
      true,
    ),
  );

  try {
    const response =
      await window.novaPanel.startPairing();
    setPairingState(
      window.SelenePairingPanelState.applyStartResult(
        pairingState,
        response,
        Date.now(),
      ),
    );
  } catch {
    setPairingState(
      window.SelenePairingPanelState.applyUnavailable(
        pairingState,
        "Pairing could not be started.",
      ),
    );
  } finally {
    pairingBusy = false;
    setPairingState(
      window.SelenePairingPanelState.withBusy(
        pairingState,
        false,
      ),
    );
  }
}

async function cancelPairingFromUi() {
  if (pairingBusy) return;

  pairingBusy = true;
  clearDisplayedPairingSecret("Cancelling pairing…");
  setPairingState(
    window.SelenePairingPanelState.withBusy(
      pairingState,
      true,
    ),
  );

  try {
    const response =
      await window.novaPanel.cancelPairing();
    setPairingState(
      window.SelenePairingPanelState.applyCancelResult(
        pairingState,
        response,
      ),
    );
  } catch {
    setPairingState(
      window.SelenePairingPanelState.applyCancelResult(
        pairingState,
        {
          ok: false,
          message: "Secure Core pairing cancellation could not be confirmed.",
        },
      ),
    );
  } finally {
    pairingBusy = false;
    setPairingState(
      window.SelenePairingPanelState.withBusy(
        pairingState,
        false,
      ),
    );
  }
}


function markClosing() {
  stopPairingTimers();
  clearDisplayedPairingSecret(
    "Pairing display cleared.",
  );

  panel.classList.remove(
    "panel--open",
  );

  panel.classList.add(
    "panel--closed",
  );
}


/* ============================================================
   Event listeners
   ============================================================ */

closeButton?.addEventListener(
  "click",
  () => {
    window.novaPanel.close();
  },
);


sendButton?.addEventListener(
  "click",
  () => {
    submitCommand();
  },
);


input.addEventListener(
  "keydown",
  (event) => {
    if (
      event.key === "Escape"
    ) {
      event.preventDefault();

      window.novaPanel.close();

      return;
    }

    if (
      event.key === "Enter" &&
      !event.shiftKey
    ) {
      event.preventDefault();

      submitCommand();
    }
  },
);


window.addEventListener(
  "keydown",
  (event) => {
    if (
      event.key === "Escape"
    ) {
      event.preventDefault();

      window.novaPanel.close();
    }
  },
);


approvalCard.addEventListener(
  "click",
  (event) => {
    const button =
      event.target.closest(
        "[data-approval]",
      );

    if (
      !button ||
      approvalBusy
    ) {
      return;
    }

    event.preventDefault();

    switch (
      button.dataset.approval
    ) {
      case "once":
        allowOnce();
        break;

      case "temporary":
        allowTemporarily();
        break;

      case "deny":
        denyApproval();
        break;

      default:
        break;
    }
  },
);


pairingStartButton?.addEventListener(
  "click",
  () => {
    void startPairingFromUi();
  },
);


pairingCancelButton?.addEventListener(
  "click",
  () => {
    void cancelPairingFromUi();
  },
);


pairingSecureCoreButton?.addEventListener(
  "click",
  () => {
    void startSecureCoreFromUi();
  },
);


pairingCheckButton?.addEventListener(
  "click",
  () => {
    void refreshPairingStatus();
  },
);


window.addEventListener(
  "beforeunload",
  () => {
    stopPairingTimers();
    clearDisplayedPairingSecret();
  },
);


/* ============================================================
   Debug state controls
   ============================================================ */

function renderStateControls() {
  if (!stateSwitcher) {
    return;
  }

  stateSwitcher.innerHTML =
    stateDefinitions.states
      .map(
        (state) => `
          <button
            type="button"
            class="state-button"
            data-state="${escapeHtml(state.id)}"
            title="${escapeHtml(state.meaning)}"
          >
            ${escapeHtml(state.label)}
          </button>
        `,
      )
      .join("");

  stateButtons = [
    ...stateSwitcher.querySelectorAll(
      "[data-state]",
    ),
  ];

  stateButtons.forEach(
    (button) => {
      button.addEventListener(
        "click",
        () => {
          setState(
            button.dataset.state,
          );
        },
      );
    },
  );

  setState(currentState);
}


/* ============================================================
   Debug API
   ============================================================ */

window.SelenePanelDebug = {
  getAuthority() {
    return window.novaPanel.getAuthority();
  },

  setState,

  getState() {
    return currentState;
  },

  measureHeight() {
    return measureIntrinsicPanelHeight();
  },

  resize() {
    resetResizeMeasurement();
  },
};


/*
 * Legacy compatibility alias.
 */
window.NovaPanelDebug =
  window.SelenePanelDebug;


/* ============================================================
   Electron bridge
   ============================================================ */

window.novaPanel.onOpened(
  markOpen,
);

window.novaPanel.onClosing(
  markClosing,
);

window.novaPanel.onRequestHeight(
  () => {
    resetResizeMeasurement();
  },
);

window.novaPanel.onResizeState(
  ({
    height,
    maxHeight,
  }) => {
    document.documentElement
      .style
      .setProperty(
        "--panel-window-height",
        `${height}px`,
      );

    panel.classList.toggle(
      "panel--height-capped",
      Boolean(maxHeight),
    );

    /*
     * When capped, conversation scrolling handles the excess.
     * Do not use this actual window height as the next natural
     * content measurement.
     */
    scrollConversationToBottom();
  },
);

window.novaPanel.onProactiveNotifications(
  (notifications) => {
    void handleProactiveNotifications(notifications);
  },
);


/* ============================================================
   Resize observation
   ============================================================ */

/*
 * Observe relevant inner content, not the panel itself.
 *
 * Watching the panel directly can fire merely because Electron
 * changed the window height, which is exactly the feedback loop
 * we're avoiding.
 */
const resizeObserver =
  new ResizeObserver(() => {
    requestPanelResize();
  });


if (messageList) {
  resizeObserver.observe(
    messageList,
  );
}


if (responseMessage) {
  resizeObserver.observe(
    responseMessage,
  );
}


if (approvalCard) {
  resizeObserver.observe(
    approvalCard,
  );
}


if (pairingCard) {
  resizeObserver.observe(
    pairingCard,
  );
}


/* ============================================================
   Start
   ============================================================ */

renderStateControls();

clearActivity();

renderPairingCard();

requestAnimationFrame(() => {
  resetResizeMeasurement();
});
