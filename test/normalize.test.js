import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeUser,
  normalizeGift,
  normalizeChat,
  normalizeLike,
  normalizeSocial,
  normalizeMember,
  normalizeRoomUser,
  toProxyUrl,
  pickImageUrl,
  avatarDataUri,
  initials,
  StreakTracker,
} from '../server/normalize.js';

const AVATAR = 'https://p16-sign.tiktokcdn.com/u/avatar~c5_100x100.webp?x=1&y=2';
const GIFT_IMG = 'https://p19-webcast.tiktokcdn.com/img/rose.png~tplv-obj.image';

/** A v3 user as decoded by tiktok-live-proto. */
const v3User = {
  id: '7001234567890',
  nickname: 'Maria Silva',
  displayId: 'maria.silva',
  avatarThumb: { urlList: [AVATAR, 'https://p16.tiktokcdn.com/other.webp'], uri: 'x' },
  avatarMedium: { urlList: ['https://p16.tiktokcdn.com/medium.webp'] },
};

/** A v3 gift message with the embedded gift struct + extendedGiftInfo (webcast JSON). */
const v3Gift = {
  giftId: '5655',
  repeatCount: 3,
  repeatEnd: 0,
  groupId: '1720000000',
  user: v3User,
  gift: { id: '5655', name: 'Rose', type: 1, diamondCount: 1, image: { urlList: [GIFT_IMG] } },
  extendedGiftInfo: { id: 5655, name: 'Rose', diamond_count: 1, image: { url_list: ['https://p19.tiktokcdn.com/ext.png'] } },
};

describe('helpers', () => {
  test('pickImageUrl handles every shape', () => {
    assert.equal(pickImageUrl({ urlList: [AVATAR] }), AVATAR);
    assert.equal(pickImageUrl({ url_list: [AVATAR] }), AVATAR);
    assert.equal(pickImageUrl({ urls: ['', AVATAR] }), AVATAR);
    assert.equal(pickImageUrl(AVATAR), AVATAR);
    assert.equal(pickImageUrl('not a url'), null);
    assert.equal(pickImageUrl(null), null);
    assert.equal(pickImageUrl({ urlList: [] }), null);
  });

  test('toProxyUrl proxies http(s), keeps data: URIs, rejects junk', () => {
    assert.equal(toProxyUrl(AVATAR), '/img?u=' + encodeURIComponent(AVATAR));
    assert.equal(toProxyUrl('data:image/svg+xml;utf8,abc'), 'data:image/svg+xml;utf8,abc');
    assert.equal(toProxyUrl('/img?u=x'), '/img?u=x');
    assert.equal(toProxyUrl('javascript:alert(1)'), null);
    assert.equal(toProxyUrl(''), null);
    assert.equal(toProxyUrl(undefined), null);
  });

  test('avatarDataUri is a deterministic SVG data URI with initials', () => {
    const a = avatarDataUri('Maria Silva', 'maria');
    assert.ok(a.startsWith('data:image/svg+xml;utf8,'));
    assert.ok(decodeURIComponent(a).includes('>MS<'));
    assert.equal(a, avatarDataUri('Maria Silva', 'maria'));
    assert.equal(initials('joão'), 'J');
    assert.equal(initials(''), '?');
    assert.ok(!decodeURIComponent(avatarDataUri('<b>x')).includes('<b>'));
  });
});

describe('normalizeUser', () => {
  test('v3 shape → UserRef with proxied avatar', () => {
    const u = normalizeUser(v3User);
    assert.deepEqual(u, {
      userId: '7001234567890',
      uniqueId: 'maria.silva',
      nickname: 'Maria Silva',
      avatarUrl: '/img?u=' + encodeURIComponent(AVATAR),
    });
  });

  test('legacy shape (uniqueId, profilePicture.urls)', () => {
    const u = normalizeUser({ userId: '42', uniqueId: 'legacy_user', nickname: 'Legacy', profilePicture: { urls: [AVATAR] } });
    assert.equal(u.userId, '42');
    assert.equal(u.uniqueId, 'legacy_user');
    assert.equal(u.avatarUrl, '/img?u=' + encodeURIComponent(AVATAR));
    const u2 = normalizeUser({ userId: '43', uniqueId: 'x', profilePictureUrl: AVATAR });
    assert.equal(u2.avatarUrl, '/img?u=' + encodeURIComponent(AVATAR));
    assert.equal(u2.nickname, 'x'); // nickname falls back to uniqueId
  });

  test('keeps data: avatars (sim users) and survives missing data', () => {
    const data = 'data:image/svg+xml;utf8,%3Csvg%3E';
    assert.equal(normalizeUser({ id: 'sim:a', displayId: 'a', nickname: 'A', avatarUrl: data }).avatarUrl, data);
    const u = normalizeUser(undefined);
    assert.equal(u.uniqueId, 'anonimo');
    assert.equal(u.avatarUrl, null);
    assert.ok(u.userId.length > 0);
  });
});

