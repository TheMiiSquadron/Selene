const { getTimeGreeting, getUnavailableMessage, normalizeTheme } = window.SeleneViewState;

const appBody = document.querySelector('.app-body');
const sidebar = document.querySelector('.sidebar');
const sidebarToggle = document.querySelector('#sidebar-toggle');
const timeGreeting = document.querySelector('#time-greeting');
const composer = document.querySelector('#composer');
const composerInput = document.querySelector('#composer-input');
const composerStatus = document.querySelector('#composer-status');
const sendButton = document.querySelector('#send-button');
const homeView = document.querySelector('#home-view');
const settingsView = document.querySelector('#settings-view');
const newChatButton = document.querySelector('[data-action="new-chat"]');
const settingsButton = document.querySelector('[data-action="settings"]');
const settingsStatus = document.querySelector('#settings-status');
const themeChoices = Array.from(document.querySelectorAll('[data-theme-choice]'));

let currentTheme = 'obsidian';

function applySidebarState(collapsed) {
  sidebar.dataset.collapsed = String(collapsed);
  appBody.dataset.sidebarCollapsed = String(collapsed);
  sidebarToggle.setAttribute('aria-expanded', String(!collapsed));

  const action = collapsed ? 'Expand' : 'Collapse';
  const accessibleLabel = `${action} sidebar`;
  sidebarToggle.setAttribute('aria-label', accessibleLabel);
  sidebarToggle.title = accessibleLabel;
}

async function initializePreferences() {
  let collapsed = false;
  let theme = 'obsidian';

  try {
    [collapsed, theme] = await Promise.all([
      window.selenePreferences.getSidebarCollapsed(),
      window.selenePreferences.getTheme()
    ]);
  } catch {
    // Safe first-launch defaults are an expanded sidebar and Obsidian.
  }

  applySidebarState(collapsed === true);
  applyTheme(theme);
}

function applyTheme(theme) {
  currentTheme = normalizeTheme(theme);
  document.documentElement.dataset.theme = currentTheme;

  themeChoices.forEach((choice) => {
    const selected = choice.dataset.themeChoice === currentTheme;
    choice.classList.toggle('is-selected', selected);
    choice.setAttribute('aria-checked', String(selected));
  });
}

function showView(view) {
  const showSettings = view === 'settings';
  homeView.hidden = showSettings;
  settingsView.hidden = !showSettings;

  newChatButton.classList.toggle('is-current', !showSettings);
  settingsButton.classList.toggle('is-current', showSettings);
  if (showSettings) {
    newChatButton.removeAttribute('aria-current');
    settingsButton.setAttribute('aria-current', 'page');
  } else {
    newChatButton.setAttribute('aria-current', 'page');
    settingsButton.removeAttribute('aria-current');
  }
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

newChatButton.addEventListener('click', () => {
  showView('home');
  composerInput.focus();
});

settingsButton.addEventListener('click', () => {
  showView('settings');
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

themeChoices.forEach((choice) => {
  choice.addEventListener('click', async () => {
    const previousTheme = currentTheme;
    const requestedTheme = normalizeTheme(choice.dataset.themeChoice);
    applyTheme(requestedTheme);
    settingsStatus.textContent = `${choice.querySelector('.theme-choice-name').textContent} selected.`;

    try {
      const savedTheme = await window.selenePreferences.setTheme(requestedTheme);
      applyTheme(savedTheme);
    } catch {
      applyTheme(previousTheme);
      settingsStatus.textContent = 'The theme could not be saved. Your previous theme was restored.';
    }
  });
});

timeGreeting.textContent = getTimeGreeting(new Date());
syncComposerState();
initializePreferences();
