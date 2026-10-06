const test = require('node:test');
const assert = require('node:assert/strict');
const { targetReason, collectTargets, parseReply, parsePrompts, validateReply, assessReplyNaturalness, formatReply, canAutoPublish, dayKey, delayMs } = require('../src/domain.js');

const valid = { handle: 'alice', postId: '1', text: 'x'.repeat(40), postUrl: 'https://x.com/alice/status/1' };

test('parseStatusHref handles relative, absolute and web status URLs', () => {
  assert.equal(require('../src/domain.js').parseStatusHref('https://x.com/alice/status/123').postId, '123');
  assert.equal(require('../src/domain.js').parseStatusHref('/i/web/status/123').postId, '123');
  assert.equal(require('../src/domain.js').parseStatusHref('/alice/status/123').handle, 'alice');
});
test('filters self, reposts, replies, short and duplicate posts', () => {
  const seen = new Set();
  assert.equal(targetReason(valid, { myHandle: 'bob', seen }), null);
  assert.equal(targetReason({ ...valid, handle: 'bob' }, { myHandle: 'bob' }), 'self');
  assert.equal(targetReason({ ...valid, repost: true }), 'repost');
  assert.equal(targetReason({ ...valid, reply: true }), 'reply');
  assert.equal(targetReason({ ...valid, text: 'short' }), 'short');
  assert.equal(targetReason(valid, { seen: new Set(['1']) }), 'duplicate');
});

test('collectTargets deduplicates and returns bounded queue records', () => {
  const out = collectTargets([valid, valid, { ...valid, postId: '2', handle: 'bob' }], { seen: new Set(), max: 1 });
  assert.equal(out.length, 1);
  assert.equal(out[0].status, 'queued');
});

test('author cooldown excludes recently replied authors but allows expired cooldowns', () => {
  const now = 10 * 60 * 60 * 1000;
  const recent = { ...valid, handle: 'alice', postId: 'recent' };
  const expired = { ...valid, handle: 'bob', postId: 'expired' };
  const authorLastSent = { alice: now - 2 * 60 * 60 * 1000, bob: now - 25 * 60 * 60 * 1000 };
  assert.equal(targetReason(recent, { authorLastSent, authorCooldownHours: 24, now }), 'author-cooldown');
  assert.equal(targetReason(expired, { authorLastSent, authorCooldownHours: 24, now }), null);
  assert.equal(collectTargets([recent, expired], { authorLastSent, authorCooldownHours: 24, now }).map((post) => post.handle).join(','), 'bob');
});

test('collectTargets queues at most one post per author when cooldown is enabled', () => {
  const posts = [
    { ...valid, handle: 'alice', postId: '1' },
    { ...valid, handle: 'alice', postId: '2' },
    { ...valid, handle: 'bob', postId: '3' },
  ];
  assert.deepEqual(collectTargets(posts, { authorCooldownHours: 24, now: 1000 }).map((post) => post.postId), ['1', '3']);
});

test('parseReply validates JSON, refusal and safety-only provider output', () => {
  assert.deepEqual(parseReply('{"reply":"hello","shouldReply":true}'), { reply: 'hello', shouldReply: true });
  assert.deepEqual(parseReply('{"reply":"no","shouldReply":false}'), { reply: '', shouldReply: false });
  assert.deepEqual(parseReply('User: hello there'), { reply: 'hello there', shouldReply: true });
  assert.deepEqual(parseReply('{"reply":"Assistant: useful point","shouldReply":true}'), { reply: 'useful point', shouldReply: true });
  assert.deepEqual(parseReply('user safety: safe'), { reply: '', shouldReply: false });
  assert.deepEqual(parseReply('Safety: blocked.'), { reply: '', shouldReply: false });
  assert.deepEqual(parseReply('Safety matters in this discussion.'), { reply: 'Safety matters in this discussion.', shouldReply: true });
});

test('parsePrompts splits variants and uses fallback', () => {
  assert.deepEqual(parsePrompts('one\n---\ntwo\n\nthree'), ['one', 'two', 'three']);
  assert.deepEqual(parsePrompts('', 'fallback'), ['fallback']);
});

