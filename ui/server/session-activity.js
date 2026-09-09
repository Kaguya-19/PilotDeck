/** Lightweight sidebar metadata; never broadcast chat content to unrelated views. */
export function createSessionActivityRegistry() {
    const users = new Map();
    let revision = 0;
    return {
        snapshot(userId) {
            return [...(users.get(userId)?.values() || [])];
        },
        receive(userId, frame) {
            const sessionId = frame?.sessionId;
            if (typeof sessionId !== 'string' || !sessionId) return null;
            const sessions = users.get(userId) || new Map();
            const previous = sessions.get(sessionId);
            let runId = frame.runId;
            let processing;
            let completedRunId = previous?.completedRunId;
            if (frame.kind === 'status' && frame.text === 'started') processing = true;
            else if (frame.kind === 'text' && frame.role === 'user') processing = true;
            else if (frame.kind === 'complete') {
                if (previous?.processing && runId && previous.runId && runId !== previous.runId) return null;
                processing = false;
                if (frame.finishReason === 'completed' && frame.success !== false) completedRunId = runId || frame.id;
            } else if (frame.kind === 'interrupted' || (frame.kind === 'error' && frame.terminal !== false)) {
                if (previous?.runId && runId && previous.runId !== runId) return null;
                processing = false;
            } else if (frame.type === 'input-queue-state') {
                const sending = frame.items?.find(item => ['submitting', 'dispatching'].includes(item.status));
                if (sending) { processing = true; runId = sending.runId || sending.id; }
                else if (frame.items?.some(item => ['failed', 'delivery_uncertain'].includes(item.status) && item.id === previous?.runId)) processing = false;
                else return null;
            } else return null;
            runId ||= previous?.runId;
            // Replayed start/user frames must not resurrect a completed turn.
            if (processing && previous && !previous.processing && runId === previous.runId) return null;
            if (previous && previous.processing === processing && previous.runId === runId && previous.completedRunId === completedRunId) return null;
            const activity = {sessionId, runId, processing, completedRunId, revision: ++revision};
            sessions.delete(sessionId);
            sessions.set(sessionId, activity);
            if (sessions.size > 2048) {
                // Never evict running tasks; terminal records are only reconnect hints.
                const oldest = [...sessions].find(([, item]) => !item.processing);
                if (oldest) sessions.delete(oldest[0]);
            }
            users.set(userId, sessions);
            return activity;
        },
    };
}
