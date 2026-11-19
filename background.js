importScripts("shared.js");

const ALARM_NAME = "tab-saver-check";

async function discardIdleTabs() {
  const { idleMinutes, whitelist } = await loadSettings();
  const tabs = await chrome.tabs.query({});
  const cutoff = Date.now() - idleMinutes * 60 * 1000;

  const idleTabs = tabs.filter((tab) => tab.lastAccessed != null && tab.lastAccessed <= cutoff);
  await sleepTabs(idleTabs, whitelist);
}

async function ensureAlarm() {
  const existing = await chrome.alarms.get(ALARM_NAME);
  if (!existing) {
    await chrome.alarms.create(ALARM_NAME, { periodInMinutes: 1 });
  }
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) discardIdleTabs();
});

chrome.runtime.onInstalled.addListener(ensureAlarm);
chrome.runtime.onStartup.addListener(ensureAlarm);
