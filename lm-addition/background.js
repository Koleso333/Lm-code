const _ports = new Map();

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "lm-bridge") return;
  const tabId = port.sender?.tab?.id || 0;
  console.log("[bg] port connected from tab", tabId);
  _ports.set(tabId, port);

  port.onMessage.addListener(async (msg) => {
    if (msg.type === "AI_RESPONSE") {
      try {
        await fetch("http://127.0.0.1:11856/ai_response", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: msg.text, model: msg.model || "" }),
        });
        console.log("[bg] AI_RESPONSE forwarded from port, len:", (msg.text || "").length, "model:", msg.model);
      } catch (err) {
        console.error("[bg] AI_RESPONSE forward failed:", err);
      }
    }
  });

  port.onDisconnect.addListener(() => {
    console.log("[bg] port disconnected from tab", tabId);
    _ports.delete(tabId);
  });
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "EXECUTE_COMMAND") {
    (async () => {
      const cfg = await chrome.storage.local.get("enabled");
      if (!cfg.enabled) {
        sendResponse({ status: "rejected", reason: "disabled" });
        return;
      }
      try {
        await handleCommand(msg.raw);
        sendResponse({ status: "ok" });
      } catch (err) {
        sendResponse({ status: "error", message: String(err) });
      }
    })();
    return true;
  }
  if (msg.type === "AI_RESPONSE") {
    (async () => {
      try {
        await fetch("http://127.0.0.1:11856/ai_response", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: msg.text, model: msg.model || "" }),
        });
        console.log("[bg] AI_RESPONSE forwarded via sendMessage fallback");
        sendResponse({ status: "ok" });
      } catch (err) {
        console.error("[bg] AI_RESPONSE fallback failed:", err);
        sendResponse({ status: "error", message: String(err) });
      }
    })();
    return true;
  }
});

async function handleCommand(raw) {
  const resp = await fetch("http://127.0.0.1:11856/execute", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ raw }),
  });
  if (!resp.ok) {
    throw new Error(`Host error ${resp.status}`);
  }
  await resp.json();
}

async function pollInject() {
  try {
    const resp = await fetch("http://127.0.0.1:11856/pending_inject");
    if (!resp.ok) {
      console.error("[bg] pollInject error:", resp.status);
      return;
    }
    const data = await resp.json();
    if (data.pending) {
      console.log("[bg] inject found, sending to", _ports.size, "ports");
      let sent = false;
      for (const [tabId, port] of _ports.entries()) {
        try {
          port.postMessage({ type: "INJECT", text: data.text });
          console.log("[bg] INJECT sent to tab", tabId, "via port");
          sent = true;
        } catch (e) {
          console.error("[bg] postMessage to tab", tabId, "failed:", e);
          _ports.delete(tabId);
        }
      }
      if (!sent) {
        console.log("[bg] no ports, trying tabs.sendMessage fallback");
        const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
        for (const tab of tabs) {
          try {
            await chrome.tabs.sendMessage(tab.id, { type: "INJECT", text: data.text });
            console.log("[bg] INJECT sent to tab", tab.id, "via sendMessage");
            sent = true;
          } catch (e) {
            console.error("[bg] sendMessage to tab", tab.id, "failed:", e);
          }
        }
      }
      if (!sent) {
        console.warn("[bg] INJECT could not be delivered to any tab");
      }
    }
  } catch (e) {
    console.error("[bg] pollInject fetch failed:", e);
  }
}

function schedulePoll() {
  setTimeout(async () => {
    await pollInject();
    schedulePoll();
  }, 2000);
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "keepalive") {
    pollInject();
  }
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create("keepalive", { periodInMinutes: 0.5 });
  schedulePoll();
});

chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create("keepalive", { periodInMinutes: 0.5 });
  schedulePoll();
});

chrome.alarms.get("keepalive", (alarm) => {
  if (alarm) {
    schedulePoll();
  }
});

console.log("[bg] background.js loaded");
