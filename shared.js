// Shared by background.js (via importScripts) and popup.js (via <script>).

const DEFAULT_SETTINGS = {
  idleMinutes: 30,
  whitelist: []
};

// Turn whatever the user typed ("https://www.YouTube.com/watch?v=1") into a bare domain ("youtube.com").
function normalizeDomain(input) {
  let text = String(input || "").trim().toLowerCase();
  if (!text) return "";
  if (!/^[a-z][a-z0-9+.-]*:\/\//.test(text)) text = "https://" + text;
  try {
    let host = new URL(text).hostname;
    host = host.replace(/^www\./, "").replace(/\.$/, "");
    // Must look like a real host: "localhost" or something with a dot.
    if (host === "localhost" || /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host)) return host;
    return "";
  } catch {
    return "";
  }
}

// "mail.google.com" is protected by a whitelist entry "google.com".
function isWhitelisted(url, whitelist) {
  let host;
  try {
    host = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return false;
  }
  return whitelist.some((domain) => host === domain || host.endsWith("." + domain));
}

// Tabs that must never be put to sleep, whether automatically or by the one-click buttons.
function isProtected(tab, whitelist) {
  return (
    tab.id == null ||
    tab.active ||                // the tab you are looking at
    tab.pinned ||                // pinned tabs are always protected
    tab.audible ||               // playing sound (music, video, call)
    tab.discarded ||             // already asleep
    !tab.url ||
    !/^https?:/.test(tab.url) || // skip chrome://, file://, extension pages
    isWhitelisted(tab.url, whitelist)
  );
}

/* ---------- Sleep marker ----------
 * Chrome lets extensions neither recolor tabs nor draw on the tab strip. What it does allow is
 * changing a page's own favicon. So right before discarding, we replace the favicon with a
 * copy wrapped in a dashed ring. A discarded tab keeps the last favicon it had, so the marker stays
 * visible while the tab sleeps; when the tab is reopened the page reloads with its real favicon.
 */
const SLEEP_ICON_SIZE = 64;
const MARKER_SETTLE_MS = 400; // give Chrome time to pick up the new favicon before discarding

async function makeSleepIcon(tab) {
  const size = SLEEP_ICON_SIZE;
  const center = size / 2;
  const canvas = new OffscreenCanvas(size, size);
  const ctx = canvas.getContext("2d");

  try {
    const url = new URL(chrome.runtime.getURL("/_favicon/"));
    url.searchParams.set("pageUrl", tab.url);
    url.searchParams.set("size", "64");
    const bitmap = await createImageBitmap(await (await fetch(url)).blob());
    // Full size: the tab strip gives a favicon a fixed square, so the ring is drawn on top of the icon's edge.
    ctx.drawImage(bitmap, 0, 0, size, size);
  } catch {
    // No favicon available: the ring alone still marks the tab.
  }

  ctx.strokeStyle = "rgba(200, 203, 208, 0.4)"; // faint, half-transparent grey
  ctx.lineWidth = 6;
  ctx.setLineDash([9, 6]);
  ctx.beginPath();
  ctx.arc(center, center, center - 4, 0, Math.PI * 2);
  ctx.stroke();

  const bytes = new Uint8Array(await (await canvas.convertToBlob({ type: "image/png" })).arrayBuffer());
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return "data:image/png;base64," + btoa(binary);
}

// Runs inside the page. Keeps the original icon links so they can be put back if the discard fails.
function swapFaviconInPage(href) {
  const originals = [...document.querySelectorAll('link[rel~="icon"]')];
  window.__tabSaverOriginalIcons = originals;
  originals.forEach((link) => link.remove());
  const link = document.createElement("link");
  link.rel = "icon";
  link.href = href;
  link.dataset.tabSaver = "1";
  document.head.append(link);
}

// Runs inside the page. Undoes swapFaviconInPage.
function restoreFaviconInPage() {
  document.querySelectorAll("link[data-tab-saver]").forEach((link) => link.remove());
  (window.__tabSaverOriginalIcons || []).forEach((link) => document.head.append(link));
  delete window.__tabSaverOriginalIcons;
}

// Returns true if the marker was applied. Some pages (PDF viewer, Chrome Web Store) refuse scripts.
async function markAsleep(tab) {
  try {
    const icon = await makeSleepIcon(tab);
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: swapFaviconInPage, args: [icon] });
    return true;
  } catch (error) {
    console.debug("Tab Saver: could not mark tab", tab.id, error);
    return false;
  }
}

async function unmarkAsleep(tabId) {
  try {
    await chrome.scripting.executeScript({ target: { tabId }, func: restoreFaviconInPage });
  } catch {
    // Tab is gone or not scriptable; nothing to undo.
  }
}

// Discard every unprotected tab in the list. Returns how many were put to sleep.
async function sleepTabs(tabs, whitelist) {
  const targets = tabs.filter((tab) => !isProtected(tab, whitelist));
  if (targets.length === 0) return 0;

  const marked = await Promise.all(targets.map(markAsleep));
  if (marked.some(Boolean)) await new Promise((resolve) => setTimeout(resolve, MARKER_SETTLE_MS));

  let count = 0;
  for (const [i, tab] of targets.entries()) {
    let discarded = false;
    try {
      // Resolves to the discarded tab on success, or undefined when Chrome declines.
      discarded = Boolean(await chrome.tabs.discard(tab.id));
    } catch (error) {
      // e.g. the user switched to this tab during the short wait above.
      console.debug("Tab Saver: could not discard tab", tab.id, error);
    }
    if (discarded) count++;
    else if (marked[i]) await unmarkAsleep(tab.id); // still awake: don't leave the sleep icon on it
  }
  return count;
}

async function loadSettings() {
  const stored = await chrome.storage.sync.get(DEFAULT_SETTINGS);
  return {
    idleMinutes: Number(stored.idleMinutes) || DEFAULT_SETTINGS.idleMinutes,
    whitelist: Array.isArray(stored.whitelist) ? stored.whitelist : []
  };
}
