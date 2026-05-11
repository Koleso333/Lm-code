let _port = null;
let _aiQueue = [];

function connectPort() {
  try {
    _port = chrome.runtime.connect({ name: "lm-bridge" });
    console.log("[lm-addition] port connected");

    // flush queued messages
    while (_aiQueue.length > 0) {
      const queued = _aiQueue.shift();
      try {
        _port.postMessage(queued);
        console.log("[lm-addition] queued AI_RESPONSE flushed");
      } catch (e) {
        console.error("[lm-addition] flush failed:", e);
      }
    }

    _port.onMessage.addListener((msg) => {
      if (msg.type === "INJECT") {
        console.log("[lm-addition] INJECT via port, text len:", (msg.text || "").length);
        if (preset && preset.inject) {
          preset.inject(msg.text);
        }
      }
    });
    _port.onDisconnect.addListener(() => {
      console.log("[lm-addition] port disconnected, reconnecting...");
      _port = null;
      setTimeout(connectPort, 1000);
    });
  } catch (e) {
    console.error("[lm-addition] connect failed:", e);
    setTimeout(connectPort, 2000);
  }
}

connectPort();

function sendAiResponse(text, model) {
  console.log("[lm-addition] sendAiResponse called, port=", !!_port, "text_len=", (text || "").length, "model=", model);
  const msg = { type: "AI_RESPONSE", text, model: model || "" };
  if (_port && _port.postMessage) {
    try {
      _port.postMessage(msg);
      console.log("[lm-addition] AI_RESPONSE sent via port");
      return;
    } catch (e) {
      console.error("[lm-addition] postMessage failed:", e);
    }
  }
  // fallback: queue and try sendMessage
  console.log("[lm-addition] sendAiResponse: no port, queueing and trying sendMessage");
  _aiQueue.push(msg);
  try {
    chrome.runtime.sendMessage(msg);
    console.log("[lm-addition] AI_RESPONSE sent via sendMessage");
  } catch (e) {
    console.error("[lm-addition] sendMessage fallback failed:", e);
  }
}

const MAX_LOGS = 100;

async function log(msg) {
  try {
    const result = await chrome.storage.local.get("lm_logs");
    const logs = result.lm_logs || [];
    const time = new Date().toLocaleTimeString("ru-RU", { hour12: false });
    logs.push(`[${time}] ${msg}`);
    if (logs.length > MAX_LOGS) logs.splice(0, logs.length - MAX_LOGS);
    await chrome.storage.local.set({ lm_logs: logs });
  } catch (e) {
    // extension context invalidated, ignore
  }
}

const KNOWN_COMMANDS = [
  "FILELIST", "READFILE", "WRITEFILE", "APPENDFILE",
  "DELETEFILE", "RUN", "SEARCH", "EDITLINES", "EDIT",
];

const COMMAND_RE = new RegExp(
  "(" + KNOWN_COMMANDS.join("|") + ")\\s*\\(",
  "g"
);

function isCommandComplete(raw, name) {
  if (!raw.includes("(")) return false;
  if (name === "WRITEFILE" || name === "APPENDFILE") {
    return raw.includes("CONTENT_START") && raw.includes("CONTENT_END");
  }
  if (name === "EDITLINES") {
    return (
      raw.includes("EXPECT_HASH:") &&
      raw.includes("CONTENT_START") &&
      raw.includes("CONTENT_END")
    );
  }
  if (name === "EDIT") {
    return (
      raw.includes("OLD_START") &&
      raw.includes("OLD_END") &&
      raw.includes("NEW_START") &&
      raw.includes("NEW_END")
    );
  }
  return raw.includes(")");
}

