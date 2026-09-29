export function createSessionWatchRegistry() {
    /** @type {Map<string, Set<WebSocket>>} */
    const watchersBySession = new Map();
    /** @type {Map<WebSocket, Set<string>>} */
    const sessionsByClient = new Map();

    const watch = (sessionId, client) => {
        if (!sessionId || !client) return;
        let watchers = watchersBySession.get(sessionId);
        if (!watchers) {
            watchers = new Set();
            watchersBySession.set(sessionId, watchers);
        }
        watchers.add(client);

        let sessions = sessionsByClient.get(client);
        if (!sessions) {
            sessions = new Set();
            sessionsByClient.set(client, sessions);
        }
        sessions.add(sessionId);
    };

    const unwatch = (sessionId, client) => {
        if (!sessionId || !client) return;
        const watchers = watchersBySession.get(sessionId);
        if (watchers) {
            watchers.delete(client);
            if (watchers.size === 0) {
                watchersBySession.delete(sessionId);
            }
        }

        const sessions = sessionsByClient.get(client);
        if (sessions) {
            sessions.delete(sessionId);
            if (sessions.size === 0) {
                sessionsByClient.delete(client);
            }
        }
    };

    const removeClient = (client) => {
        const sessions = sessionsByClient.get(client);
        if (!sessions) return;
        for (const sessionId of sessions) {
            const watchers = watchersBySession.get(sessionId);
            if (!watchers) continue;
            watchers.delete(client);
            if (watchers.size === 0) {
                watchersBySession.delete(sessionId);
            }
        }
        sessionsByClient.delete(client);
    };

    const getWatchers = (sessionId) => watchersBySession.get(sessionId) || new Set();

    return {
        watch,
        unwatch,
        removeClient,
        getWatchers,
    };
}
