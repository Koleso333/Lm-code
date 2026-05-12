document.addEventListener("DOMContentLoaded", async () => {
  const powerBtn = document.getElementById("powerBtn");
  const ring = document.getElementById("ring");
  const glow = document.getElementById("glow");
  const stateLabel = document.getElementById("stateLabel");
  const presetLine = document.getElementById("presetLine");
  const timingLine = document.getElementById("timingLine");

  const result = await chrome.storage.local.get(["enabled", "lm_preset_name", "lm_last_request", "lm_last_response"]);
  let enabled = result.enabled ?? false;

  function updateUI() {
    powerBtn.classList.toggle("active", enabled);
    ring.classList.toggle("active", enabled);
    glow.classList.toggle("active", enabled);
    stateLabel.classList.toggle("active", enabled);
    stateLabel.textContent = enabled ? "ON" : "OFF";
  }

  function updatePreset(name) {
    if (!name || name === "default") {
      presetLine.textContent = "Пресет не загружен";
    } else {
      presetLine.textContent = `Пресет: ${name}`;
    }
  }

  function formatTime(ts) {
    if (!ts) return "—";
    return new Date(ts).toLocaleTimeString("ru-RU", { hour12: false });
  }

  function updateTiming(req, resp) {
    const parts = [];
    if (req) parts.push(`запрос ${formatTime(req)}`);
    if (resp) parts.push(`ответ ${formatTime(resp)}`);
    timingLine.textContent = parts.length ? parts.join(" · ") : "—";
  }

  updateUI();
  updatePreset(result.lm_preset_name);
  updateTiming(result.lm_last_request, result.lm_last_response);

  chrome.storage.onChanged.addListener((changes) => {
    if (changes.lm_preset_name) updatePreset(changes.lm_preset_name.newValue);
    if (changes.lm_last_request || changes.lm_last_response) {
      const req = changes.lm_last_request?.newValue ?? result.lm_last_request;
      const resp = changes.lm_last_response?.newValue ?? result.lm_last_response;
      updateTiming(req, resp);
    }
  });

  powerBtn.addEventListener("click", async () => {
    enabled = !enabled;
    await chrome.storage.local.set({ enabled });
    updateUI();

    const tabs = await chrome.tabs.query({});
    for (const tab of tabs) {
      try {
        await chrome.tabs.sendMessage(tab.id, { type: "TOGGLE", enabled });
      } catch (e) {}
    }
  });
});