function extractCommand(text) {
  // strip common accidental prefixes before the first command
  const cleaned = text.replace(/^[.\s]*(txt|text)?[.\s]*/i, "");
  const offset = text.length - cleaned.length;

  COMMAND_RE.lastIndex = 0;
  let m;
  while ((m = COMMAND_RE.exec(cleaned)) !== null) {
    const startIdx = m.index + offset;
    const name = m[1];

    let endIdx = text.length;

    if (name === "WRITEFILE" || name === "APPENDFILE") {
      const idx = text.indexOf("CONTENT_END", startIdx);
      if (idx !== -1) endIdx = idx + "CONTENT_END".length;
      else continue;
    } else if (name === "EDITLINES") {
      const idx = text.indexOf("CONTENT_END", startIdx);
      if (idx !== -1) endIdx = idx + "CONTENT_END".length;
      else continue;
    } else if (name === "EDIT") {
      const idx = text.indexOf("NEW_END", startIdx);
      if (idx !== -1) endIdx = idx + "NEW_END".length;
      else continue;
    } else {
      const idx = text.indexOf(")", startIdx);
      if (idx !== -1) endIdx = idx + 1;
      else continue;
    }

    const raw = text.substring(startIdx, endIdx).trim();
    if (isCommandComplete(raw, name)) {
      return { raw, startIdx, endIdx, name };
    }
  }
  return null;
}

function highlightTextRange(container, startOffset, endOffset, className) {
  const nodes = [];
  const walker = document.createTreeWalker(
    container,
    NodeFilter.SHOW_TEXT,
    {
      acceptNode(node) {
        const parent = node.parentElement;
        if (!parent) return NodeFilter.FILTER_REJECT;
        const tag = parent.tagName;
        if (tag === "SCRIPT" || tag === "STYLE" || tag === "NOSCRIPT")
          return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    }
  );

  let offset = 0;
  while (walker.nextNode()) {
    const node = walker.currentNode;
    const len = node.length;
    nodes.push({ node, start: offset, end: offset + len });
    offset += len;
  }

  for (const { node, start, end } of nodes) {
    const overlapStart = Math.max(start, startOffset);
    const overlapEnd = Math.min(end, endOffset);
    if (overlapStart >= overlapEnd) continue;

    const localStart = overlapStart - start;
    const localEnd = overlapEnd - start;
    const fullText = node.textContent;
    const before = fullText.substring(0, localStart);
    const target = fullText.substring(localStart, localEnd);
    const after = fullText.substring(localEnd);

    const parent = node.parentNode;
    const ref = node;

    if (before) {
      parent.insertBefore(document.createTextNode(before), ref);
    }
    const span = document.createElement("span");
    span.className = className;
    span.textContent = target;
    parent.insertBefore(span, ref);
    if (after) {
      parent.insertBefore(document.createTextNode(after), ref);
    }

    parent.removeChild(ref);
  }
}

function wrapTextNodes(container, className, excludeSelector) {
  const walker = document.createTreeWalker(
    container,
    NodeFilter.SHOW_TEXT,
    {
      acceptNode(node) {
        if (!node.textContent.trim()) return NodeFilter.FILTER_REJECT;
        let parent = node.parentElement;
        while (parent) {
          if (parent.classList && (
            parent.classList.contains("lm-highlight-api") ||
            parent.classList.contains("lm-highlight-response") ||
            parent.classList.contains("lm-highlight-input")
          )) return NodeFilter.FILTER_REJECT;
          if (excludeSelector && parent.matches && parent.matches(excludeSelector))
            return NodeFilter.FILTER_REJECT;
          parent = parent.parentElement;
        }
        return NodeFilter.FILTER_ACCEPT;
      },
    }
  );

  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);

  for (const node of nodes) {
    const span = document.createElement("span");
    span.className = className;
    span.textContent = node.textContent;
    node.parentNode.replaceChild(span, node);
  }
}

