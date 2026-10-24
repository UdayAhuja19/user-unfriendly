// Little helpers shared by the event's pages: build elements safely (names are always text,
// never HTML), ask before anything that can't be undone, and show a short message.

export const $ = (id) => document.getElementById(id);

// The event's logo: "user unfriendly" set sharp, watched by two tracking boxes and a cursor trail
// (the approved tracking-boxes poster). Built fresh each time; it's all text and CSS.
export function logo() {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "logo__trail");
  svg.setAttribute("viewBox", "0 0 100 60");
  svg.setAttribute("preserveAspectRatio", "none");
  svg.setAttribute("aria-hidden", "true");
  svg.innerHTML = '<polyline points="8,42 18,47 27,40 41,52 52,47 63,55 70,50 77,58" fill="none" stroke="#E5231B" stroke-width="0.5" vector-effect="non-scaling-stroke"/>' +
    [[8, 42], [18, 47], [27, 40], [41, 52], [52, 47], [63, 55], [70, 50], [77, 58]].map(([x, y]) => `<circle cx="${x}" cy="${y}" r="0.9" fill="#E5231B"/>`).join("");
  return h(
    "div",
    { class: "logo", role: "img", "aria-label": "User unfriendly" },
    h("span", { class: "logo__word" }, "user"),
    h("span", { class: "logo__word" }, "unfriendly"),
    svg,
    h("span", { class: "logo__box logo__box--a" }, h("span", {}, "User_014 · lost 0.97")),
    h("span", { class: "logo__box logo__box--b" }, h("span", {}, "Rage clicks ×12"))
  );
}

// h("p", { class: "x", onclick }, "text", child, …): strings become text nodes, never HTML.
export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props ?? {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key.startsWith("on") && typeof value === "function") el.addEventListener(key.slice(2), value);
    else if (key === "class") el.className = value;
    else if (key === "dataset") Object.assign(el.dataset, value);
    else if (value === true) el.setAttribute(key, "");
    else el.setAttribute(key, String(value));
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

// Swaps a container's contents but keeps what was typed and where the cursor was.
export function replaceKeeping(container, nodes) {
  const typed = new Map();
  for (const input of container.querySelectorAll("input[id]")) typed.set(input.id, input.value);
  const active = document.activeElement?.id && container.contains(document.activeElement) ? document.activeElement.id : null;
  const selection = active ? [document.activeElement.selectionStart, document.activeElement.selectionEnd] : null;
  container.replaceChildren(...nodes);
  for (const [id, value] of typed) {
    const input = container.querySelector(`#${CSS.escape(id)}`);
    if (input && input.value === "") input.value = value;
  }
  if (active) {
    const el = container.querySelector(`#${CSS.escape(active)}`);
    if (el) {
      el.focus({ preventScroll: true });
      if (selection && typeof el.setSelectionRange === "function") {
        try {
          el.setSelectionRange(selection[0], selection[1]);
        } catch {
          // Not a text field.
        }
      }
    }
  }
}

// Asks in the page's own window (never window.confirm). Resolves true or false.
export function ask(title, text, { yes = "Yes", no = "No", bar = "ARE YOU SURE?" } = {}) {
  const modal = $("modal");
  $("modal-title").textContent = title;
  $("modal-text").textContent = text;
  $("modal-bar").textContent = bar;
  $("modal-yes").textContent = yes;
  $("modal-no").textContent = no;
  modal.hidden = false;
  $("modal-no").focus();
  return new Promise((resolve) => {
    const done = (answer) => {
      modal.hidden = true;
      $("modal-yes").onclick = null;
      $("modal-no").onclick = null;
      document.removeEventListener("keydown", onKey);
      resolve(answer);
    };
    const onKey = (event) => event.key === "Escape" && done(false);
    $("modal-yes").onclick = () => done(true);
    $("modal-no").onclick = () => done(false);
    document.addEventListener("keydown", onKey);
  });
}

let toastTimer = 0;
export function toast(text, ms = 3500) {
  const el = $("toast");
  el.textContent = text;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), ms);
}

export function clock(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
}

export function timeOfDay(ms) {
  return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
}
