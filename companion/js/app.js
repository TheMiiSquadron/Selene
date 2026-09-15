(() => {
  "use strict";

  const config = window.SELENE_CONFIG;

  if (!config) {
    console.error("Selene Companion: configuration was not loaded.");
    return;
  }

  const state = {
    currentView: config.ui.defaultView || "chat",
    seleneState: config.ui.defaultState || "idle"
  };

  const elements = {
    navButtons: document.querySelectorAll("[data-view]"),
    viewPanels: document.querySelectorAll("[data-view-panel]"),
    viewTitle: document.getElementById("viewTitle"),

    connectionButton: document.getElementById("connectionButton"),
    connectionDialog: document.getElementById("connectionDialog"),
    closeConnectionDialog: document.getElementById("closeConnectionDialog"),
    retryConnectionButton: document.getElementById("retryConnectionButton"),

    pebbles: document.querySelectorAll(".pebble"),

    mobileStateLabel: document.getElementById("seleneStateLabel"),
    desktopStateLabel: document.getElementById("desktopStateLabel"),
    desktopStateDescription: document.getElementById(
      "desktopStateDescription"
    )
  };

  const viewTitles = {
    chat: "Selene",
    inbox: "Inbox",
    approvals: "Approvals",
    activity: "Activity"
  };

  const seleneStateText = {
    idle: {
      label: "Idle",
      description: "Ready when needed."
    },

    working: {
      label: "Working",
      description: "Selene is working."
    },

    success: {
      label: "Complete",
      description: "Task completed successfully."
    },

    asking: {
      label: "Needs input",
      description: "Selene is waiting for you."
    },

    error: {
      label: "Blocked",
      description: "Something prevented Selene from continuing."
    },

    proactive: {
      label: "Something for you",
      description: "Selene has something to bring to your attention."
    }
  };

  function setView(viewName) {
    if (!viewTitles[viewName]) {
      console.warn(
        `Selene Companion: unknown view "${viewName}".`
      );
      return;
    }

    state.currentView = viewName;

    elements.viewPanels.forEach((panel) => {
      const isActive =
        panel.dataset.viewPanel === viewName;

      panel.hidden = !isActive;
      panel.classList.toggle("active", isActive);
    });

    elements.navButtons.forEach((button) => {
      if (!button.dataset.view) {
        return;
      }

      const isActive =
        button.dataset.view === viewName;

      button.classList.toggle("active", isActive);

      if (isActive) {
        button.setAttribute("aria-current", "page");
      } else {
        button.removeAttribute("aria-current");
      }
    });

    if (elements.viewTitle) {
      elements.viewTitle.textContent =
        viewTitles[viewName];
    }
  }

  function setSeleneState(nextState) {
    if (!seleneStateText[nextState]) {
      console.warn(
        `Selene Companion: unknown state "${nextState}".`
      );
      return;
    }

    state.seleneState = nextState;

    const stateInfo =
      seleneStateText[nextState];

    elements.pebbles.forEach((pebble) => {
      pebble.dataset.state = nextState;

      if (pebble.hasAttribute("role")) {
        pebble.setAttribute(
          "aria-label",
          `Selene is ${stateInfo.label.toLowerCase()}`
        );
      }
    });

    if (elements.mobileStateLabel) {
      elements.mobileStateLabel.textContent =
        stateInfo.label;
    }

    if (elements.desktopStateLabel) {
      elements.desktopStateLabel.textContent =
        stateInfo.label;
    }

    if (elements.desktopStateDescription) {
      elements.desktopStateDescription.textContent =
        stateInfo.description;
    }

    document.body.dataset.seleneState =
      nextState;
  }

  function openConnectionDialog() {
    if (!elements.connectionDialog) {
      return;
    }

    if (
      typeof elements.connectionDialog.showModal ===
      "function"
    ) {
      elements.connectionDialog.showModal();
      return;
    }

    elements.connectionDialog.setAttribute(
      "open",
      ""
    );
  }

  function closeConnectionDialog() {
    if (!elements.connectionDialog) {
      return;
    }

    if (
      typeof elements.connectionDialog.close ===
      "function"
    ) {
      elements.connectionDialog.close();
      return;
    }

    elements.connectionDialog.removeAttribute(
      "open"
    );
  }

  function registerNavigation() {
    elements.navButtons.forEach((button) => {
      const viewName = button.dataset.view;

      if (!viewName) {
        return;
      }

      button.addEventListener("click", () => {
        setView(viewName);
      });
    });
  }

  function registerConnectionDialog() {
    elements.connectionButton?.addEventListener(
      "click",
      openConnectionDialog
    );

    elements.closeConnectionDialog?.addEventListener(
      "click",
      closeConnectionDialog
    );

    elements.connectionDialog?.addEventListener(
      "click",
      (event) => {
        if (
          event.target === elements.connectionDialog
        ) {
          closeConnectionDialog();
        }
      }
    );

    elements.retryConnectionButton?.addEventListener(
      "click",
      () => {
        window.dispatchEvent(
          new CustomEvent(
            "selene:connection-retry"
          )
        );
      }
    );
  }

  function registerServiceWorker() {
    if (!("serviceWorker" in navigator)) {
      console.info(
        "Selene Companion: service workers are not supported in this browser."
      );
      return;
    }

    const isLocalDevelopmentHost =
      window.location.hostname === "localhost" ||
      window.location.hostname === "127.0.0.1";

    if (isLocalDevelopmentHost) {
      window.addEventListener("load", async () => {
        try {
          const registrations =
            await navigator.serviceWorker.getRegistrations();

          await Promise.all(
            registrations
              .filter((registration) => {
                const worker =
                  registration.active ||
                  registration.waiting ||
                  registration.installing;

                return worker?.scriptURL.includes(
                  "service-worker.js"
                );
              })
              .map((registration) => registration.unregister())
          );

          if ("caches" in window) {
            const cacheNames = await caches.keys();

            await Promise.all(
              cacheNames
                .filter((cacheName) => {
                  return cacheName.startsWith("selene-companion-");
                })
                .map((cacheName) => caches.delete(cacheName))
            );
          }
        } catch (error) {
          console.warn(
            "Selene Companion: local service worker cleanup failed.",
            error
          );
        }
      });

      return;
    }

    window.addEventListener("load", async () => {
      try {
        const registration =
          await navigator.serviceWorker.register(
            "./service-worker.js"
          );

        console.info(
          "Selene Companion: service worker registered.",
          registration.scope
        );
      } catch (error) {
        console.error(
          "Selene Companion: service worker registration failed.",
          error
        );
      }
    });
  }

  function exposeAppInterface() {
    window.SeleneApp = {
      get currentView() {
        return state.currentView;
      },

      get seleneState() {
        return state.seleneState;
      },

      setView,
      setSeleneState,
      openConnectionDialog,
      closeConnectionDialog
    };
  }

  function init() {
    registerNavigation();
    registerConnectionDialog();
    registerServiceWorker();
    exposeAppInterface();

    setView(state.currentView);
    setSeleneState(state.seleneState);

    console.info(
      `Selene Companion ${config.app.version} initialized.`
    );
  }

  init();
})();
