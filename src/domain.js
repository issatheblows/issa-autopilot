(() => {
  'use strict';

  const DEFAULTS = Object.freeze({
    mode: 'draft',
    myHandle: '',
    dailyCap: 20,
    batchSize: 5,
    minDelaySec: 45,
    maxDelaySec: 120,
    preSendMinSec: 3,
    preSendMaxSec: 8,
    authorCooldownHours: 24,
    minTextLength: 31,
    endpoint: 'https://openrouter.ai/api/v1',
    apiPath: '/chat/completions',
    apiKey: '',
    model: 'openrouter/free',
    prompt: 'Write a very short, natural reply that invites discussion. Add one light criticism, nuance, or a single genuine question when appropriate. Stay relevant, do not invent personal experience, do not flatter blindly, and do not use more than 12 words. Return JSON only: {"reply":"...","shouldReply":true}. Set shouldReply to false only when the post is clearly unsuitable for a reply.',
    prompts: '',
    normalizeDashes: true,
    lowercaseReplies: false,
    minorTypoChance: 5,
    likePosts: true,
    bookmarkPosts: true,
    likeComments: true,
    commentBatchSize: 10,
    commentDailyCap: 30,
    commentPrompt: 'You are the author of the original post. Someone left a comment under it. Write a very short, friendly, natural reply to that comment in the same language as the comment. Answer a question if there is one, otherwise agree, add a small nuance or thank them in your own words. Stay on topic, do not invent personal experience, no hashtags, no more than 15 words. Return JSON only: {"reply":"...","shouldReply":true}. Set shouldReply to false for spam, bots, insults or comments that need no answer.',
  });

  function normHandle(value) {
    return String(value || '').trim().replace(/^@/, '').toLowerCase();
  }

  function parseStatusHref(href) {
    const raw = String(href || '').trim();
    let path = raw;
    try { if (/^https?:\/\//i.test(raw)) path = new URL(raw).pathname; } catch (_) { return null; }
    const m = path.match(/^\/([A-Za-z0-9_]+)\/status\/(\d+)/);
    if (m) return { handle: normHandle(m[1]), postId: m[2], postUrl: `https://x.com/${m[1]}/status/${m[2]}` };
    const web = path.match(/^\/i\/web\/status\/(\d+)/);
    return web ? { handle: '', postId: web[1], postUrl: `https://x.com/i/web/status/${web[1]}` } : null;
  }

  // Labels X shows instead of (or next to) the timestamp on promoted posts.
  const AD_LABEL_RE = /^(?:ad|ads|promoted|promoted by .{1,60}|реклама|рекламный пост|продвигается|продвигаемый пост|спонсировано|sponsored)$/i;

  function isAdLabel(value) {
    return AD_LABEL_RE.test(String(value || '').replace(/\s+/g, ' ').trim());
  }

  // Pure decision from signals collected from a feed card (see content.js isPromotedCard).
  function isPromotedSignals(signals = {}) {
    if (signals.placementTracking && !signals.hasTimestamp) return true;
    if ((signals.labels || []).some(isAdLabel)) return true;
    return signals.hasStatusLink === true && signals.hasTimestamp === false;
  }

  function targetReason(post, options = {}) {
    if (!post || !post.postId || !post.handle) return 'meta';
    if (post.promoted) return 'promoted';
    if (post.repost) return 'repost';
    if (post.reply) return 'reply';
    if (options.myHandle && normHandle(post.handle) === normHandle(options.myHandle)) return 'self';
    if (String(post.text || '').trim().length < (options.minTextLength ?? DEFAULTS.minTextLength)) return 'short';
    if (options.replied?.[post.postId]) return 'replied';
    const lastSent = Number(options.authorLastSent?.[normHandle(post.handle)] || 0);
    const cooldownMs = Math.max(0, Number(options.authorCooldownHours) || 0) * 60 * 60 * 1000;
    const now = Number(options.now) || Date.now();
    if (lastSent > 0 && cooldownMs > 0 && now - lastSent < cooldownMs) return 'author-cooldown';
    if (options.seen?.has(post.postId)) return 'duplicate';
    if (options.blockedAuthors?.has(normHandle(post.handle))) return 'blocked-author';
    return null;
  }

  // "Replying to @a and @b" / "В ответ @a" -> ['a', 'b']
  const REPLYING_TO_RE = /(?:replying to|в ответ(?:\s+(?:на|пользователю|пользователям))?)\s*/i;
  function parseReplyingTo(value) {
    const text = String(value || '');
    const m = text.match(REPLYING_TO_RE);
    if (!m) return [];
    const tail = text.slice(m.index + m[0].length, m.index + m[0].length + 240);
    const out = [];
    for (const hit of tail.matchAll(/@([A-Za-z0-9_]{1,15})/g)) { const h = normHandle(hit[1]); if (!out.includes(h)) out.push(h); }
    return out;
  }

  // Heading X inserts below a conversation before unrelated recommended posts.
  function isDiscoverHeading(value) {
    return /discover more|more posts|sourced from across|откройте для себя|больше постов|ещё посты|другие посты|рекомендуем/i.test(String(value || ''));
  }

  // Comments under the user's own post: conversation page of their post, or replies addressed to them (notifications / mentions).
  function commentTargetReason(post, options = {}) {
    if (!post || !post.postId || !post.handle) return 'meta';
    if (post.promoted) return 'promoted';
    if (post.repost) return 'repost';
    const me = normHandle(options.myHandle);
    if (!me) return 'no-handle';
    if (normHandle(post.handle) === me) return 'self';
    if (post.discover) return 'discover';
    const replyTo = (post.replyTo || []).map(normHandle);
    if (options.context === 'conversation') {
      if (normHandle(options.ownerHandle) !== me) return 'not-my-post';
      if (!post.afterFocal) return 'above-post';
      if (replyTo.length && !replyTo.includes(me)) return 'not-reply-to-me';
    } else if (!replyTo.includes(me)) return 'not-reply-to-me';
    if (post.answeredByMe) return 'answered';
    if (String(post.text || '').trim().length < (options.minTextLength ?? 2)) return 'short';
    if (options.replied?.[post.postId]) return 'replied';
    if (options.seen?.has(post.postId)) return 'duplicate';
    return null;
  }

  function collectCommentTargets(posts, options = {}) {
    const seen = options.seen || new Set();
    const out = [];
    for (const post of posts || []) {
      if (options.max !== undefined && out.length >= options.max) break;
      if (commentTargetReason(post, { ...options, seen })) continue;
      seen.add(post.postId);
      out.push({ ...post, handle: normHandle(post.handle), text: String(post.text || '').slice(0, 1200), kind: 'comment', status: 'queued' });
    }
    return out;
  }

  function collectTargets(posts, options = {}) {
    const seen = options.seen || new Set();
    const blockedAuthors = new Set(options.blockedAuthors || []);
    const cooldownEnabled = Math.max(0, Number(options.authorCooldownHours) || 0) > 0;
    const out = [];
    for (const post of posts || []) {
      if (options.max && out.length >= options.max) break;
      if (targetReason(post, { ...options, seen, blockedAuthors })) continue;
      seen.add(post.postId);
      out.push({ ...post, handle: normHandle(post.handle), text: String(post.text || '').slice(0, 1200), status: 'queued' });
      if (cooldownEnabled) blockedAuthors.add(normHandle(post.handle));
    }
    return out;
  }

  function dayKey(date = new Date()) {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  }

  function delayMs(minSec, maxSec, random = Math.random()) {
    const lo = Math.max(1, Number(minSec) || 1);
    const hi = Math.max(lo, Number(maxSec) || lo);
    return Math.round((lo + Math.min(1, Math.max(0, random)) * (hi - lo)) * 1000);
  }

  function parsePrompts(value, fallback = '') {
    const items = String(value || '').split(/\n\s*---\s*\n|\n{2,}/).map((item) => item.trim()).filter(Boolean);
    return items.length ? items : [String(fallback || '').trim()].filter(Boolean);
  }

  function validateReply(value, maxWords = 20) {
    const reply = String(value || '').trim();
    if (!reply) return { ok: false, reason: 'empty' };
    if (/\r|\n/.test(reply)) return { ok: false, reason: 'multiline' };
    if (reply.split(/\s+/).length > Math.max(1, Number(maxWords) || 20)) return { ok: false, reason: 'too-many-words' };
    return { ok: true };
  }

  function assessReplyNaturalness(value) {
    const reply = String(value || '').trim();
    if (!reply) return { ok: true, reasons: [] };
    const templatePatterns = [/great point/i, /absolutely (right|correct)/i, /insightful perspective/i, /it(?:'s| is) (worth noting|important to note)/i, /crucial (and )?(insightful|important)/i, /not just .+ but also/i, /this is a game[- ]changer/i];
    return templatePatterns.some((pattern) => pattern.test(reply)) ? { ok: false, reasons: ['template-phrasing'] } : { ok: true, reasons: [] };
  }

  function formatReply(value, options = {}) {
    let reply = String(value || '').trim();
    if (options.normalizeDashes !== false) reply = reply.replace(/\s*--+\s*/g, ' - ').replace(/\s*[‐‑‒–—―−﹘﹣－]\s*/g, ' - ');
    if (options.lowercase === true) reply = reply.toLowerCase();
    if (Number(options.minorTypoChance) > 0 && (options.random || Math.random)() < Math.min(100, Number(options.minorTypoChance)) / 100) {
      const words = [...reply.matchAll(/\b[A-Za-zА-Яа-яЁё]{5,}\b/g)];
      if (words.length) { const word = words[Math.floor((options.random || Math.random)() * words.length)]; const start = word.index; const source = word[0]; const offset = Math.floor((options.random || Math.random)() * (source.length - 2)) + 1; reply = `${reply.slice(0, start + offset)}${source[offset + 1]}${source[offset]}${reply.slice(start + offset + 2)}`; }
    }
    return reply;
  }

  function stripRolePrefix(value) {
    return String(value || '').trim().replace(/^(?:user|assistant|system)\s*:\s*/i, '').trim();
  }

  function isSafetyOnlyResponse(value) {
    const text = String(value || '').trim();
    return /^(?:user\s+)?safety\s*:\s*(?:safe|unsafe|blocked|allowed|unknown)\s*[.!]?$/i.test(text);
  }

  function parseReply(raw) {
    const text = String(raw || '').trim();
    if (isSafetyOnlyResponse(text)) return { reply: '', shouldReply: false };
    const match = text.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        const value = JSON.parse(match[0]);
        if (value && value.shouldReply === false) return { reply: '', shouldReply: false };
        if (value && typeof value.reply === 'string') { const reply = stripRolePrefix(value.reply); return { reply, shouldReply: !!reply }; }
      } catch (_) {}
    }
    const reply = stripRolePrefix(text.replace(/^['"«]|['"»]$/g, '').trim());
    return { reply, shouldReply: !!reply };
  }

  function engageActions(config = {}) {
    const actions = [];
    if (config.likePosts !== false) actions.push('like');
    if (config.bookmarkPosts !== false) actions.push('bookmark');
    return actions;
  }

  // Comments under your own posts: like only, never bookmark.
  function commentEngageActions(config = {}) {
    return config.likeComments !== false ? ['like'] : [];
  }

  function dailyBudget(config = {}, state = {}, kind = 'post') {
    const comment = kind === 'comment';
    const cap = Math.max(1, Number(comment ? config.commentDailyCap : config.dailyCap) || (comment ? DEFAULTS.commentDailyCap : DEFAULTS.dailyCap));
    const used = !state || state.day !== dayKey() ? 0 : Number(comment ? state.commentsRepliedToday : state.sentToday) || 0;
    const batch = Math.max(1, Number(comment ? config.commentBatchSize : config.batchSize) || (comment ? DEFAULTS.commentBatchSize : DEFAULTS.batchSize));
    return { cap, used, left: Math.max(0, cap - used), limit: Math.min(batch, Math.max(0, cap - used)) };
  }

  function canAutoPublish(config, state, kind = 'post') {
    if (config.mode !== 'auto') return { ok: false, reason: 'not-auto' };
    if (!state || state.day !== dayKey()) return { ok: true };
    if (dailyBudget(config, state, kind).left <= 0) return { ok: false, reason: 'daily-cap' };
    return { ok: true };
  }

  const api = { DEFAULTS, normHandle, isAdLabel, isPromotedSignals, parseStatusHref, targetReason, collectTargets, dayKey, delayMs, parsePrompts, parseReply, isSafetyOnlyResponse, validateReply, assessReplyNaturalness, formatReply, engageActions, canAutoPublish, parseReplyingTo, isDiscoverHeading, commentTargetReason, collectCommentTargets, commentEngageActions, dailyBudget };
  if (typeof module !== 'undefined') module.exports = api;
  if (typeof window !== 'undefined') window.XAR = api;
  else if (typeof globalThis !== 'undefined') globalThis.XAR = api;
})();
