import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  assertActionAllowed, capabilitiesForPlan, requiredTierForAction, verifySignedEntitlement,
} from '../src/licensing/entitlements.js';

test('capability hierarchy maps Free, Pro and Team correctly', () => {
  assert.deepEqual(capabilitiesForPlan('free', false), { tier: 'free', isPro: false, canBulk: false, canMultiBot: false });
  assert.deepEqual(capabilitiesForPlan('personal', true), { tier: 'pro', isPro: true, canBulk: true, canMultiBot: false });
  assert.deepEqual(capabilitiesForPlan('team', true), { tier: 'team', isPro: true, canBulk: true, canMultiBot: true });
});

test('single actions stay free while batches and all require Pro', () => {
  assert.equal(requiredTierForAction('remove-user', { groupId: 'g', userId: 'u' }), 'free');
  assert.equal(requiredTierForAction('review-pending', { groupId: 'g', members: ['u'] }), 'free');
  assert.equal(requiredTierForAction('review-pending', { groupId: 'g', members: ['u1', 'u2'] }), 'pro');
  assert.equal(requiredTierForAction('bulk-toggle-setting', { groupIds: ['g1', 'g2'] }), 'pro');
  assert.equal(requiredTierForAction('send-messages', { targets: [{}, {}] }), 'pro');
});

test('syncing multiple bots requires Team', () => {
  assert.equal(requiredTierForAction('sync-groups', {}, { botCount: 2 }), 'team');
  assert.equal(requiredTierForAction('sync-groups', { profile: 'default' }, { botCount: 2 }), 'free');
  assert.throws(() => assertActionAllowed('sync-groups', {}, { tier: 'pro' }, { botCount: 2 }), /TEAM/);
});

test('signed entitlement is bound to signature, device and expiry', () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const payload = {
    iss: 'zalo-mod-server', aud: 'openclaw-zalo-mod', deviceId: 'ABCDEF0123456789',
    plan: 'personal', exp: 2_000_000_000, licenseExpiry: '2030-01-01',
  };
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signer = crypto.createSign('sha256');
  signer.update(encoded);
  const proof = `${encoded}.${signer.sign(privateKey, 'base64url')}`;
  assert.equal(verifySignedEntitlement(proof, publicKey, payload.deviceId, 1_900_000_000).valid, true);
  assert.equal(verifySignedEntitlement(proof, publicKey, '0000000000000000', 1_900_000_000).valid, false);
  assert.equal(verifySignedEntitlement(`${encoded}.bad`, publicKey, payload.deviceId, 1_900_000_000).valid, false);
});
