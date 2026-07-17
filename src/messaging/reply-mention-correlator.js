/**
 * Correlate an inbound ZaloConnect group message with the outbound reply payload.
 *
 * OpenClaw exposes the same runId/sessionKey to `message_received` and
 * `reply_payload_sending`. Keeping this tiny state machine separate avoids the
 * old "last sender wins" race when two people talk to the bot close together.
 */
export class ReplyMentionCorrelator {
    constructor({ ttlMs = 5 * 60_000, now = () => Date.now() } = {}) {
        this.ttlMs = ttlMs;
        this.now = now;
        this.byRunId = new Map();
        this.bySession = new Map();
    }

    capture(input = {}) {
        this.sweep();
        const senderId = String(input.senderId || '').trim();
        if (!senderId) return null;

        const record = {
            runId: String(input.runId || '').trim(),
            sessionKey: String(input.sessionKey || '').trim(),
            accountId: String(input.accountId || 'default'),
            conversationId: String(input.conversationId || ''),
            senderId,
            senderName: String(input.senderName || '').trim() || senderId,
            tagged: false,
            createdAt: this.now(),
        };

        if (record.runId) this.byRunId.set(record.runId, record);
        if (record.sessionKey) {
            const queue = this.bySession.get(record.sessionKey) || [];
            queue.push(record);
            this.bySession.set(record.sessionKey, queue);
        }
        return record;
    }

    updateName(record, senderName) {
        const name = String(senderName || '').trim();
        if (record && name) record.senderName = name;
    }

    decorate(event = {}, ctx = {}) {
        this.sweep();
        if (event.kind === 'tool') return null;
        if (event.payload?.isReasoning || event.payload?.isStatusNotice
            || event.payload?.isCompactionNotice || event.payload?.isFallbackNotice
            || event.payload?.ttsSupplement) return null;
        const text = typeof event.payload?.text === 'string' ? event.payload.text : '';
        if (!text.trim()) return null;

        const runId = String(event.runId || ctx.runId || '').trim();
        const sessionKey = String(event.sessionKey || ctx.sessionKey || '').trim();
        let record = runId ? this.byRunId.get(runId) : null;
        if (!record && sessionKey) {
            record = (this.bySession.get(sessionKey) || []).find((item) => !item.tagged) || null;
        }
        if (!record || record.tagged) return null;

        const name = record.senderName || record.senderId;
        const visible = `@${name}`;
        const wireMention = /\s/u.test(name) ? `@[${name}]` : visible;
        const alreadyMentioned = text.trimStart().startsWith(visible)
            || text.trimStart().startsWith(wireMention);
        record.tagged = true;

        // A final payload closes the turn. For streamed/block replies the record
        // remains only for cleanup; tagged=true prevents duplicate prefixes.
        if (event.kind === 'final') this.remove(record);

        return {
            record,
            text: alreadyMentioned ? text : `${wireMention} ${text}`,
            changed: !alreadyMentioned,
        };
    }

    remove(record) {
        if (!record) return;
        if (record.runId && this.byRunId.get(record.runId) === record) {
            this.byRunId.delete(record.runId);
        }
        if (record.sessionKey) {
            const next = (this.bySession.get(record.sessionKey) || []).filter((item) => item !== record);
            if (next.length) this.bySession.set(record.sessionKey, next);
            else this.bySession.delete(record.sessionKey);
        }
    }

    sweep() {
        const cutoff = this.now() - this.ttlMs;
        for (const record of this.byRunId.values()) {
            if (record.createdAt < cutoff) this.remove(record);
        }
        for (const queue of this.bySession.values()) {
            for (const record of [...queue]) {
                if (record.createdAt < cutoff) this.remove(record);
            }
        }
    }
}
