(() => {
  "use strict";

  const config = window.SELENE_CONFIG;

  if (!config) {
    console.error("Selene Companion API: configuration was not loaded.");
    return;
  }

  const core = config.core;

  const connectionState = {
    online: false,
    checking: false,
    lastChecked: null,
    lastError: null
  };

  const elements = {
    sidebarDot: document.getElementById("sidebarConnectionDot"),
    sidebarText: document.getElementById("sidebarConnectionText"),

    mobileDot: document.getElementById("mobileConnectionDot"),
    mobileText: document.getElementById("mobileConnectionText"),

    contextDot: document.getElementById("contextConnectionDot"),
    contextText: document.getElementById("contextConnectionText"),

    dialogDot: document.getElementById("dialogConnectionDot"),
    dialogText: document.getElementById("dialogConnectionText")
  };

  function setDot(dot, online) {
    if (!dot) {
      return;
    }

    dot.classList.toggle("online", online);
    dot.classList.toggle("offline", !online);
  }

  function updateConnectionUI() {
    const { online, checking } = connectionState;

    const dots = [
      elements.sidebarDot,
      elements.mobileDot,
      elements.contextDot,
      elements.dialogDot
    ];

    dots.forEach((dot) => {
      setDot(dot, online);
    });

    if (checking) {
      if (elements.sidebarText) {
        elements.sidebarText.textContent = "Checking...";
      }

      if (elements.mobileText) {
        elements.mobileText.textContent = "NOVA";
      }

      if (elements.contextText) {
        elements.contextText.textContent = "Checking connection...";
      }

      if (elements.dialogText) {
        elements.dialogText.textContent = "Checking connection...";
      }

      return;
    }

    if (online) {
      if (elements.sidebarText) {
        elements.sidebarText.textContent = "Connected";
      }

      if (elements.mobileText) {
        elements.mobileText.textContent = "NOVA";
      }

      if (elements.contextText) {
        elements.contextText.textContent = "Connected";
      }

      if (elements.dialogText) {
        elements.dialogText.textContent = "Connected to Selene Core";
      }

      return;
    }

    if (elements.sidebarText) {
      elements.sidebarText.textContent = "Offline";
    }

    if (elements.mobileText) {
      elements.mobileText.textContent = "NOVA";
    }

    if (elements.contextText) {
      elements.contextText.textContent = "Not connected";
    }

    if (elements.dialogText) {
      elements.dialogText.textContent = "Selene Core is unavailable";
    }
  }

  async function fetchWithTimeout(url, options = {}) {
    const controller = new AbortController();

    const timeout = window.setTimeout(() => {
      controller.abort();
    }, core.requestTimeoutMs);

    try {
      return await fetch(url, {
        ...options,
        signal: controller.signal
      });
    } finally {
      window.clearTimeout(timeout);
    }
  }

  async function checkConnection() {
    if (connectionState.checking) {
      return connectionState.online;
    }

    connectionState.checking = true;
    connectionState.lastError = null;

    updateConnectionUI();

    const url =
      `${core.baseUrl}${core.healthEndpoint}`;

    try {
      const response = await fetchWithTimeout(url, {
        method: "GET",
        headers: {
          Accept: "application/json"
        },
        cache: "no-store"
      });

      if (!response.ok) {
        throw new Error(
          `Selene Core returned HTTP ${response.status}.`
        );
      }

      connectionState.online = true;
      connectionState.lastChecked = new Date();

      window.dispatchEvent(
        new CustomEvent("selene:connection-changed", {
          detail: {
            online: true,
            checkedAt: connectionState.lastChecked
          }
        })
      );

      return true;
    } catch (error) {
      connectionState.online = false;
      connectionState.lastChecked = new Date();
      connectionState.lastError = error;

      window.dispatchEvent(
        new CustomEvent("selene:connection-changed", {
          detail: {
            online: false,
            checkedAt: connectionState.lastChecked,
            error
          }
        })
      );

      return false;
    } finally {
      connectionState.checking = false;
      updateConnectionUI();
    }
  }

  async function request(
    path,
    {
      method = "GET",
      body = null,
      headers = {}
    } = {}
  ) {
    const url = `${core.baseUrl}${path}`;

    const requestHeaders = {
      Accept: "application/json",
      ...headers
    };

    if (body !== null) {
      requestHeaders["Content-Type"] =
        "application/json";
    }

    const response = await fetchWithTimeout(url, {
      method,
      headers: requestHeaders,
      body:
        body !== null
          ? JSON.stringify(body)
          : undefined
    });

    if (!response.ok) {
      let message =
        `Selene Core request failed with HTTP ${response.status}.`;

      try {
        const errorBody = await response.json();

        if (errorBody?.error) {
          message = errorBody.error;
        } else if (errorBody?.message) {
          message = errorBody.message;
        }
      } catch {
        // Keep default error message.
      }

      throw new Error(message);
    }

    const contentType =
      response.headers.get("content-type") || "";

    if (
      contentType.includes("application/json")
    ) {
      return response.json();
    }

    return response.text();
  }

  async function sendChatMessage(message) {
    return request(core.chatEndpoint, {
      method: "POST",
      body: {
        message
      }
    });
  }

  function startConnectionMonitor() {
    checkConnection();

    const interval =
      config.ui.reconnectIntervalMs || 15000;

    window.setInterval(() => {
      checkConnection();
    }, interval);
  }

  window.addEventListener(
    "selene:connection-retry",
    () => {
      checkConnection();
    }
  );

  window.SeleneAPI = {
    get online() {
      return connectionState.online;
    },

    get checking() {
      return connectionState.checking;
    },

    get lastChecked() {
      return connectionState.lastChecked;
    },

    get lastError() {
      return connectionState.lastError;
    },

    checkConnection,
    request,
    sendChatMessage
  };

  updateConnectionUI();
  startConnectionMonitor();
})();