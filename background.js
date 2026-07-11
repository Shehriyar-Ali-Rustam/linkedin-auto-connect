import { WEEKLY_CAP, DEFAULTS, clampDailyLimit } from "./limits.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;
const LOG_MAX = 60;

// ---------------------------------------------------------------- storage

async function read() {
  const s = await chrome.storage.local.get({
    config: DEFAULTS,
    history: [], // timestamps of successfully sent invites
    log: [],
    run: null, // { tabId, target, sent, startedAt }
  });
  s.config = { ...DEFAULTS, ...s.config };
  return s;
}

function pruneHistory(history, now) {
  return history.filter((ts) => now - ts < WEEK_MS);
}

function startOfLocalDay(now) {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** Remaining invites allowed right now, respecting both the daily and rolling-weekly caps. */
function quota(config, history, now) {
  const dayStart = startOfLocalDay(now);
  const sentToday = history.filter((ts) => ts >= dayStart).length;
  const sentThisWeek = history.length;
  const limit = clampDailyLimit(config.dailyLimit, config.unlockHighVolume);
  const remaining = Math.max(
    0,
    Math.min(limit - sentToday, WEEKLY_CAP - sentThisWeek)
  );
  return { sentToday, sentThisWeek, dailyLimit: limit, remaining };
}

async function log(message, level = "info") {
  const { log } = await read();
  const next = [{ at: Date.now(), message, level }, ...log].slice(0, LOG_MAX);
  await chrome.storage.local.set({ log: next });
}

// ---------------------------------------------------------------- run control

function buildSearchUrl(config) {
  const terms = [config.keywords, config.company].filter(Boolean).join(" ").trim();
  const url = new URL("https://www.linkedin.com/search/results/people/");
  if (terms) url.searchParams.set("keywords", terms);
  url.searchParams.set("origin", "GLOBAL_SEARCH_HEADER");
  return url.toString();
}

async function startRun() {
  const { config, history } = await read();
  const now = Date.now();
  const q = quota(config, pruneHistory(history, now), now);

  if (q.remaining <= 0) {
    await log(
      q.sentThisWeek >= WEEKLY_CAP
        ? `Weekly cap reached (${q.sentThisWeek}/${WEEKLY_CAP}). Wait it out.`
        : `Daily limit reached (${q.sentToday}/${q.dailyLimit}).`,
      "warn"
    );
    return { ok: false, reason: "no-quota" };
  }

  // The work happens in a background tab, so you're never dropped on the search page.
  const tab = await chrome.tabs.create({ url: buildSearchUrl(config), active: false });
  await chrome.storage.local.set({
    run: { tabId: tab.id, target: q.remaining, sent: 0, startedAt: now },
  });
  // Bring the Sent-invitations page to the front so you watch results, not popups.
  await chrome.tabs.create({
    url: "https://www.linkedin.com/mynetwork/invitation-manager/sent/",
    active: true,
  });
  await log(`Started in the background. Up to ${q.remaining} invite(s) this run.`);
  return { ok: true };
}

async function stopRun(reason) {
  const { run } = await read();
  if (!run) return;
  await chrome.storage.local.set({ run: null });
  await log(`Stopped after ${run.sent} invite(s)${reason ? ` — ${reason}` : ""}.`);
  try {
    await chrome.tabs.sendMessage(run.tabId, { type: "STOP" });
  } catch {
    // tab already gone; nothing to tell
  }
}

/** The content script sends this once per successful invite. */
async function recordInvite(name) {
  const { config, history, run } = await read();
  const now = Date.now();
  if (!run) return { continue: false };

  const nextHistory = pruneHistory([...history, now], now);
  const nextRun = { ...run, sent: run.sent + 1 };
  await chrome.storage.local.set({ history: nextHistory, run: nextRun });
  await log(`Invited ${name || "someone"} (${nextRun.sent}/${run.target})`, "sent");

  const q = quota(config, nextHistory, now);
  if (q.remaining <= 0 || nextRun.sent >= run.target) {
    await chrome.storage.local.set({ run: null });
    await log(`Run complete — ${nextRun.sent} invite(s) sent. Today: ${q.sentToday}/${q.dailyLimit}, week: ${q.sentThisWeek}/${WEEKLY_CAP}.`, "done");
    return { continue: false };
  }
  return { continue: true };
}

// ---------------------------------------------------------------- messaging

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    switch (msg.type) {
      case "GET_STATE": {
        const { config, history, log: entries, run } = await read();
        const now = Date.now();
        sendResponse({
          config,
          run,
          log: entries,
          ...quota(config, pruneHistory(history, now), now),
        });
        break;
      }

      case "SAVE_CONFIG": {
        const config = { ...DEFAULTS, ...msg.config };
        config.dailyLimit = clampDailyLimit(config.dailyLimit, config.unlockHighVolume);
        await chrome.storage.local.set({ config });
        sendResponse({ ok: true, config });
        break;
      }

      case "START":
        sendResponse(await startRun());
        break;

      case "STOP":
        await stopRun(msg.reason);
        sendResponse({ ok: true });
        break;

      // Content script announcing itself on page load / SPA navigation.
      case "CONTENT_READY": {
        const { config, run } = await read();
        const active = run && sender.tab && sender.tab.id === run.tabId;
        sendResponse(active ? { run: true, config } : { run: false });
        break;
      }

      case "INVITE_SENT":
        sendResponse(await recordInvite(msg.name));
        break;

      case "LOG":
        await log(msg.message, msg.level);
        sendResponse({ ok: true });
        break;

      // Content script hit something it refuses to push through — a LinkedIn
      // rate-limit wall, an email-verification gate, or no results left.
      case "ABORT":
        await stopRun(msg.reason);
        sendResponse({ ok: true });
        break;

      default:
        sendResponse({ ok: false, error: "unknown message" });
    }
  })();
  return true; // async sendResponse
});

// If the user closes the working tab, the run is over.
chrome.tabs.onRemoved.addListener(async (tabId) => {
  const { run } = await read();
  if (run && run.tabId === tabId) await stopRun("tab closed");
});
