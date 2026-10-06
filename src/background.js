importScripts('domain.js');
const DEFAULTS = { ...XAR.DEFAULTS };

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || !sender.id || sender.id !== chrome.runtime.id) return;
  if (message.type === 'GET_CONFIG') {
    chrome.storage.local.get({ config: DEFAULTS, emergencyStop: false }, (s) => { if (chrome.runtime.lastError) { sendResponse({ ok: false, reason: `storage.get: ${chrome.runtime.lastError.message}` }); return; } const config = { ...DEFAULTS, ...(s.config || {}) }; const { apiKey, ...safeConfig } = config; sendResponse({ ok: true, config: safeConfig, emergencyStop: !!s.emergencyStop }); });
    return true;
  }
  if (message.type === 'EMERGENCY_STOP') {
    chrome.storage.local.set({ emergencyStop: true }, () => sendResponse(chrome.runtime.lastError ? { ok: false, reason: `storage.set: ${chrome.runtime.lastError.message}` } : { ok: true }));
    return true;
  }
  if (message.type === 'GENERATE_REPLY') {
    chrome.storage.local.get({ config: DEFAULTS, emergencyStop: false }, async (s) => {
      if (chrome.runtime.lastError) return sendResponse({ ok: false, reason: `storage.get: ${chrome.runtime.lastError.message}` });
      if (s.emergencyStop) return sendResponse({ ok: false, reason: 'emergency-stop' });
      const config = { ...DEFAULTS, ...(s.config || {}) };
      const post = message.post || {};
      const isComment = post.kind === 'comment';
      const promptVariants = XAR.parsePrompts(config.prompts, config.prompt);
      const selectedPrompt = isComment ? String(config.commentPrompt || DEFAULTS.commentPrompt) : promptVariants.length ? promptVariants[Math.floor(Math.random() * promptVariants.length)] : config.prompt;
      const original = String(post.context || '').trim().slice(0, 1200);
      const userContent = isComment
        ? `${original ? `My original post:\n${original}\n\n` : ''}Comment by @${post.handle}:\n${post.text}`
        : `Post by @${post.handle}:\n${post.text}`;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 45000);
      try {
        const response = await fetch(String(config.endpoint).replace(/\/$/, '') + (config.apiPath || DEFAULTS.apiPath), {
          method: 'POST', signal: controller.signal, headers: { 'Content-Type': 'application/json', 'HTTP-Referer': 'https://x.com/', 'X-Title': 'issa', ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}) },
          body: JSON.stringify({ model: config.model, stream: false, messages: [{ role: 'system', content: selectedPrompt }, { role: 'user', content: userContent }] }),
        });
        if (!response.ok) return sendResponse({ ok: false, reason: `AI HTTP ${response.status}` });
        const data = await response.json();
        const content = data?.choices?.[0]?.message?.content;
        if (typeof content !== 'string' || !content.trim()) return sendResponse({ ok: false, reason: 'empty-ai-response' });
        sendResponse({ ok: true, content });
      } catch (error) {
        const message = String(error?.message || error);
        const reason = error?.name === 'AbortError'
          ? 'AI timeout after 45s'
          : /failed to fetch|networkerror|load failed|econnrefused/i.test(message)
          ? 'AI endpoint недоступен: проверьте адрес, API key и доступность OpenRouter'
          : message;
        sendResponse({ ok: false, reason });
      } finally { clearTimeout(timeout); }
    });
    return true;
  }
});
