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
const conversationView = document.querySelector('#conversation-view');
const destinationView = document.querySelector('#destination-view');
const destinationButtons = Array.from(document.querySelectorAll('[data-destination]'));
const contextHeading = document.querySelector('#context-heading');
const composerHomeParent = document.querySelector('#home-view');
const conversationComposerWrap = document.querySelector('.conversation-composer-wrap');
const homeButton = document.querySelector('[data-action="home"]');
const newChatButton = document.querySelector('[data-action="new-chat"]');
const settingsButton = document.querySelector('[data-action="settings"]');
const settingsStatus = document.querySelector('#settings-status');
const themeChoices = Array.from(document.querySelectorAll('[data-theme-choice]'));

let currentTheme = 'obsidian';

const COMPOSER_SINGLE_LINE_HEIGHT = 40;
const COMPOSER_MAX_EXPANDED_INPUT_HEIGHT = 112;

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

function setCurrentNavigation(control) {
  [homeButton, newChatButton, settingsButton].forEach((button) => {
    const current = button === control;
    button.classList.toggle('is-current', current);
    if (current) {
      button.setAttribute('aria-current', 'page');
    } else {
      button.removeAttribute('aria-current');
    }
  });
}

function showView(view, activeNavigation = homeButton) {
  if (composer.parentElement !== composerHomeParent) {
    composerHomeParent.insertBefore(composer, document.querySelector('#composer-status'));
  }
  const showSettings = view === 'settings';
  homeView.hidden = showSettings;
  settingsView.hidden = !showSettings;
  conversationView.hidden = true;
  destinationView.hidden = true;
  const destination = showSettings ? 'settings' : 'home';
  destinationButtons.forEach((button) => { button.classList.toggle('is-current', button.dataset.destination === destination); });
  contextHeading.textContent = showSettings ? 'Settings' : 'Home';
  setCurrentNavigation(showSettings ? settingsButton : activeNavigation);
}

function resizeComposer() {
  composer.classList.remove('is-expanded');
  composerInput.style.height = 'auto';
  const isExpanded = composerInput.scrollHeight > COMPOSER_SINGLE_LINE_HEIGHT;
  composer.classList.toggle('is-expanded', isExpanded);
  composerInput.style.height = 'auto';
  const maximumHeight = isExpanded
    ? COMPOSER_MAX_EXPANDED_INPUT_HEIGHT
    : COMPOSER_SINGLE_LINE_HEIGHT;
  composerInput.style.height = `${Math.min(composerInput.scrollHeight, maximumHeight)}px`;
}

function syncComposerState() {
  sendButton.disabled = composerInput.value.trim().length === 0;
  resizeComposer();
}

function showUnavailable(feature) {
  composerStatus.textContent = getUnavailableMessage(feature);
  composerStatus.classList.add('is-visible');
}

function openDestination(destination) {
  if (destination === 'home' || destination === 'settings') {
    showView(destination);
    return;
  }
  if (composer.parentElement !== composerHomeParent) {
    composerHomeParent.insertBefore(composer, document.querySelector('#composer-status'));
  }
  homeView.hidden = true;
  settingsView.hidden = true;
  conversationView.hidden = true;
  destinationView.hidden = false;
  const title = destination.charAt(0).toUpperCase() + destination.slice(1);
  contextHeading.textContent = title;
  document.querySelector('#destination-title').textContent = title;
  document.querySelector('#destination-description').textContent =
    destination === 'devices' ? 'Device connections will appear when Selene Core is connected.' :
    destination === 'projects' ? 'Project navigation and content are not connected yet.' :
    'Your files and generated artifacts will appear here when Library is connected.';
  destinationButtons.forEach((button) => button.classList.toggle('is-current', button.dataset.destination === destination));
  setCurrentNavigation(null);
}

destinationButtons.forEach((button) => button.addEventListener('click', () => openDestination(button.dataset.destination)));
document.querySelector('[data-action="projects"]').addEventListener('click', () => openDestination('projects'));
document.querySelector('[data-action="devices"]').addEventListener('click', () => openDestination('devices'));
document.querySelector('#preview-conversation').addEventListener('click', () => {
  homeView.hidden = true;
  settingsView.hidden = true;
  destinationView.hidden = true;
  conversationView.hidden = false;
  conversationComposerWrap.appendChild(composer);
  contextHeading.textContent = 'Home';
  destinationButtons.forEach((button) => button.classList.toggle('is-current', button.dataset.destination === 'home'));
});
document.querySelector('#close-conversation').addEventListener('click', () => { showView('home'); composerInput.value = ''; syncComposerState(); composerInput.focus(); });
document.querySelector('#return-to-home').addEventListener('click', () => { showView('home'); composerInput.focus(); });

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

homeButton.addEventListener('click', () => {
  showView('home', homeButton);
});

newChatButton.addEventListener('click', () => {
  showView('home', newChatButton);
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
