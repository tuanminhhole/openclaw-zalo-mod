import crypto from 'node:crypto';

const LEVEL = Object.freeze({ free: 0, pro: 1, team: 2 });

export function tierForPlan(plan) {
  const value = String(plan || '').toLowerCase();
  if (value === 'team' || value === 'lifetime') return 'team';
  if (value === 'personal' || value === 'pro' || value === 'trial') return 'pro';
  return 'free';
}

export function capabilitiesForPlan(plan, valid = false) {
  const tier = valid ? tierForPlan(plan) : 'free';
  return {
    tier,
    isPro: LEVEL[tier] >= LEVEL.pro,
    canBulk: LEVEL[tier] >= LEVEL.pro,
    canMultiBot: LEVEL[tier] >= LEVEL.team,
  };
}

export function verifySignedEntitlement(proof, publicKey, deviceId, nowSeconds = Math.floor(Date.now() / 1000)) {
  try {
    const [encoded, signature, extra] = String(proof || '').split('.');
    if (!encoded || !signature || extra) return { valid: false };
    const verifier = crypto.createVerify('sha256');
    verifier.update(encoded);
    if (!verifier.verify(publicKey, signature, 'base64url')) return { valid: false };
    const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    if (payload.iss !== 'zalo-mod-server' || payload.aud !== 'openclaw-zalo-mod') return { valid: false };
    if (String(payload.deviceId || '').toUpperCase() !== String(deviceId || '').toUpperCase()) return { valid: false };
    if (!Number.isFinite(Number(payload.exp)) || Number(payload.exp) <= nowSeconds) return { valid: false, expired: true };
    if (payload.licenseExpiry && new Date() > new Date(`${payload.licenseExpiry}T23:59:59Z`)) {
      return { valid: false, expired: true };
    }
    return { valid: true, payload };
  } catch {
    return { valid: false };
  }
}

function countValues(value) {
  if (Array.isArray(value)) return value.filter(Boolean).length;
  if (typeof value === 'string') return value.split(',').map((item) => item.trim()).filter(Boolean).length;
  return value ? 1 : 0;
}

export function requiredTierForAction(action, payload = {}, context = {}) {
  const profiles = countValues(payload.profiles || payload.profile);
  if (payload.profile === 'all' || profiles > 1) return 'team';
  if (action === 'sync-groups' && !payload.profile && Number(context.botCount || 0) > 1) return 'team';

  const targetCount = Math.max(
    countValues(payload.targets), countValues(payload.groupIds),
    countValues(payload.members), countValues(payload.userIds)
  );
  if (
    String(action).startsWith('bulk-') || action === 'send-messages' ||
    payload.all === true || targetCount > 1
  ) return 'pro';

  return 'free';
}

export function assertActionAllowed(action, payload, license, context = {}) {
  const required = requiredTierForAction(action, payload, context);
  const actual = license?.tier || capabilitiesForPlan(license?.plan, !!license?.isPro).tier;
  if (LEVEL[actual] < LEVEL[required]) {
    const error = new Error(required === 'team'
      ? 'Thao tác trên nhiều bot cùng lúc chỉ dành cho gói TEAM.'
      : 'Thao tác hàng loạt/nhiều group chỉ dành cho gói PRO hoặc TEAM.');
    error.code = required === 'team' ? 'TEAM_REQUIRED' : 'PRO_REQUIRED';
    throw error;
  }
  return true;
}
