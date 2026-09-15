const PEBBLE_STATES = [
  {
    id: "idle",
    label: "Idle",
    meaning: "I'm here.",
    color: "#DDEBFF",
    bloom: "#F4FAFF",
    halo: "#8AA7D8",
  },
  {
    id: "working",
    label: "Working",
    meaning: "I'm working.",
    color: "#2D78FF",
    bloom: "#A9D1FF",
    halo: "#1E5FD8",
  },
  {
    id: "success",
    label: "Success",
    meaning: "Done.",
    color: "#2FA45E",
    bloom: "#A7E7C0",
    halo: "#217547",
  },
  {
    id: "asking",
    label: "Asking",
    meaning: "I need you.",
    color: "#EAA40E",
    bloom: "#FFD98A",
    halo: "#B87508",
  },
  {
    id: "error",
    label: "Error",
    meaning: "I couldn't / won't proceed.",
    color: "#E63B2E",
    bloom: "#FFAAA3",
    halo: "#C2301F",
  },
  {
    id: "proactive",
    label: "Proactive",
    meaning: "I have something for you.",
    color: "#8B7CFF",
    bloom: "#B8AFFF",
    halo: "#6E67E8",
  },
];

const PEBBLE_STATE_ALIASES = {
  thinking: "working",
  done: "success",
};

const PEBBLE_STATE_IDS = PEBBLE_STATES.map((state) => state.id);

function normalizePebbleState(state) {
  const normalized = String(state ?? "").trim().toLowerCase();
  const canonical = PEBBLE_STATE_ALIASES[normalized] ?? normalized;
  return PEBBLE_STATE_IDS.includes(canonical) ? canonical : "idle";
}

module.exports = {
  PEBBLE_STATES,
  PEBBLE_STATE_ALIASES,
  PEBBLE_STATE_IDS,
  normalizePebbleState,
};
