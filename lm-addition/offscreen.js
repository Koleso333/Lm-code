chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "COPY_TO_CLIPBOARD") {
    const text = msg.text;
    try {
      navigator.clipboard.writeText(text)
        .then(() => {
          console.log("[lm-addition] Copied via navigator.clipboard");
        })
        .catch(() => {
          fallbackCopy(text);
        });
    } catch (e) {
      fallbackCopy(text);
    }
  }
});

function fallbackCopy(text) {
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.style.position = "fixed";
  ta.style.left = "-9999px";
  ta.style.top = "0";
  document.body.appendChild(ta);
  ta.focus();
  ta.select();
  try {
    const ok = document.execCommand("copy");
    console.log("[lm-addition] Copied via execCommand:", ok);
  } catch (err) {
    console.error("[lm-addition] Copy error:", err);
  }
  document.body.removeChild(ta);
}
