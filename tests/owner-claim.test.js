import test from 'node:test';
import assert from 'node:assert/strict';
import { matchesOwnerClaimDeviceId } from '../src/integration/owner-claim.js';

test('owner claim accepts the server Device ID case-insensitively', () => {
    assert.equal(matchesOwnerClaimDeviceId('a1b2c3d4e5f60718', 'A1B2C3D4E5F60718'), true);
});

test('owner claim rejects missing, malformed, or different Device IDs', () => {
    assert.equal(matchesOwnerClaimDeviceId('', 'A1B2C3D4E5F60718'), false);
    assert.equal(matchesOwnerClaimDeviceId('A1B2', 'A1B2C3D4E5F60718'), false);
    assert.equal(matchesOwnerClaimDeviceId('FFFFFFFFFFFFFFFF', 'A1B2C3D4E5F60718'), false);
});