const PRESETS = {
  arena: {
    host: /arena\.ai/,

    getCodeBlocks() {
      return document.querySelectorAll("pre.shiki-code-block");
    },

    _isAi(el) {
      return el.classList.contains("bg-surface-primary") && el.querySelector('button[aria-label="Like this response"]') !== null;
    },

    _isUser(el) {
      return el.classList.contains("bg-surface-raised");
    },

    getMessages() {
      const ai = Array.from(document.querySelectorAll(".bg-surface-primary")).filter(e => this._isAi(e));
      const user = Array.from(document.querySelectorAll(".bg-surface-raised"));
      const all = [];
      for (const el of ai) all.push({ type: "ai", el });
      for (const el of user) all.push({ type: "user", el });
      all.sort((a, b) => {
        const ra = a.el.compareDocumentPosition(b.el);
        return ra & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
      });
      return all;
    },

    getLastResponse() {
      const msgs = this.getMessages();
      for (let i = msgs.length - 1; i >= 0; i--) {
        if (msgs[i].type === "ai") return msgs[i].el;
      }
      return null;
    },

    getLastInput() {
      const msgs = this.getMessages();
      for (let i = msgs.length - 1; i >= 0; i--) {
        if (msgs[i].type === "user") return msgs[i].el;
      }
      return null;
    },

    isStreaming() {
      return false;
    },

    getInputField() {
      return document.querySelector('textarea[name="message"]');
    },

    inject(text) {
      const ta = this.getInputField();
      if (!ta) return;
      ta.focus();

      const nativeSetter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype, "value"
      ).set;
      nativeSetter.call(ta, text);

      ta.dispatchEvent(new Event("input", { bubbles: true }));

      setTimeout(() => {
        const down = new KeyboardEvent("keydown", {
          key: "Enter",
          code: "Enter",
          keyCode: 13,
          which: 13,
          bubbles: true,
          cancelable: true,
          shiftKey: false,
          isComposing: false,
        });
        ta.dispatchEvent(down);

        const press = new KeyboardEvent("keypress", {
          key: "Enter",
          code: "Enter",
          keyCode: 13,
          which: 13,
          bubbles: true,
          cancelable: true,
          shiftKey: false,
        });
        ta.dispatchEvent(press);

        const up = new KeyboardEvent("keyup", {
          key: "Enter",
          code: "Enter",
          keyCode: 13,
          which: 13,
          bubbles: true,
          cancelable: true,
          shiftKey: false,
          isComposing: false,
        });
        ta.dispatchEvent(up);
      }, 100);
    },

    _serializeProse(el) {
      let text = "";
      for (const child of el.childNodes) {
        if (child.nodeType === Node.TEXT_NODE) {
          text += child.textContent;
        } else if (child.nodeType === Node.ELEMENT_NODE) {
          const tag = child.tagName.toLowerCase();
          if (tag === "p") {
            text += this._serializeProse(child) + "\n\n";
          } else if (tag === "pre") {
            const code = child.querySelector("code");
            const inner = code ? code.textContent : child.textContent;
            text += "```txt\n" + inner + "\n```\n\n";
          } else if (tag === "br") {
            text += "\n";
          } else if (tag === "ol" || tag === "ul") {
            for (const li of child.children) {
              text += "- " + this._serializeProse(li).trim() + "\n";
            }
            text += "\n";
          } else if (tag === "code" && child.parentElement?.tagName.toLowerCase() !== "pre") {
            text += "`" + child.textContent + "`";
          } else if (tag === "strong" || tag === "b") {
            text += "**" + this._serializeProse(child) + "**";
          } else if (tag === "em" || tag === "i") {
            text += "*" + this._serializeProse(child) + "*";
          } else {
            text += this._serializeProse(child);
          }
        }
      }
      return text;
    },

    _isStreaming(el) {
      return !!el.querySelector(".animate-spin");
    },

    highlightResponse() {
      log("highlightResponse: scanning .bg-surface-primary");
      let found = 0, sent = 0;
      for (const el of document.querySelectorAll(".bg-surface-primary")) {
        if (!this._isAi(el)) continue;
        const prose = el.querySelector(".prose");
        if (!prose || prose.dataset.lmResp === "done") continue;
        if (prose.closest(".bg-surface-raised")) continue;
        found++;

        // Primary check: spinner present = still generating
        if (this._isStreaming(el)) {
          log("highlightResponse: skipped (still streaming, spinner active)");
          continue;
        }

        const text = this._serializeProse(prose);
        console.log("[lm-addition] serialized text, len=", (text || "").length, "first100=", (text || "").substring(0, 100).replace(/\n/g, "\\n"));
        if (!text) continue;

        // Fallback stability check: wait for text to settle after spinner disappears
        if (text !== prose.dataset.lmStableText) {
          prose.dataset.lmStableText = text;
          log(`highlightResponse: text changed post-stream, waiting for stability (len=${text.length})`);
          if (prose._lmStabilityTimer) clearTimeout(prose._lmStabilityTimer);
          prose._lmStabilityTimer = setTimeout(() => {
            prose._lmStabilityTimer = null;
            log("highlightResponse: stability timer fired, re-scanning");
            scanNewBlocks();
          }, 5000);
          continue;
        }

        // Text is stable and spinner is gone — response is complete
        if (prose._lmStabilityTimer) {
          clearTimeout(prose._lmStabilityTimer);
          prose._lmStabilityTimer = null;
        }
        prose.dataset.lmResp = "done";

        if (text !== prose.dataset.lmLastText) {
          prose.dataset.lmLastText = text;
          const model = el.querySelector("span.truncate")?.textContent?.trim() || "";
          log(`highlightResponse: sending AI_RESPONSE, text len=${text.length}, model=${model}`);
          sendAiResponse(text, model);
          sent++;
        }

        wrapTextNodes(prose, "lm-highlight-response", ".shiki-code-block, [data-code-block]");
      }
      log(`highlightResponse: found=${found}, sent=${sent}`);
    },


  },

  default: {
    host: null,
    getCodeBlocks() {
      return [];
    },
    getMessages() {
      return [];
    },
    getLastResponse() {
      return null;
    },
    getLastInput() {
      return null;
    },
    isStreaming() {
      return false;
    },
    getInputField() {
      return null;
    },
    getSendButton() {
      return null;
    },
    inject() {},
    highlightResponse() {},
    highlightInput() {},
  },
};

