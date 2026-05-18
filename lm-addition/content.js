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
        if (!isEnabled) {
          console.log("[lm-addition] INJECT ignored (disabled)");
          return;
        }
        console.log("[lm-addition] INJECT via port, text len:", (msg.text || "").length);
        const mode = getSiteMode();
        if (mode !== null && mode !== "Direct") {
          log(`INJECT blocked: mode="${mode}", not Direct`);
          sendAiResponse("Выберите режим Direct в браузере для корректной работы", "__system_error__");
          return;
        }
        if (!preset || !preset.host) {
          log("INJECT blocked: no matching preset for this page");
          sendAiResponse("Пресет не загружен: откройте поддерживаемый сайт (arena.ai) в браузере", "__system_error__");
          return;
        }
        noteInjectForSiteError();
        if (preset && preset.inject) {
          preset.inject(msg.text);
        }
        setTimeout(detectSiteError, 1500);
      }
      if (msg.type === "STOP_RETRY") {
        stopRetry();
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
  if (!isEnabled) {
    console.log("[lm-addition] sendAiResponse ignored (disabled)");
    return;
  }
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
  "DELETEFILE", "RUN", "SEARCH", "EDITLINES", "EDIT", "QUESTIONS",
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
  if (name === "QUESTIONS") {
    return raw.includes("QUESTIONS_END");
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
    } else if (name === "QUESTIONS") {
      const idx = text.indexOf("QUESTIONS_END", startIdx);
      if (idx !== -1) endIdx = idx + "QUESTIONS_END".length;
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

    async newChat() {
      const getLink = () => {
        const link = document.querySelector('a[href="/text/direct"]');
        return link && link.offsetParent !== null ? link : null;
      };

      // Ссылка уже видна (десктоп)
      let link = getLink();
      if (link) {
        link.click();
        log("newChat: clicked New Chat link (desktop)");
        return true;
      }

      // Мобильный адаптив: открываем сайдбар
      const sidebarBtn = document.querySelector('button[aria-label="Open sidebar"]');
      if (sidebarBtn) {
        sidebarBtn.click();
        log("newChat: clicked Open sidebar button");
        // Ждём появления ссылки
        for (let i = 0; i < 20; i++) {
          await new Promise(r => setTimeout(r, 100));
          link = getLink();
          if (link) break;
        }
      }

      if (link) {
        link.click();
        log("newChat: clicked New Chat link (mobile)");
        return true;
      }

      // Последний fallback: прямая навигация
      log("newChat: link not found, navigating directly");
      window.location.href = "/text/direct";
      return true;
    },

    // --- Model search/select ---

    _modeNames: new Set([
      "Direct", "Battle", "Side-by-side", "Compare",
      "Прямой", "Прямой режим", "Сравнение", "Бой", "Битва",
    ]),

    _modelHints: [
      "claude", "gpt", "gemini", "kimi", "grok", "llama", "qwen",
      "deepseek", "sonnet", "opus", "haiku", "mistral", "command-r",
      "yi-", "phi-", "nemo", "gemma", "o1", "o3", "o4", "glm",
    ],

    _looksLikeModelName(text) {
      const lower = (text || "").trim().toLowerCase();
      if (!lower) return false;
      if (this._modeNames.has(text.trim())) return false;
      for (const hint of this._modelHints) {
        if (lower.includes(hint)) return true;
      }
      return /[a-z]+-[a-z0-9]+(?:-[a-z0-9.]+)+/.test(lower);
    },

    _findModelSelector() {
      const dialogBtns = Array.from(document.querySelectorAll('button[aria-haspopup="dialog"]'));
      for (const btn of dialogBtns) {
        if (btn.offsetParent === null) continue;
        const text = this._getModelBtnName(btn);
        if (this._looksLikeModelName(text)) return btn;
      }
      const comboBtns = Array.from(document.querySelectorAll('button[role="combobox"]'));
      for (const btn of comboBtns) {
        if (btn.offsetParent === null) continue;
        const text = this._getModelBtnName(btn);
        if (this._modeNames.has(text)) continue;
        if (this._looksLikeModelName(text)) return btn;
      }
      for (const btn of dialogBtns) {
        if (btn.offsetParent === null) continue;
        const text = this._getModelBtnName(btn);
        if (this._modeNames.has(text)) continue;
        if (text && text.length > 0) return btn;
      }
      return null;
    },

    _getModelBtnName(btn) {
      const span =
        btn.querySelector("span.flex-1.truncate") ||
        btn.querySelector("span.truncate.font-mono") ||
        btn.querySelector("span.truncate") ||
        btn.querySelector("p");
      return ((span ? span.textContent : btn.textContent) || "").trim();
    },

    _getOptionName(opt) {
      const v = opt.getAttribute("data-value");
      if (v) return v.trim();
      const span =
        opt.querySelector("span.truncate.font-mono") ||
        opt.querySelector("span.truncate") ||
        opt.querySelector("span");
      return ((span ? span.textContent : opt.textContent) || "").trim();
    },

    async _openPickerAndSearch(query) {
      const selector = this._findModelSelector();
      if (!selector) {
        log("_openPickerAndSearch: model selector not found");
        return null;
      }
      try { selector.click(); } catch (e) {
        log("_openPickerAndSearch: click failed: " + e);
        return null;
      }

      // Ждём появления диалога
      let dialog = null;
      for (let i = 0; i < 40; i++) {
        await new Promise(r => setTimeout(r, 100));
        dialog = document.querySelector('[role="dialog"][data-state="open"]');
        if (dialog) break;
      }

      // Если есть строка поиска — вводим запрос
      if (query && dialog) {
        const input =
          dialog.querySelector('[cmdk-input]') ||
          dialog.querySelector('input[type="search"]') ||
          dialog.querySelector('input[type="text"]') ||
          dialog.querySelector('input');
        if (input) {
          input.focus();
          const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
          nativeSetter.call(input, query);
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
          await new Promise(r => setTimeout(r, 600));
          log("_openPickerAndSearch: typed query: " + query);
        } else {
          log("_openPickerAndSearch: no search input found, returning all options");
        }
      }

      // Собираем видимые опции
      let options = Array.from(
        document.querySelectorAll('[role="option"][data-value]')
      ).filter(el => el.offsetParent !== null);
      if (options.length === 0) {
        options = Array.from(
          document.querySelectorAll('[role="option"]')
        ).filter(el => el.offsetParent !== null);
      }
      return options;
    },

    async searchModels(query) {
      const options = await this._openPickerAndSearch(query);
      // Закрываем диалог
      try {
        document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      } catch (e) {}
      await new Promise(r => setTimeout(r, 150));

      if (!options || options.length === 0) {
        log("searchModels: no options found");
        return [];
      }
      const names = options.map(o => this._getOptionName(o)).filter(Boolean);
      log("searchModels: found " + names.length + " models: " + names.join(", "));
      return names;
    },

    async selectModelByIndex(query, index) {
      const options = await this._openPickerAndSearch(query);

      if (!options || options.length === 0) {
        try { document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); } catch (e) {}
        log("selectModelByIndex: no options after search");
        return false;
      }
      if (index < 0 || index >= options.length) {
        try { document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); } catch (e) {}
        log("selectModelByIndex: index " + index + " out of range (" + options.length + " options)");
        return false;
      }

      try {
        options[index].click();
        await new Promise(r => setTimeout(r, 100));
        // Закрываем если диалог остался открытым
        const dialog = document.querySelector('[role="dialog"][data-state="open"]');
        if (dialog) {
          document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        }
        log("selectModelByIndex: clicked option " + index + " (" + this._getOptionName(options[index]) + ")");
        return true;
      } catch (e) {
        log("selectModelByIndex: click failed: " + e);
        return false;
      }
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
      chrome.storage.local.set({ lm_preset_name: key });
      return p;
    }
  }
  log(`fallback preset loaded: default`);
  chrome.storage.local.set({ lm_preset_name: "default" });
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
  log("scanBlock: command highlighted");
}

