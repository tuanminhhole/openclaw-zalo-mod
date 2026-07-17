/**
 * ConversationQueue — hàng đợi FIFO theo key (accountId + conversationId).
 *
 * - Các turn trong CÙNG một conversation chạy tuần tự, đúng thứ tự đến.
 * - Các conversation/account khác nhau chạy song song độc lập.
 * - Timeout chỉ fail turn đó; turn sau vẫn chạy (không deadlock cả hàng).
 */

export function conversationKey(accountId, conversationId) {
    return `${accountId}|${conversationId}`;
}

export class ConversationQueue {
    /**
     * @param {object} [opts]
     * @param {number} [opts.defaultTimeoutMs] timeout mặc định mỗi task (0 = không timeout)
     * @param {(err: Error, meta: object) => void} [opts.onError] báo lỗi task (đã được nuốt để không chặn queue)
     */
    constructor(opts = {}) {
        this._defaultTimeoutMs = opts.defaultTimeoutMs ?? 120_000;
        this._onError = opts.onError || (() => {});
        this._chains = new Map();  // key -> Promise đuôi chuỗi
        this._depth = new Map();   // key -> số task đang chờ + chạy
        this._oldestEnqueuedAt = new Map(); // key -> timestamp task cũ nhất trong hàng
    }

    /**
     * Xếp task vào hàng của key. Trả promise resolve/reject theo kết quả task.
     * Task bị timeout sẽ reject bằng ConversationQueueTimeoutError nhưng
     * KHÔNG chặn các task phía sau.
     *
     * @param {string} key conversationKey(accountId, conversationId)
     * @param {() => Promise<any>} taskFn
     * @param {object} [opts]
     * @param {number} [opts.timeoutMs]
     * @param {string} [opts.label] để log lỗi
     */
    enqueue(key, taskFn, opts = {}) {
        const timeoutMs = opts.timeoutMs ?? this._defaultTimeoutMs;
        const prev = this._chains.get(key) || Promise.resolve();
        this._depth.set(key, (this._depth.get(key) || 0) + 1);
        if (!this._oldestEnqueuedAt.has(key)) this._oldestEnqueuedAt.set(key, Date.now());

        const run = prev.then(() => this._runWithTimeout(taskFn, timeoutMs, opts.label || key));

        // Chuỗi đuôi phải luôn resolve để lỗi 1 task không giết cả hàng.
        const tail = run.catch((err) => {
            this._onError(err, { key, label: opts.label });
        }).finally(() => {
            const left = (this._depth.get(key) || 1) - 1;
            if (left <= 0) {
                this._depth.delete(key);
                this._oldestEnqueuedAt.delete(key);
                // Chỉ xoá chain khi chính nó là đuôi (không có task mới nối sau).
                if (this._chains.get(key) === tail) this._chains.delete(key);
            } else {
                this._depth.set(key, left);
            }
        });
        this._chains.set(key, tail);
        return run;
    }

    async _runWithTimeout(taskFn, timeoutMs, label) {
        if (!timeoutMs || timeoutMs <= 0) return taskFn();
        let timer;
        try {
            return await Promise.race([
                taskFn(),
                new Promise((_, reject) => {
                    timer = setTimeout(() => {
                        reject(new ConversationQueueTimeoutError(
                            `Turn timed out after ${timeoutMs}ms (${label})`));
                    }, timeoutMs);
                    if (timer.unref) timer.unref();
                }),
            ]);
        } finally {
            clearTimeout(timer);
        }
    }

    /** Số task đang chờ + chạy của một key. */
    depth(key) {
        return this._depth.get(key) || 0;
    }

    /** Tuổi (ms) của lô task hiện tại — cho health/observability. */
    age(key, now = Date.now()) {
        const t = this._oldestEnqueuedAt.get(key);
        return t ? now - t : 0;
    }

    /** Tổng quan mọi hàng đang hoạt động. */
    stats() {
        const out = {};
        for (const [key, depth] of this._depth) {
            out[key] = { depth, ageMs: this.age(key) };
        }
        return out;
    }
}

export class ConversationQueueTimeoutError extends Error {
    constructor(message) {
        super(message);
        this.name = 'ConversationQueueTimeoutError';
        this.code = 'QUEUE_TIMEOUT';
    }
}