function loadPreset() {
  const host = location.host;
  for (const key of Object.keys(PRESETS)) {
    const p = PRESETS[key];
    if (p.host && host.match(p.host)) {
      log(`preset loaded: ${key} for host ${host}`);
      return p;
    }
  }
  log(`fallback preset loaded: default`);
  return PRESETS.default;
}

let preset = null;
let isEnabled = false;
let observer = null;
let scanTimer = null;

function markAllExisting() {
  if (!preset) return;
  const blocks = preset.getCodeBlocks();
  log(`markAllExisting: ${blocks.length} code blocks marked as old`);
  for (const block of blocks) {
    block.dataset.lmOld = "true";
  }
  const aiEls = document.querySelectorAll(".bg-surface-primary");
  let aiCount = 0;
  for (const el of aiEls) {
    if (preset._isAi && !preset._isAi(el)) continue;
    const prose = el.querySelector(".prose");
    if (prose && !prose.closest(".bg-surface-raised")) { prose.dataset.lmResp = "done"; aiCount++; }
  }
  log(`markAllExisting: ${aiCount} ai messages marked as done`);
}

function clearOldMarks() {
  for (const block of document.querySelectorAll('[data-lm-old="true"]')) {
    delete block.dataset.lmOld;
  }
}

function scanBlock(block) {
  if (block.dataset?.lmOld === "true") {
    log("scanBlock: skipped (old mark)");
    return;
  }
  if (block.querySelector(".lm-highlight-api")) {
    log("scanBlock: skipped (already highlighted)");
    return;
  }
  // Only process code blocks inside AI messages, skip user messages
  if (block.closest(".bg-surface-raised")) {
    log("scanBlock: skipped (inside user message)");
    return;
  }

  const text = block.textContent;
  log(`scanBlock: text length=${text.length}, first200=${text.substring(0, 200).replace(/\n/g, "\\n")}`);
  const cmd = extractCommand(text);
  if (!cmd) {
    log(`scanBlock: no command found. Last100=${text.substring(Math.max(0, text.length - 100)).replace(/\n/g, "\\n")}`);
    return;
  }

  log(`scanBlock: found command ${cmd.name} at ${cmd.startIdx}-${cmd.endIdx}`);
  highlightTextRange(block, cmd.startIdx, cmd.endIdx, "lm-highlight-api");
  log("scanBlock: command highlighted, sending to background");
  chrome.runtime.sendMessage({ type: "EXECUTE_COMMAND", raw: cmd.raw });
}

