// Runs on linkedin.com. Idle unless the background says this tab is the active run.
// Everything here drives the real UI: it clicks the same buttons a person would.

const VERSION = "v12";
const NOTE_MAX_CHARS = 200;

let stopped = false;
let sentThisRun = 0;

// ---------------------------------------------------------------- utilities

/**
 * Make LinkedIn's invite dialogs invisible while we drive them. Opacity-0 keeps the
 * elements measurable and clickable (so the code still presses "Send without a note"),
 * but you never see the "Add a note?" popup flash.
 */
function hideInviteModals() {
  if (document.getElementById("__ac_hide")) return;
  const style = document.createElement("style");
  style.id = "__ac_hide";
  style.textContent =
    '.artdeco-modal-overlay, [role="dialog"], [aria-modal="true"], .artdeco-modal' +
    "{opacity:0 !important; pointer-events:none !important;}";
  (document.head || document.documentElement).appendChild(style);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (min, max) => Math.floor(min + Math.random() * (max - min));

const send = (msg) =>
  new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(msg, (res) => {
        void chrome.runtime.lastError;
        resolve(res);
      });
    } catch {
      resolve(undefined);
    }
  });

const note = (message, level) => send({ type: "LOG", message, level });

/** Poll for something to appear. Returns null on timeout instead of throwing. */
async function waitFor(fn, timeoutMs = 8000, stepMs = 250) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (stopped) return null;
    const value = fn();
    if (value) return value;
    await sleep(stepMs);
  }
  return null;
}

