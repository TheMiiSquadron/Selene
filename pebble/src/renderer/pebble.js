const pebble = document.querySelector("#pebble");
const hitTarget = document.querySelector("#pebble-hit-target");
const stateDefinitions = window.novaPebble.getStateDefinitions();
const stateById = new Map(stateDefinitions.states.map((state) => [state.id, state]));
const stateAliases = stateDefinitions.aliases ?? {};

let currentState = "idle";

function normalizeState(state) {
  const normalized = String(state ?? "").trim().toLowerCase();
  const canonical = stateAliases[normalized] ?? normalized;
  return stateById.has(canonical) ? canonical : "idle";
}

function applyStateColor(state) {
  const definition = stateById.get(state);
  if (!definition) return;

  pebble.style.setProperty("--state-core", definition.color);
  pebble.style.setProperty("--state-bloom", definition.bloom);
  pebble.style.setProperty("--state-halo", definition.halo);
}

function setState(state) {
  const nextState = normalizeState(state);
  pebble.classList.remove(`pebble--${currentState}`);
  currentState = nextState;
  applyStateColor(currentState);
  pebble.classList.add(`pebble--${currentState}`);
}

hitTarget.addEventListener("click", () => {
  window.novaPebble.togglePanel();
});

hitTarget.addEventListener("mouseenter", () => {
  window.novaPebble.setHovered(true);
});

hitTarget.addEventListener("mouseleave", () => {
  window.novaPebble.setHovered(false);
});

window.novaPebble.onSetState(setState);
applyStateColor(currentState);

window.SelenePebblePrototype = {
  setState
};

window.NovaPebblePrototype = window.SelenePebblePrototype;
