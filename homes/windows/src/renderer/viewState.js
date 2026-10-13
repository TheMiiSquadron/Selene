(function initializeViewState(root, factory) {
  const viewState = factory();

  if (typeof module === 'object' && module.exports) {
    module.exports = viewState;
  }

  if (root) {
    root.SeleneViewState = viewState;
  }
}(typeof globalThis === 'object' ? globalThis : this, () => {
  const UNAVAILABLE_MESSAGES = Object.freeze({
    search: 'Conversation search will be available after conversation integration is connected.',
    projects: 'Projects are not connected in this visual milestone.',
    devices: 'Device information is unavailable until Selene Core is connected.',
    settings: 'Settings will open in a future Windows Home milestone.',
    continue: 'There are no connected conversations to continue yet.',
    constellation: 'Constellation is unavailable until Selene Core is connected.',
    conversation: 'Conversation integration is not available yet. Your message was not sent.'
  });

  function getTimeGreeting(value = new Date()) {
    const hour = value instanceof Date ? value.getHours() : value;
    if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
      throw new RangeError('Greeting hour must be an integer from 0 through 23.');
    }

    if (hour >= 5 && hour < 12) {
      return 'Good morning.';
    }

    if (hour >= 12 && hour < 17) {
      return 'Good afternoon.';
    }

    return 'Good evening.';
  }

  function getUnavailableMessage(feature) {
    return UNAVAILABLE_MESSAGES[feature]
      ?? 'This part of Windows Home is not available yet.';
  }

  return Object.freeze({ getTimeGreeting, getUnavailableMessage });
}));