function isBattleActive() {
  // Старый вариант: carousel
  if (document.querySelector('[aria-roledescription="carousel"]')) return true;
  // Новый вариант: панель с кнопками "Продолжить с A" / "Пропустить" / "Продолжить с B"
  for (const btn of document.querySelectorAll("button")) {
    const span = btn.querySelector("span");
    if (span && (span.textContent.trim() === "Пропустить" || span.textContent.trim() === "Skip")) {
      return true;
    }
  }
  return false;
}

function tryClickSkip() {
  for (const btn of document.querySelectorAll("button")) {
    const span = btn.querySelector("span");
    const text = span ? span.textContent.trim() : "";
    if (text === "Пропустить" || text === "Skip") {
      log("tryClickSkip: clicking Skip/Пропустить button");
      btn.click();
      return true;
    }
  }
  log("tryClickSkip: Skip button not found yet");
  return false;
}

// --- Mode check ---
function getSiteMode() {
  for (const btn of document.querySelectorAll('button[role="combobox"]')) {
    const p = btn.querySelector("p.text-base.font-normal");
    if (p) return p.textContent.trim();
  }
  return null;
}

// --- AI status reporting (sending/thinking/generating/site_error) ---
let _lastReportedStatus = null;

function sendAiStatus(status) {
  if (_lastReportedStatus === status) return;
  _lastReportedStatus = status;
  try {
    chrome.runtime.sendMessage({ type: "AI_STATUS", status: status || "" });
    log(`sendAiStatus: ${status || "(empty)"}`);
  } catch (e) {
    log(`sendAiStatus failed: ${e}`);
  }
}