describe('normalizeGift', () => {
  test('v3 gift struct is preferred; image proxied; repeatEnd coerced to boolean', () => {
    const g = normalizeGift(v3Gift);
    assert.equal(g.giftId, '5655');
    assert.equal(g.giftName, 'Rose');
    assert.equal(g.diamondCount, 1);
    assert.equal(g.giftType, 1);
    assert.equal(g.repeatCount, 3);
    assert.equal(g.repeatEnd, false);
    assert.equal(g.groupId, '1720000000');
    assert.equal(g.giftImageUrl, '/img?u=' + encodeURIComponent(GIFT_IMG));
    assert.equal(g.user.uniqueId, 'maria.silva');
  });

  test('falls back to extendedGiftInfo (snake_case) when gift struct is missing', () => {
    const g = normalizeGift({ giftId: '5655', repeatCount: 1, repeatEnd: 1, user: v3User, extendedGiftInfo: { id: 5655, name: 'Rose', diamond_count: 1, type: 1, image: { url_list: [GIFT_IMG] } } });
    assert.equal(g.giftName, 'Rose');
    assert.equal(g.diamondCount, 1);
    assert.equal(g.giftType, 1);
    assert.equal(g.repeatEnd, true);
    assert.equal(g.giftImageUrl, '/img?u=' + encodeURIComponent(GIFT_IMG));
  });

  test('legacy giftDetails shape', () => {
    const g = normalizeGift({
      giftId: 5655,
      repeatCount: 2,
      repeatEnd: true,
      user: { userId: '1', uniqueId: 'legacy', nickname: 'Legacy' },
      giftDetails: { giftName: 'Rose', diamondCount: 1, giftType: 1, giftImage: { giftPictureUrl: GIFT_IMG } },
    });
    assert.equal(g.giftId, '5655');
    assert.equal(g.giftName, 'Rose');
    assert.equal(g.giftType, 1);
    assert.equal(g.repeatEnd, true);
    assert.equal(g.giftImageUrl, '/img?u=' + encodeURIComponent(GIFT_IMG));
  });

  test('unknown gift gets a placeholder name, null type and no image', () => {
    const g = normalizeGift({ giftId: '77', user: v3User });
    assert.equal(g.giftName, 'Presente #77');
    assert.equal(g.giftType, null);
    assert.equal(g.giftImageUrl, null);
    assert.equal(g.repeatCount, 1);
    assert.equal(normalizeGift(null).giftId, 'unknown');
  });
});

describe('chat / like / social / roomUser', () => {
  test('chat v3 (content) and legacy (comment)', () => {
    assert.equal(normalizeChat({ user: v3User, content: 'oi!' }).text, 'oi!');
    assert.equal(normalizeChat({ user: v3User, comment: 'legacy' }).text, 'legacy');
    assert.equal(normalizeChat({}).text, '');
    assert.equal(normalizeChat({ content: 'x'.repeat(500) }).text.length, 300);
  });

  test('like v3 (count/total) and legacy (likeCount/totalLikeCount)', () => {
    const a = normalizeLike({ user: v3User, count: 15, total: '1200' });
    assert.equal(a.count, 15);
    assert.equal(a.total, 1200);
    const b = normalizeLike({ user: v3User, likeCount: 3, totalLikeCount: 9 });
    assert.equal(b.count, 3);
    assert.equal(b.total, 9);
    assert.equal(normalizeLike({}).count, 1);
  });

  test('social / member reduce to { user }', () => {
    assert.equal(normalizeSocial({ user: v3User, action: '1' }).user.nickname, 'Maria Silva');
    assert.equal(normalizeMember({ user: v3User }).user.uniqueId, 'maria.silva');
  });

  test('roomUser v3 (total string) and legacy (viewerCount)', () => {
    assert.deepEqual(normalizeRoomUser({ total: '345', ranks: [] }), { count: 345 });
    assert.deepEqual(normalizeRoomUser({ viewerCount: 12 }), { count: 12 });
    assert.deepEqual(normalizeRoomUser(null), { count: 0 });
  });
});

