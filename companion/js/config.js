window.SELENE_CONFIG = {
  app: {
    name: "Selene Companion",
    shortName: "Selene",
    version: "0.1.0"
  },

  core: {
    baseUrl: "http://127.0.0.1:8787",
    healthEndpoint: "/health",
    chatEndpoint: "/api/chat",

    requestTimeoutMs: 10000
  },

  ui: {
    defaultView: "chat",
    defaultState: "idle",

    reconnectIntervalMs: 15000
  },

  features: {
    chat: true,
    inbox: false,
    approvals: false,
    activity: false
  }
};