function detectAiStatus() {
  if (!isEnabled) return;

  // Ищем любой AI-баббл со спиннером напрямую, не через getLastResponse —
  // _isAi требует "Like" button, которой нет во время стриминга/ошибки
  for (const el of document.querySelectorAll(".bg-surface-primary")) {
    if (el.closest(".bg-surface-raised")) continue;
    if (!el.querySelector(".animate-spin")) continue;

    const prose = el.querySelector(".prose");
    const hasText = !!(prose && prose.textContent && prose.textContent.trim().length > 0);
    sendAiStatus(hasText ? "generating" : "thinking");
    return;
  }
}

// --- CAPTCHA detection ---
let _captchaActive = false;

function detectCaptcha() {
  // Общие признаки для ПК и мобильного: recaptcha-v2-container внутри открытого диалога
  const container = document.getElementById("recaptcha-v2-container");
  const dialog = container
    ? container.closest('[role="dialog"][data-state="open"]')
    : null;
  const active = !!dialog;

  if (active && !_captchaActive) {
    _captchaActive = true;
    log("detectCaptcha: CAPTCHA detected");
    try {
      chrome.runtime.sendMessage({ type: "CAPTCHA_STATUS", active: true });
    } catch (e) {
      console.error("[lm-addition] CAPTCHA_STATUS send failed:", e);
    }
  } else if (!active && _captchaActive) {
    _captchaActive = false;
    log("detectCaptcha: CAPTCHA resolved");
    try {
      chrome.runtime.sendMessage({ type: "CAPTCHA_STATUS", active: false });
    } catch (e) {
      console.error("[lm-addition] CAPTCHA_STATUS send failed:", e);
    }
  }
}

// --- Site error detection (e.g. "Something went wrong while generating the response") ---
let _siteErrorActive = false;
let _siteErrorRetryTimer = null;
let _lastInjectTime = 0;
let _retryBlocked = false;

function stopRetry() {
  _retryBlocked = true;
  if (_siteErrorRetryTimer) {
    clearTimeout(_siteErrorRetryTimer);
    _siteErrorRetryTimer = null;
  }
  _siteErrorActive = false;
  log("stopRetry: retry stopped by cancel signal");
}

function noteInjectForSiteError() {
  _lastInjectTime = Date.now();
  _retryBlocked = false;
  // позволяем статусам отправляться заново для нового запроса
  _lastReportedStatus = null;
}

function detectSiteError() {
  if (!isEnabled) return;
  if (_siteErrorActive) return;
  if (_retryBlocked) return;

  // Ищем ошибку в последнем AI-баббле напрямую по DOM.
  // getLastResponse() не подходит — _isAi требует "Like" button, которой нет при ошибке.
  // Берём последний .bg-surface-primary не внутри .bg-surface-raised.
  let errorP = null;
  const aiEls = Array.from(document.querySelectorAll(".bg-surface-primary"))
    .filter(el => !el.closest(".bg-surface-raised"));
  for (let i = aiEls.length - 1; i >= 0; i--) {
    for (const p of aiEls[i].querySelectorAll("p.text-interactive-negative")) {
      if (p.textContent.includes("Something went wrong")) {
        errorP = p;
        break;
      }
    }
    if (errorP) break;
  }

  if (!errorP) return;

  const errorContainer = errorP.closest("div.flex.items-center") || errorP.parentElement;
  if (!errorContainer) return;

  const handledAt = parseInt(errorContainer.dataset.lmSiteErrorHandledAt || "0", 10);
  if (handledAt && handledAt >= _lastInjectTime) return;

  errorContainer.dataset.lmSiteErrorHandledAt = String(Date.now());
  _siteErrorActive = true;

  log("detectSiteError: site error detected, notifying CLI and retrying in 5s");

  // показываем статус ошибки в CLI вместо обычного спиннера, не отдаём управление пользователю
  sendAiStatus("site_error");

  let retryBtn = null;
  for (const b of errorContainer.querySelectorAll("button")) {
    if (b.textContent.trim().startsWith("Retry")) {
      retryBtn = b;
      break;
    }
  }

  if (!retryBtn) {
    log("detectSiteError: Retry button not found, releasing lock");
    _siteErrorActive = false;
    return;
  }

  if (_siteErrorRetryTimer) clearTimeout(_siteErrorRetryTimer);
  _siteErrorRetryTimer = setTimeout(() => {
    _siteErrorRetryTimer = null;
    try {
      if (retryBtn.isConnected && !retryBtn.disabled) {
        log("detectSiteError: clicking Retry");
        // переводим CLI обратно в Sending до клика, чтобы пользователь увидел перезапуск
        sendAiStatus("sending");
        retryBtn.click();
      } else {
        log("detectSiteError: Retry button no longer available");
      }
    } catch (e) {
      log("detectSiteError: retry click failed: " + e);
    }
    _siteErrorActive = false;
  }, 5000);
}