describe('StreakTracker', () => {
  const mk = (over = {}) => normalizeGift({ ...v3Gift, ...over });

  test('streak gifts (giftType 1) deliver only the delta and close on repeatEnd', () => {
    const t = new StreakTracker();
    assert.deepEqual(t.apply(mk({ repeatCount: 1 })), { count: 1, repeatCount: 1, streakEnd: false });
    assert.deepEqual(t.apply(mk({ repeatCount: 2 })), { count: 1, repeatCount: 2, streakEnd: false });
    assert.deepEqual(t.apply(mk({ repeatCount: 3 })), { count: 1, repeatCount: 3, streakEnd: false });
    assert.equal(t.size, 1);
    // Final message repeats the total with repeatEnd → 0 new units, key removed.
    assert.deepEqual(t.apply(mk({ repeatCount: 3, repeatEnd: 1 })), { count: 0, repeatCount: 3, streakEnd: true });
    assert.equal(t.size, 0);
  });

  test('missed intermediate events are recovered from the running total', () => {
    const t = new StreakTracker();
    t.apply(mk({ repeatCount: 2 }));
    assert.equal(t.apply(mk({ repeatCount: 10 })).count, 8);
    assert.equal(t.apply(mk({ repeatCount: 12, repeatEnd: 1 })).count, 2);
    assert.equal(t.size, 0);
  });

  test('duplicate / out-of-order counts never go negative', () => {
    const t = new StreakTracker();
    t.apply(mk({ repeatCount: 5 }));
    assert.equal(t.apply(mk({ repeatCount: 5 })).count, 0);
    assert.equal(t.apply(mk({ repeatCount: 4 })).count, 0);
  });

  test('a streak of 10 roses yields exactly 10 units in total', () => {
    const t = new StreakTracker();
    let total = 0;
    for (let i = 1; i <= 10; i++) total += t.apply(mk({ repeatCount: i })).count;
    total += t.apply(mk({ repeatCount: 10, repeatEnd: 1 })).count;
    assert.equal(total, 10);
  });

  test('non-streak gifts (giftType ≠ 1) count max(1, repeatCount) and end immediately', () => {
    const t = new StreakTracker();
    const lion = mk({ giftId: '7', gift: { id: '7', name: 'Lion', type: 0, diamondCount: 29999 }, repeatCount: 1, repeatEnd: 0 });
    assert.deepEqual(t.apply(lion), { count: 1, repeatCount: 1, streakEnd: true });
    const five = mk({ giftId: '7', gift: { id: '7', name: 'Lion', type: 2, diamondCount: 29999 }, repeatCount: 5 });
    assert.deepEqual(t.apply(five), { count: 5, repeatCount: 5, streakEnd: true });
    assert.equal(t.size, 0);
  });

  test('keys are per user + gift + group', () => {
    const t = new StreakTracker();
    t.apply(mk({ repeatCount: 3 }));
    assert.equal(t.apply(mk({ repeatCount: 1, groupId: 'other' })).count, 1);
    assert.equal(t.apply(mk({ repeatCount: 1, user: { ...v3User, id: '999' } })).count, 1);
    assert.equal(t.size, 3);
  });

  test('unknown giftType is tracked like a streak (never double counts)', () => {
    const t = new StreakTracker();
    const g1 = normalizeGift({ giftId: '77', repeatCount: 1, user: v3User });
    const g2 = normalizeGift({ giftId: '77', repeatCount: 2, user: v3User });
    assert.equal(t.apply(g1).count, 1);
    assert.equal(t.apply(g2).count, 1);
  });

  test('keys expire after 60 s of inactivity', () => {
    let now = 1_000_000;
    const t = new StreakTracker({ now: () => now });
    t.apply(mk({ repeatCount: 4 }));
    now += 30_000;
    assert.equal(t.apply(mk({ repeatCount: 5 })).count, 1);
    now += 61_000;
    // Key expired → the running total restarts from zero.
    assert.equal(t.apply(mk({ repeatCount: 2 })).count, 2);
    assert.equal(t.size, 1);
    t.clear();
    assert.equal(t.size, 0);
  });
});