test('validateReply rejects empty, multiline and oversized replies', () => {
  assert.deepEqual(validateReply(''), { ok: false, reason: 'empty' });
  assert.deepEqual(validateReply('one\ntwo'), { ok: false, reason: 'multiline' });
  assert.deepEqual(validateReply('one two three four', 3), { ok: false, reason: 'too-many-words' });
  assert.deepEqual(validateReply('one two', 3), { ok: true });
});

test('formatReply normalizes dashes and optionally lowercases', () => {
  assert.equal(formatReply('This is useful -- really useful.'), 'This is useful - really useful.');
  assert.equal(formatReply('sounds hyped--does grokbot actually handle'), 'sounds hyped - does grokbot actually handle');
  assert.equal(formatReply('sounds hyped‑does grokbot actually handle'), 'sounds hyped - does grokbot actually handle');
  assert.equal(formatReply('This Is Useful -- Really Useful.', { lowercase: true }), 'this is useful - really useful.');
  assert.equal(formatReply('hello world', { minorTypoChance: 100, random: () => 0 }), 'hlelo world');
});
test('assessReplyNaturalness flags strong AI-style templates but allows natural replies', () => {
  assert.deepEqual(assessReplyNaturalness('Great point! This is a crucial and insightful perspective.'), { ok: false, reasons: ['template-phrasing'] });
  assert.deepEqual(assessReplyNaturalness('What makes this work in practice?'), { ok: true, reasons: [] });
});
test('auto mode respects daily cap', () => {
  const day = dayKey();
  assert.deepEqual(canAutoPublish({ mode: 'auto', dailyCap: 2 }, { day, sentToday: 2 }), { ok: false, reason: 'daily-cap' });
  assert.deepEqual(canAutoPublish({ mode: 'draft' }, { day, sentToday: 0 }), { ok: false, reason: 'not-auto' });
});

test('delay is bounded and normalized', () => {
  assert.equal(delayMs(10, 20, 0), 10000);
  assert.equal(delayMs(10, 20, 1), 20000);
  assert.equal(delayMs(20, 10, 0.5), 20000);
});

test('engageActions likes and bookmarks by default and respects toggles', () => {
  const { engageActions, DEFAULTS } = require('../src/domain.js');
  assert.deepEqual(engageActions(DEFAULTS), ['like', 'bookmark']);
  assert.deepEqual(engageActions({}), ['like', 'bookmark']);
  assert.deepEqual(engageActions({ likePosts: false }), ['bookmark']);
  assert.deepEqual(engageActions({ bookmarkPosts: false }), ['like']);
  assert.deepEqual(engageActions({ likePosts: false, bookmarkPosts: false }), []);
});

test('isAdLabel recognizes X ad labels in English and Russian only as exact labels', () => {
  const { isAdLabel } = require('../src/domain.js');
  for (const label of ['Ad', 'ad', 'Promoted', 'Promoted by Acme', 'Реклама', 'Продвигается']) assert.equal(isAdLabel(label), true, label);
  for (const text of ['', 'Adam', 'This ad is everywhere', 'Реклама на билбордах', '2h']) assert.equal(isAdLabel(text), false, text);
});

test('isPromotedSignals flags ads by label or missing timestamp', () => {
  const { isPromotedSignals } = require('../src/domain.js');
  assert.equal(isPromotedSignals({ labels: ['Alice', '@alice', '2h'], hasTimestamp: true, hasStatusLink: true }), false);
  assert.equal(isPromotedSignals({ labels: ['Brand', '@brand', 'Ad'], hasTimestamp: true, hasStatusLink: true }), true);
  assert.equal(isPromotedSignals({ labels: ['Brand', '@brand'], hasTimestamp: false, hasStatusLink: true }), true);
  assert.equal(isPromotedSignals({ labels: [], hasTimestamp: false, placementTracking: true }), true);
});

test('promoted posts are never queued for like, bookmark or reply', () => {
  assert.equal(targetReason({ ...valid, promoted: true }), 'promoted');
  assert.deepEqual(collectTargets([{ ...valid, promoted: true }, { ...valid, postId: '2', handle: 'bob' }]).map((post) => post.postId), ['2']);
});

// ---- Replies to comments under your own posts ----
const comment = { handle: 'carol', postId: '50', text: 'how did you set this up?', afterFocal: true, replyTo: [] };

