const defaults = { enabled: true, strictness: "normal" };
const enabled = document.getElementById("enabled");
const strictness = document.getElementById("strictness");

chrome.storage.sync.get(defaults, (s) => {
  enabled.checked = s.enabled;
  strictness.value = s.strictness;
});
enabled.addEventListener("change", () => chrome.storage.sync.set({ enabled: enabled.checked }));
strictness.addEventListener("change", () => chrome.storage.sync.set({ strictness: strictness.value }));
