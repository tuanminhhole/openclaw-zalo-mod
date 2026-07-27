import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { matchesOwnerClaimDeviceId } from '../src/integration/owner-claim.js';

test('owner claim accepts the server Device ID case-insensitively', () => {
    assert.equal(matchesOwnerClaimDeviceId('a1b2c3d4e5f60718', 'A1B2C3D4E5F60718'), true);
});

test('owner claim rejects missing, malformed, or different Device IDs', () => {
    assert.equal(matchesOwnerClaimDeviceId('', 'A1B2C3D4E5F60718'), false);
    assert.equal(matchesOwnerClaimDeviceId('A1B2', 'A1B2C3D4E5F60718'), false);
    assert.equal(matchesOwnerClaimDeviceId('FFFFFFFFFFFFFFFF', 'A1B2C3D4E5F60718'), false);
});

// Regression: getBotConfig() used an undeclared `_detectedBotNames` map as a last-resort bot-name
// fallback. On a fresh install nothing has set a bot name yet, so that branch ran, threw a
// ReferenceError, and killed the whole before_dispatch hook — which is where owner claims are
// parsed. The bot therefore never answered "im owner <id>" and stayed ownerless, with only a
// single "before_dispatch handler from zalo-mod failed" line to show for it.
test('index.js has no undeclared identifier fallbacks in the before_dispatch path', async () => {
    const src = await readFile(new URL('../index.js', import.meta.url), 'utf8');
    assert.equal(src.includes('_detectedBotNames'), false, '_detectedBotNames is undeclared — it must not be referenced');
    // Every identifier the bot-name fallback still relies on has to be declared somewhere.
    for (const id of ['_detectedBotId']) {
        assert.match(src, new RegExp(`(?:let|const|var|function)\\s+${id}\\b`), `${id} must be declared`);
    }
});