function isBattleActive() {
  return !!document.querySelector('[aria-roledescription="carousel"]');
}

function tryClickSkip() {
  for (const btn of document.querySelectorAll("button")) {
    const span = btn.querySelector("span");
    if (span && span.textContent.trim() === "Skip") {
      log("tryClickSkip: clicking Skip button");
      btn.click();
      return true;
    }
  }
  log("tryClickSkip: Skip button not found yet");
  return false;
}

function scanNewBlocks() {
  if (!isEnabled || !preset) {
    log(`scanNewBlocks: disabled=${!isEnabled} preset=${!!preset}`);
    return;
  }
  if (isBattleActive()) {
    log("scanNewBlocks: blocked (battle comparison UI active)");
    tryClickSkip();
    return;
  }
  const blocks = preset.getCodeBlocks();
  log(`scanNewBlocks: scanning ${blocks.length} blocks`);
  for (const block of blocks) {
    scanBlock(block);
  }
  if (preset.highlightResponse) {
    log("scanNewBlocks: calling preset.highlightResponse()");
    preset.highlightResponse();
  }

}

function clearHighlights() {
  const classes = ["lm-highlight-api", "lm-highlight-response", "lm-highlight-input"];
  for (const cls of classes) {
    let spans;
    while ((spans = document.querySelectorAll("." + cls)).length > 0) {
      for (const span of Array.from(spans)) {
        if (!span.parentNode) continue;
        const parent = span.parentNode;
        while (span.firstChild) {
          parent.insertBefore(span.firstChild, span);
        }
        if (span.parentNode === parent) {
          parent.removeChild(span);
        }
        parent.normalize();
      }
    }
  }
  for (const el of document.querySelectorAll("[data-lm-resp]")) {
    delete el.dataset.lmResp;
  }

  log("clearHighlights: done");
}

function initObserver() {
  if (observer) observer.disconnect();
  observer = new MutationObserver(() => {
    if (!isEnabled) return;
    if (scanTimer) clearTimeout(scanTimer);
    scanTimer = setTimeout(() => {
      log("MutationObserver: debounced scan triggered");
      scanNewBlocks();
    }, 500);
  });
  observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  log("initObserver: MutationObserver started");
}

log("content.js: initializing");
chrome.storage.local.get("enabled").then((result) => {
  isEnabled = result.enabled ?? false;
  log(`content.js: enabled=${isEnabled}`);
  preset = loadPreset();
  if (isEnabled) {
    markAllExisting();
    initObserver();
    scanNewBlocks();
  }
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "TOGGLE") {
    isEnabled = msg.enabled;
    log(`TOGGLE: enabled=${isEnabled}`);
    if (isEnabled) {
      preset = loadPreset();
      markAllExisting();
      initObserver();
      scanNewBlocks();
    } else {
      if (observer) {
        observer.disconnect();
        observer = null;
      }
      if (scanTimer) {
        clearTimeout(scanTimer);
        scanTimer = null;
      }
      clearHighlights();
      clearOldMarks();
    }
  }
  if (msg.type === "INJECT") {
    log(`INJECT received: "${msg.text.substring(0, 40)}" preset=${!!preset}`);
    if (preset && preset.inject) {
      log(`INJECT: calling preset.inject`);
      preset.inject(msg.text);
    } else {
      log("INJECT: no preset or inject method");
    }
  }
});

log("content.js: ready, waiting for INJECT from background");
