const PRESETS = {
  arena: {
    host: /arena\.ai/,

    getCodeBlocks() {
      return document.querySelectorAll("pre.shiki-code-block");
    },

    _isAi(el) {
      return el.classList.contains("bg-surface-primary") && !el.querySelector(".bg-surface-raised");
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

      const down = new KeyboardEvent("keydown", {
        key: "Enter",
        code: "Enter",
        keyCode: 13,
        which: 13,
        bubbles: true,
        cancelable: true,
        shiftKey: false,
      });
      ta.dispatchEvent(down);

      const up = new KeyboardEvent("keyup", {
        key: "Enter",
        code: "Enter",
        keyCode: 13,
        which: 13,
        bubbles: true,
        cancelable: true,
        shiftKey: false,
      });
      ta.dispatchEvent(up);
    },

    highlightResponse() {
      for (const el of document.querySelectorAll(".bg-surface-primary")) {
        if (!this._isAi(el)) continue;
        const prose = el.querySelector(".prose");
        if (!prose || prose.dataset.lmResp === "done") continue;
        prose.dataset.lmResp = "done";
        wrapTextNodes(prose, "lm-highlight-response", ".shiki-code-block, [data-code-block]");
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
    inject() {},
    highlightResponse() {},
  },
};