function scanNewBlocks() {
  if (!isEnabled || !preset) {
    log(`scanNewBlocks: disabled=${!isEnabled} preset=${!!preset}`);
    return;
  }
  detectCaptcha();
  detectSiteError();
  detectAiStatus();
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
    if (!isEnabled) {
      log("INJECT ignored (disabled)");
      return;
    }
    log(`INJECT received: "${msg.text.substring(0, 40)}" preset=${!!preset}`);
    const mode = getSiteMode();
    if (mode !== null && mode !== "Direct") {
      log(`INJECT blocked: mode="${mode}", not Direct`);
      sendAiResponse("Выберите режим Direct в браузере для корректной работы", "__system_error__");
      return;
    }
    if (!preset || !preset.host) {
      log("INJECT blocked: no matching preset for this page");
      sendAiResponse("Пресет не загружен: откройте поддерживаемый сайт (arena.ai) в браузере", "__system_error__");
      return;
    }
    noteInjectForSiteError();
    if (preset && preset.inject) {
      log(`INJECT: calling preset.inject`);
      preset.inject(msg.text);
    } else {
      log("INJECT: no preset or inject method");
    }
    setTimeout(detectSiteError, 1500);
  }
  if (msg.type === "STOP_RETRY") {
    stopRetry();
  }
  if (msg.type === "NEW_CHAT") {
    if (!isEnabled || !preset || typeof preset.newChat !== "function") {
      log("NEW_CHAT ignored (disabled or preset doesn't support it)");
      try { chrome.runtime.sendMessage({ type: "NEW_CHAT_DONE", success: false }); } catch (e) {}
      return;
    }
    log("NEW_CHAT: executing");
    (async () => {
      try {
        const ok = await preset.newChat();
        chrome.runtime.sendMessage({ type: "NEW_CHAT_DONE", success: ok });
      } catch (e) {
        log("NEW_CHAT error: " + e);
        try { chrome.runtime.sendMessage({ type: "NEW_CHAT_DONE", success: false }); } catch (e2) {}
      }
    })();
  }
  if (msg.type === "MODEL_SEARCH") {
    if (!isEnabled || !preset || typeof preset.searchModels !== "function") {
      log("MODEL_SEARCH ignored (disabled or preset doesn't support it)");
      try { chrome.runtime.sendMessage({ type: "MODEL_SEARCH_RESULTS", models: [] }); } catch (e) {}
      return;
    }
    log("MODEL_SEARCH: query=" + msg.query);
    (async () => {
      try {
        const models = await preset.searchModels(msg.query || "");
        chrome.runtime.sendMessage({ type: "MODEL_SEARCH_RESULTS", models });
      } catch (e) {
        log("MODEL_SEARCH error: " + e);
        try { chrome.runtime.sendMessage({ type: "MODEL_SEARCH_RESULTS", models: [] }); } catch (e2) {}
      }
    })();
  }
  if (msg.type === "MODEL_SELECT") {
    if (!isEnabled || !preset || typeof preset.selectModelByIndex !== "function") {
      log("MODEL_SELECT ignored (disabled or preset doesn't support it)");
      try { chrome.runtime.sendMessage({ type: "MODEL_SELECT_DONE", success: false }); } catch (e) {}
      return;
    }
    log("MODEL_SELECT: query=" + msg.query + " index=" + msg.index);
    (async () => {
      try {
        const ok = await preset.selectModelByIndex(msg.query || "", msg.index || 0);
        chrome.runtime.sendMessage({ type: "MODEL_SELECT_DONE", success: ok });
      } catch (e) {
        log("MODEL_SELECT error: " + e);
        try { chrome.runtime.sendMessage({ type: "MODEL_SELECT_DONE", success: false }); } catch (e2) {}
      }
    })();
  }
});

log("content.js: ready, waiting for INJECT from background");
