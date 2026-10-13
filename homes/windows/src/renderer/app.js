const { getTimeGreeting, getUnavailableMessage } = window.SeleneViewState;

const appBody = document.querySelector('.app-body');
const sidebar = document.querySelector('.sidebar');
const sidebarToggle = document.querySelector('#sidebar-toggle');
const timeGreeting = document.querySelector('#time-greeting');
const composer = document.querySelector('#composer');
const composerInput = document.querySelector('#composer-input');
const composerStatus = document.querySelector('#composer-status');
const sendButton = document.querySelector('#send-button');

function applySidebarState(collapsed) {
  sidebar.dataset.collapsed = String(collapsed);
  appBody.dataset.sidebarCollapsed = String(collapsed);
  sidebarToggle.setAttribute('aria-expanded', String(!collapsed));

  const action = collapsed ? 'Expand' : 'Collapse';
  const accessibleLabel = `${action} sidebar`;
  sidebarToggle.setAttribute('aria-label', accessibleLabel);
  sidebarToggle.title = accessibleLabel;
}

async function initializeSidebar() {
  let collapsed = false;

  try {
    collapsed = await window.selenePreferences.getSidebarCollapsed();
  } catch {
    // The safe first-launch default is expanded.
  }

  applySidebarState(collapsed === true);
}

function resizeComposer() {
  composerInput.style.height = 'auto';
  composerInput.style.height = `${Math.min(composerInput.scrollHeight, 160)}px`;
}

function syncComposerState() {
  sendButton.disabled = composerInput.value.trim().length === 0;
  resizeComposer();
}

function showUnavailable(feature) {
  composerStatus.textContent = getUnavailableMessage(feature);
  composerStatus.classList.add('is-visible');
}

sidebarToggle.addEventListener('click', async () => {
  const previousValue = sidebar.dataset.collapsed === 'true';
  const nextValue = !previousValue;
  applySidebarState(nextValue);

  try {
    await window.selenePreferences.setSidebarCollapsed(nextValue);
  } catch {
    applySidebarState(previousValue);
  }
});

document.querySelector('[data-action="new-chat"]').addEventListener('click', () => {
  composerInput.focus();
});

document.querySelectorAll('[data-placeholder]').forEach((control) => {
  control.addEventListener('click', () => showUnavailable(control.dataset.placeholder));
});

composerInput.addEventListener('input', syncComposerState);
composerInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    if (!sendButton.disabled) {
      composer.requestSubmit();
    }
  }
});

composer.addEventListener('submit', (event) => {
  event.preventDefault();
  if (composerInput.value.trim().length > 0) {
    showUnavailable('conversation');
  }
});

timeGreeting.textContent = getTimeGreeting(new Date());
syncComposerState();
initializeSidebar();
