# LinkedIn Auto Connect

A Chrome (MV3) extension that runs a LinkedIn people-search and sends connection
requests with a personalized note, at a pace and volume you set.

## Read this first

This violates LinkedIn's User Agreement. Section 8.2 prohibits "bots or other
automated methods to access the Services, add or download contacts," and their
[Prohibited software and extensions](https://www.linkedin.com/help/linkedin/answer/a1341387)
page names browser extensions that automate activity specifically. Enforcement is
real and graduated: warning, then a 3–14 day sending restriction, then permanent.
The account at risk is yours.

**Do not publish this to the Chrome Web Store.** Load it unpacked, for yourself.

## Install

1. Open `chrome://extensions`
2. Turn on **Developer mode** (top right)
3. **Load unpacked** → pick this folder
4. Be logged into LinkedIn in the same browser profile

## Use

Click the extension icon and fill in:

| Field | |
|---|---|
| **Search category / keywords** | Required. What you'd type into LinkedIn people search. |
| **Company** | Optional. Appended to the search, and (if strict mode is on) each result card must actually mention it or it's skipped. |
| **Note** | Optional, 200 char max. Supports `{{firstName}}`, `{{lastName}}`, `{{fullName}}`, `{{company}}`. |
| **Daily limit** | 0–30. Ticking the unlock box extends it to 50. |
| **Min / max delay** | Seconds between invites. Randomized inside the range. |

Hit **Start**. A LinkedIn search tab opens and works through the results — scrolling,
clicking Connect, adding the note, sending, paging forward — until the run's quota is
used up. **Stop** halts it, as does closing the tab.

Leave the tab in the foreground. Chrome throttles timers in background tabs, which
stretches the delays out unpredictably.

## The caps

Defined in `limits.js`, enforced in `background.js`:

- **30/day** without the unlock box, **50/day** absolute ceiling with it
- **100 per rolling 7 days** — this one is the important one. It's LinkedIn's own
  soft limit, and blowing past it is the most reliable way to get restricted.

Counting happens in the service worker against a timestamp history, not in the page,
so reloading the tab or restarting the browser doesn't reset your usage.

The run also self-aborts if LinkedIn shows an invitation-limit dialog, and skips
anyone whose invite requires email verification.

## What actually matters for not getting restricted

Volume is the obvious lever but it isn't the main one — **acceptance rate is**. If you
send 80 requests and 70% sit ignored, LinkedIn's classifier reads that as spam no
matter how human your timing looks. Tight targeting and a note that gives a real
reason to accept do more for your account's safety than any delay tuning.

## Files

| | |
|---|---|
| `limits.js` | The caps. Single source of truth. |
| `background.js` | Service worker: quota accounting, run state, logging. |
| `content.js` | Drives the LinkedIn UI — finds invite buttons, handles the modal, pages. |
| `popup.*` | Config form, live quota, activity log. |

`content.js` keys off the `aria-label="Invite <Name> to connect"` contract rather than
CSS class names, which churn constantly. If LinkedIn changes that, `collectCandidates()`
is the one function to fix.