function isVisible(el) {
  if (!el || el.disabled || el.getAttribute("aria-disabled") === "true") return false;
  const rect = el.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

/** LinkedIn's inputs are React-controlled; a plain .value assignment is ignored. */
function setNativeValue(el, value) {
  const setter = Object.getOwnPropertyDescriptor(
    Object.getPrototypeOf(el),
    "value"
  )?.set;
  if (setter) setter.call(el, value);
  else el.value = value;
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

/** A fuller click than .click() — React action handlers often need the mouse sequence. */
function realClick(el) {
  const o = { bubbles: true, cancelable: true, view: window };
  try {
    el.dispatchEvent(new PointerEvent("pointerdown", o));
    el.dispatchEvent(new MouseEvent("mousedown", o));
    el.dispatchEvent(new PointerEvent("pointerup", o));
    el.dispatchEvent(new MouseEvent("mouseup", o));
  } catch {
    // PointerEvent unsupported — the native click below still fires.
  }
  el.click();
}

function findButton(root, { labels = [], texts = [] }) {
  // LinkedIn renders actions as <button>, <a>, or role=button divs — search all.
  const els = [...root.querySelectorAll('button, a, [role="button"]')];
  for (const b of els) {
    if (!isVisible(b)) continue;
    const aria = (b.getAttribute("aria-label") || "").trim().toLowerCase();
    const text = (b.innerText || "").trim().toLowerCase();
    if (labels.some((l) => aria === l || aria.startsWith(l))) return b;
    if (texts.some((t) => text === t)) return b;
  }
  return null;
}

// ---------------------------------------------------------------- candidates

/** One-time diagnostic: what do the on-page buttons actually look like? */
async function reportButtons() {
  const profiles = document.querySelectorAll('a[href*="/in/"]').length;
  const buttons = document.querySelectorAll("button").length;
  await note(`DEBUG: ${profiles} profile links, ${buttons} buttons.`, "warn");

  // Find whatever element literally shows the word "Connect" and report what it is.
  const els = [...document.querySelectorAll("span, button, a, div")].filter(
    (el) => /^connect$/i.test((el.textContent || "").trim())
  );
  await note(`DEBUG: ${els.length} elements say "Connect".`, "warn");
  const el = els[0];
  if (el) {
    const ctrl = el.closest('button, a, [role="button"]') || el.parentElement || el;
    const tag = ctrl.tagName.toLowerCase();
    const role = ctrl.getAttribute("role") || "-";
    const aria = (ctrl.getAttribute("aria-label") || "-").slice(0, 30);
    const cls = (ctrl.className || "").toString().slice(0, 34);
    await note(`DEBUG ctrl: <${tag} role="${role}" aria="${aria}" class="${cls}">`, "warn");
  }
}

/** LinkedIn repeats the name in a visible + a hidden span; take the first real line. */
function extractName(container, link) {
  const source = link || container;
  if (!source) return "";
  const lines = (source.innerText || "")
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
  return lines[0] || "";
}

/** Every visible clickable element whose label reads exactly "Connect". */
function connectControls() {
  const found = [];
  const seen = new Set();
  for (const el of document.querySelectorAll('button, a, [role="button"]')) {
    if (seen.has(el)) continue;
    const text = (el.innerText || el.textContent || "").trim();
    const aria = (el.getAttribute("aria-label") || "").trim();
    if (/^connect$/i.test(text) || /^Invite .+ to connect$/i.test(aria)) {
      if (isVisible(el)) {
        found.push(el);
        seen.add(el);
      }
    }
  }
  return found;
}

/**
 * Walk up from a Connect control to the result card that holds it, and grab the
 * person's profile link. Works regardless of LinkedIn's (obfuscated) class names.
 */
function cardFor(control) {
  let node = control.parentElement;
  for (let i = 0; i < 10 && node; i++) {
    const link = node.querySelector('a[href*="/in/"]');
    if (link) return { card: node, link };
    node = node.parentElement;
  }
  return { card: control.parentElement, link: null };
}

/**
 * Find people we can invite by iterating the Connect controls directly — the one
 * thing we now know is on the page — then resolving each back to its person.
 */
function collectCandidates(config, processed) {
  const out = [];
  const seenKeys = new Set();

  for (const control of connectControls()) {
    const { card, link } = cardFor(control);
    if (!link) continue;

    const key = link.href.split("?")[0];
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);
    if (processed.has(key)) continue;

    const context = (card.innerText || "").toLowerCase();
    if (config.strictCompany && config.company) {
      if (!context.includes(config.company.trim().toLowerCase())) {
        processed.add(key);
        continue;
      }
    }

    const aria = control.getAttribute("aria-label") || "";
    const ariaName = /^Invite (.+?) to connect$/i.exec(aria);
    const fullName = ariaName ? ariaName[1].trim() : extractName(card, link);

    out.push({ btn: control, card, key, fullName });
  }
  return out;
}

function renderNote(template, person, config) {
  const parts = person.fullName.split(/\s+/);
  const text = template
    .replaceAll("{{firstName}}", parts[0] || "")
    .replaceAll("{{lastName}}", parts.slice(1).join(" "))
    .replaceAll("{{fullName}}", person.fullName)
    .replaceAll("{{company}}", config.company || "");
  return text.trim().slice(0, NOTE_MAX_CHARS);
}

// ---------------------------------------------------------------- invite flow

function openDialog() {
  const sel = '[role="dialog"], [aria-modal="true"], .artdeco-modal';
  const dialogs = [...document.querySelectorAll(sel)].filter(isVisible);
  return dialogs[dialogs.length - 1] || null;
}

/** Did this person's card flip to a sent/pending state? Means the invite went through. */
function looksSent(person) {
  const text = (
    (person.card?.innerText || "") + " " + (person.btn?.innerText || "")
  ).toLowerCase();
  return /pending|invitation sent|invite sent|withdraw/.test(text);
}

const RATE_LIMIT_SIGNS = [
  "reached the weekly invitation limit",
  "you've reached the invitation limit",
  "no invitations left",
  "try again later",
];

const EMAIL_GATE_SIGNS = [
  "to verify this member knows you",
  "please enter their email",
  "enter the email address",
];

/**
 * @returns {{status: 'sent'|'skipped'|'blocked', reason?: string}}
 */
async function sendInvite(person, config) {
  person.btn.scrollIntoView({ block: "center", behavior: "smooth" });
  await sleep(rand(300, 700));
  if (stopped) return { status: "skipped", reason: "stopped" };

  realClick(person.btn);

  // Either a modal opens, or LinkedIn sends instantly and the card flips to "Pending".
  const dialog = await waitFor(() => openDialog() || (looksSent(person) ? true : null), 8000);

  if (dialog === true) {
    return { status: "sent" }; // sent with no modal
  }

  if (!dialog) {
    if (looksSent(person)) return { status: "sent" };
    if (!window.__dbgInvite) {
      window.__dbgInvite = true;
      const post = ((person.card?.innerText || "").replace(/\s+/g, " ").trim()).slice(0, 70);
      await note(`DEBUG after click, card says: "${post}"`, "warn");
    }
    return { status: "skipped", reason: "no dialog appeared" };
  }

  const body = (dialog.innerText || "").toLowerCase();

  if (RATE_LIMIT_SIGNS.some((s) => body.includes(s))) {
    dismiss(dialog);
    return { status: "blocked", reason: "LinkedIn says the invitation limit is reached" };
  }

  const needsEmail =
    EMAIL_GATE_SIGNS.some((s) => body.includes(s)) ||
    !!dialog.querySelector('input[type="email"], input[name="email"]');
  if (needsEmail) {
    dismiss(dialog);
    await waitFor(() => !openDialog(), 4000);
    return { status: "skipped", reason: "email verification required" };
  }

  // Attach the note, if there is one and LinkedIn offers the option.
  const text = config.note ? renderNote(config.note, person, config) : "";
  if (text) {
    const addNote = findButton(dialog, {
      labels: ["add a note"],
      texts: ["add a note"],
    });
    if (addNote) {
      realClick(addNote);
      await sleep(rand(500, 1200));
    }
    const box = await waitFor(
      () =>
        dialog.querySelector(
          'textarea#custom-message, textarea[name="message"], textarea'
        ),
      4000
    );
    if (box) {
      box.focus();
      setNativeValue(box, text);
      await sleep(rand(400, 1100));
    }
  }

  // With a note: click "Send". Without a note: click "Send without a note" (this is
  // the "Add a note to your invitation?" popup), falling back to a plain "Send".
  const withNote = { labels: ["send invitation", "send now", "send"], texts: ["send", "send invitation", "send now"] };
  const noNote = { labels: ["send without a note", "send now", "send invitation", "send"], texts: ["send without a note", "send", "send now"] };

  // Poll fast for the button so the popup is dismissed the instant it's clickable.
  const sendBtn = await waitFor(
    () => findButton(openDialog() || dialog, text ? withNote : noNote),
    5000,
    100
  );

  if (!sendBtn) {
    dismiss(openDialog() || dialog);
    return { status: "skipped", reason: "no send button in dialog" };
  }

  realClick(sendBtn);

  const closed = await waitFor(() => !openDialog(), 8000);
  if (!closed) {
    // An upsell or confirmation can stack on top; clear it and take the send.
    const leftover = openDialog();
    if (leftover) dismiss(leftover);
  }
  await sleep(rand(400, 900));
  return { status: "sent" };
}

function dismiss(dialog) {
  const close =
    findButton(dialog, {
      labels: ["dismiss", "cancel", "close", "got it", "not now"],
      texts: ["cancel", "close", "got it", "not now"],
    }) || dialog.querySelector('button[aria-label*="Dismiss" i]');
  if (close) close.click();
  else document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
}

// ---------------------------------------------------------------- paging

async function lazyLoad() {
  const step = Math.round(window.innerHeight * 0.8);
  for (let y = 0; y < document.body.scrollHeight; y += step) {
    if (stopped) return;
    window.scrollTo({ top: y, behavior: "smooth" });
    await sleep(rand(350, 800));
  }
  await sleep(rand(600, 1200));
}

async function nextPage() {
  window.scrollTo({ top: document.body.scrollHeight, behavior: "smooth" });
  await sleep(rand(800, 1600));

  const next = findButton(document, { labels: ["next"], texts: ["next"] });
  if (!next) return false;

  const before = document.querySelectorAll("button[aria-label^='Invite']").length;
  next.click();
  await note("Moving to the next page of results.");

  // The SPA swaps the list in place, so wait for the result set to actually turn over.
  await waitFor(() => {
    const now = document.querySelectorAll("button[aria-label^='Invite']").length;
    return now > 0 && now !== before;
  }, 12000);
  await sleep(rand(1500, 3000));
  return true;
}

// ---------------------------------------------------------------- main loop

async function humanPause(config) {
  const gap = Math.max(3, Number(config.gapSec) || 5);
  // Honor the chosen gap, plus a little jitter so timing isn't a perfect metronome.
  await sleep(gap * 1000 + rand(0, 1500));
}

async function run(config) {
  const processed = new Set();
  hideInviteModals(); // keep the "Add a note?" popup out of sight

  // Results render a second or two after the page shell. Wait for the people to
  // actually appear before scanning — otherwise we only see the nav bar.
  await note("Waiting for people to load…");
  const loaded = await waitFor(
    () => document.querySelectorAll('a[href*="/in/"]').length >= 3,
    20000
  );
  if (!loaded) {
    await reportButtons();
    await send({
      type: "ABORT",
      reason: "search results never loaded (login/verification page?)",
    });
    return;
  }

  // Warm-up: scroll through the page once so lazy-rendered action buttons appear.
  await lazyLoad();
  window.scrollTo({ top: 0 });
  await sleep(1200);
  await reportButtons(); // one-time diagnostic, now that everything is rendered

  let emptyChecks = 0;

  while (!stopped) {
    const candidates = collectCandidates(config, processed);

    // Nothing new in view — scroll to load more, or page forward at the bottom.
    if (candidates.length === 0) {
      const atBottom =
        window.innerHeight + window.scrollY >= document.body.scrollHeight - 60;

      if (!atBottom) {
        window.scrollBy({ top: Math.round(window.innerHeight * 0.7), behavior: "smooth" });
        await sleep(rand(700, 1400));
        continue;
      }

      emptyChecks += 1;
      if (emptyChecks < 2) {
        await sleep(rand(800, 1500)); // give lazy content a moment
        continue;
      }

      await note("No more people on this page, going to next.");
      const advanced = await nextPage();
      if (!advanced) {
        await send({ type: "ABORT", reason: "ran out of results" });
        return;
      }
      window.scrollTo({ top: 0 });
      await sleep(rand(1500, 2500));
      emptyChecks = 0;
      continue;
    }

    emptyChecks = 0;

    // Act on the first candidate now, while it's near the viewport.
    const person = candidates[0];
    processed.add(person.key);
    await note(`Trying ${person.fullName || "someone"}…`);

    const outcome = await sendInvite(person, config);

    if (outcome.status === "blocked") {
      await note(outcome.reason, "warn");
      await send({ type: "ABORT", reason: outcome.reason });
      stopped = true;
      return;
    }

    if (outcome.status === "skipped") {
      await note(`Skipped ${person.fullName} — ${outcome.reason}.`);
      await sleep(rand(1200, 3000));
      continue;
    }

    sentThisRun += 1;
    const reply = await send({ type: "INVITE_SENT", name: person.fullName });
    if (!reply || !reply.continue) {
      stopped = true;
      return;
    }
    await humanPause(config);
  }
}

// ---------------------------------------------------------------- bootstrap

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "STOP") stopped = true;
});

(async function main() {
  if (!/\/search\/results\/people/.test(location.pathname)) return;

  const state = await send({ type: "CONTENT_READY" });
  if (!state || !state.run) return;

  await note(`Auto Connect ${VERSION} is running on this page.`);
  await sleep(rand(2000, 4000)); // let the first page settle
  try {
    await run(state.config);
  } catch (err) {
    await send({ type: "ABORT", reason: `content script error: ${err.message}` });
  }
})();
