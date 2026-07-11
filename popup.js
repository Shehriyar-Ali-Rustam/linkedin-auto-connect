import {
  SAFE_DAILY_MAX,
  HARD_DAILY_MAX,
  WEEKLY_CAP,
  NOTE_MAX_CHARS,
  clampDailyLimit,
} from "./limits.js";

const $ = (id) => document.getElementById(id);

const fields = {
  keywords: $("keywords"),
  company: $("company"),
  note: $("note"),
  dailyLimit: $("dailyLimit"),
  gapSec: $("gapSec"),
};

const send = (msg) => chrome.runtime.sendMessage(msg);

function readForm() {
  return {
    keywords: fields.keywords.value.trim(),
    company: fields.company.value.trim(),
    strictCompany: false,
    note: fields.note.value.trim(),
    dailyLimit: Number(fields.dailyLimit.value),
    unlockHighVolume: false, // premium feature — never unlocked from the UI
    gapSec: Number(fields.gapSec.value),
  };
}

function fillForm(config) {
  fields.keywords.value = config.keywords;
  fields.company.value = config.company;
  fields.note.value = config.note;
  fields.dailyLimit.value = config.dailyLimit;
  fields.gapSec.value = config.gapSec;
  syncLimitUi();
  syncNoteCount();
}

/** Higher volume is paywalled, so the slider is always capped at the safe max. */
function syncLimitUi() {
  fields.dailyLimit.max = String(SAFE_DAILY_MAX);
  fields.dailyLimit.value = String(clampDailyLimit(fields.dailyLimit.value, false));
  $("limitOut").textContent = fields.dailyLimit.value;
  $("limitHint").textContent = `Up to ${SAFE_DAILY_MAX}/day — auto-stops when reached. Weekly cap ${WEEKLY_CAP}.`;
}

function syncNoteCount() {
  const n = fields.note.value.length;
  const out = $("noteCount");
  out.textContent = `${n}/${NOTE_MAX_CHARS}`;
  out.style.color = n > NOTE_MAX_CHARS ? "var(--danger)" : "";
}

function validate(config) {
  if (!config.keywords) return "Search / keywords is required.";
  if (config.dailyLimit <= 0) return "Daily limit is 0 — nothing would be sent.";
  if (config.note.length > NOTE_MAX_CHARS)
    return `Message is ${config.note.length} chars; LinkedIn allows ${NOTE_MAX_CHARS}.`;
  if (config.gapSec < 3) return "Gap must be at least 3 seconds.";
  return null;
}

function showError(message) {
  const el = $("error");
  el.textContent = message || "";
  el.hidden = !message;
}

function renderLog(entries) {
  const list = $("log");
  list.innerHTML = "";
  if (!entries.length) {
    const li = document.createElement("li");
    li.innerHTML = '<span class="empty">Nothing yet.</span>';
    list.append(li);
    return;
  }
  // Only the most recent few, newest first. Sent invites get the "sent" highlight.
  for (const e of entries.slice(0, 6)) {
    const li = document.createElement("li");
    li.className = e.level || "info";
    const time = document.createElement("time");
    time.textContent = new Date(e.at).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
    });
    const text = document.createElement("span");
    text.textContent = e.message;
    li.append(time, text);
    list.append(li);
  }
}

function renderRunState(state) {
  const running = !!state.run;
  $("start").hidden = running;
  $("stop").hidden = !running;
  for (const el of Object.values(fields)) el.disabled = running;

  $("quota").textContent = `${state.sentToday}/${state.dailyLimit} today · ${state.sentThisWeek}/${WEEKLY_CAP} this week`;

  if (!running && state.remaining <= 0) {
    $("start").disabled = true;
    showError(
      state.sentThisWeek >= WEEKLY_CAP
        ? `Rolling weekly cap reached (${WEEKLY_CAP}). Wait for it to age out.`
        : `Daily limit reached (${state.sentToday}/${state.dailyLimit}).`
    );
  } else if (!running) {
    $("start").disabled = false;
  }
}

async function refresh() {
  const state = await send({ type: "GET_STATE" });
  if (!state) return;
  if (!document.activeElement || document.activeElement === document.body) {
    fillForm(state.config);
  }
  renderRunState(state);
  renderLog(state.log);
}

// ---------------------------------------------------------------- wiring

fields.dailyLimit.addEventListener("input", syncLimitUi);
fields.note.addEventListener("input", syncNoteCount);

// Higher volume is a premium upgrade — clicking shows the offer.
$("premiumBtn").addEventListener("click", () => {
  $("premiumMsg").hidden = false;
});

$("form").addEventListener("submit", async (e) => {
  e.preventDefault();
  showError(null);

  const config = readForm();
  config.dailyLimit = clampDailyLimit(config.dailyLimit, config.unlockHighVolume);

  const problem = validate(config);
  if (problem) return showError(problem);

  await send({ type: "SAVE_CONFIG", config });
  const res = await send({ type: "START" });
  if (!res?.ok && res?.reason === "no-quota") {
    showError("No quota left right now.");
  }
  await refresh();
});

$("stop").addEventListener("click", async () => {
  await send({ type: "STOP", reason: "stopped by you" });
  await refresh();
});

chrome.storage.onChanged.addListener(refresh);
refresh();
setInterval(refresh, 2000);
