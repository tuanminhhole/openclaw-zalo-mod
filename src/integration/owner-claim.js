import crypto from 'node:crypto';

/** Verify the first owner claim against the server-side Zalo Mod Device ID. */
export function matchesOwnerClaimDeviceId(supplied, expected) {
    const actual = String(supplied || '').trim().toUpperCase();
    const wanted = String(expected || '').trim().toUpperCase();
    if (!/^[0-9A-F]{16}$/.test(actual) || !/^[0-9A-F]{16}$/.test(wanted)) return false;
    const a = Buffer.from(actual);
    const b = Buffer.from(wanted);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
}
