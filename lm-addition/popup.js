const MAX_LOGS = 100;

document.addEventListener("DOMContentLoaded", async () => {
  const toggle = document.getElementById("enabledToggle");
  const status = document.getElementById("status");
  const logBox = document.getElementById("log-box");

  const result = await chrome.storage.local.get("enabled");
  const enabled = result.enabled ?? false;
  toggle.checked = enabled;
  status.textContent = enabled ? "Активно" : "Выключено";

  async function renderLogs() {
    const r = await chrome.storage.local.get("lm_logs");
    const logs = r.lm_logs || [];
    if (logs.length === 0) {
      logBox.innerHTML = '<div class="log-empty">Нет логов</div>';
      return;
    }
    logBox.textContent = "";
    for (const line of logs) {
      const div = document.createElement("div");
      div.textContent = line;
      logBox.appendChild(div);
    }
    logBox.scrollTop = logBox.scrollHeight;
  }

  renderLogs();

  chrome.storage.onChanged.addListener((changes) => {
    if (changes.lm_logs) renderLogs();
  });

  toggle.addEventListener("change", async () => {
    const newValue = toggle.checked;
    await chrome.storage.local.set({ enabled: newValue });
    status.textContent = newValue ? "Активно" : "Выключено";

    const tabs = await chrome.tabs.query({});
    for (const tab of tabs) {
      try {
        await chrome.tabs.sendMessage(tab.id, { type: "TOGGLE", enabled: newValue });
      } catch (e) {
      }
    }
  });

  const injectBtn = document.getElementById("injectBtn");
  const injectText = document.getElementById("injectText");
  async function addPopupLog(msg) {
    const r = await chrome.storage.local.get("lm_logs");
    const logs = r.lm_logs || [];
    const time = new Date().toLocaleTimeString("ru-RU", { hour12: false });
    logs.push(`[${time}] [popup] ${msg}`);
    if (logs.length > MAX_LOGS) logs.splice(0, logs.length - MAX_LOGS);
    await chrome.storage.local.set({ lm_logs: logs });
  }

  injectBtn.addEventListener("click", async () => {
    const text = injectText.value.trim();
    if (!text) { addPopupLog("inject skipped: empty text"); return; }
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tabs.length) { addPopupLog("inject skipped: no active tab"); return; }
    try {
      addPopupLog(`inject sending to tab ${tabs[0].id}`);
      await chrome.tabs.sendMessage(tabs[0].id, { type: "INJECT", text });
      injectText.value = "";
      addPopupLog("inject sent ok");
    } catch (e) {
      addPopupLog(`inject error: ${e.message}`);
    }
  });

  injectText.addEventListener("keydown", async (e) => {
    if (e.key !== "Enter") return;
    injectBtn.click();
  });
});