test('parseReplyingTo extracts handles from English and Russian labels', () => {
  const { parseReplyingTo } = require('../src/domain.js');
  assert.deepEqual(parseReplyingTo('Replying to @Me and @bob'), ['me', 'bob']);
  assert.deepEqual(parseReplyingTo('В ответ @me'), ['me']);
  assert.deepEqual(parseReplyingTo('just a post with @me'), []);
});

test('isDiscoverHeading recognizes the recommendations block below a conversation', () => {
  const { isDiscoverHeading } = require('../src/domain.js');
  assert.equal(isDiscoverHeading('Discover more Sourced from across X'), true);
  assert.equal(isDiscoverHeading('Откройте для себя больше'), true);
  assert.equal(isDiscoverHeading('Most relevant replies'), false);
});

test('commentTargetReason accepts comments under my post and rejects the rest', () => {
  const { commentTargetReason } = require('../src/domain.js');
  const conv = { context: 'conversation', ownerHandle: 'me', myHandle: '@Me' };
  assert.equal(commentTargetReason(comment, conv), null);
  assert.equal(commentTargetReason(comment, { ...conv, myHandle: '' }), 'no-handle');
  assert.equal(commentTargetReason(comment, { ...conv, ownerHandle: 'someone' }), 'not-my-post');
  assert.equal(commentTargetReason({ ...comment, handle: 'me' }, conv), 'self');
  assert.equal(commentTargetReason({ ...comment, afterFocal: false }, conv), 'above-post');
  assert.equal(commentTargetReason({ ...comment, discover: true }, conv), 'discover');
  assert.equal(commentTargetReason({ ...comment, promoted: true }, conv), 'promoted');
  assert.equal(commentTargetReason({ ...comment, answeredByMe: true }, conv), 'answered');
  assert.equal(commentTargetReason({ ...comment, replyTo: ['bob'] }, conv), 'not-reply-to-me');
  assert.equal(commentTargetReason({ ...comment, text: '' }, conv), 'short');
  assert.equal(commentTargetReason(comment, { ...conv, replied: { 50: 1 } }), 'replied');
});

test('on notifications only replies addressed to me are comment targets', () => {
  const { commentTargetReason } = require('../src/domain.js');
  const opts = { context: 'notifications', myHandle: 'me' };
  assert.equal(commentTargetReason({ ...comment, afterFocal: false, replyTo: ['me'] }, opts), null);
  assert.equal(commentTargetReason({ ...comment, afterFocal: false, replyTo: [] }, opts), 'not-reply-to-me');
});

test('collectCommentTargets dedupes, bounds and tags comments; replies to one author are allowed', () => {
  const { collectCommentTargets } = require('../src/domain.js');
  const opts = { context: 'conversation', ownerHandle: 'me', myHandle: 'me' };
  const posts = [comment, comment, { ...comment, postId: '51' }, { ...comment, postId: '52' }];
  const out = collectCommentTargets(posts, { ...opts, max: 2 });
  assert.deepEqual(out.map((p) => p.postId), ['50', '51']);
  assert.equal(out[0].kind, 'comment');
  assert.equal(collectCommentTargets(posts, { ...opts, max: 0 }).length, 0);
});

test('comments are liked but never bookmarked', () => {
  const { commentEngageActions, DEFAULTS } = require('../src/domain.js');
  assert.deepEqual(commentEngageActions(DEFAULTS), ['like']);
  assert.deepEqual(commentEngageActions({ likeComments: false, bookmarkPosts: true }), []);
});

test('comment replies have their own daily budget', () => {
  const { dailyBudget } = require('../src/domain.js');
  const day = dayKey();
  const config = { mode: 'auto', dailyCap: 20, batchSize: 5, commentDailyCap: 3, commentBatchSize: 10 };
  const state = { day, sentToday: 20, commentsRepliedToday: 1 };
  assert.deepEqual(dailyBudget(config, state, 'comment'), { cap: 3, used: 1, left: 2, limit: 2 });
  assert.equal(dailyBudget(config, state, 'post').limit, 0);
  assert.deepEqual(canAutoPublish(config, state, 'comment'), { ok: true });
  assert.deepEqual(canAutoPublish(config, { ...state, commentsRepliedToday: 3 }, 'comment'), { ok: false, reason: 'daily-cap' });
  assert.equal(dailyBudget(config, { day: '2000-01-01', commentsRepliedToday: 3 }, 'comment').left, 3);
});
