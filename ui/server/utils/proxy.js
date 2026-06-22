/**
 * Pure-JS port of `src/cli/proxy.ts` — installs a global undici
 * proxy agent so Node native `fetch()` and `WebSocket` honor
 * `PILOTDECK_PROXY` / `HTTPS_PROXY` / `HTTP_PROXY`. Node's native
 * fetch does NOT respect those env vars by default; this closes the
 * gap.
 *
 * Uses `EnvHttpProxyAgent` instead of bare `ProxyAgent` so that
 * `NO_PROXY` / `no_proxy` is honored. `127.0.0.1` and `localhost`
 * are always excluded — the gateway WebSocket lives on loopback and
 * must never be routed through an external proxy.
 *
 * Living in `ui/server/utils/` lets the express bridge run from
 * source without depending on `dist/src/cli/proxy.js`.
 */
import { Agent, EnvHttpProxyAgent, setGlobalDispatcher } from 'undici';

export const UNDICI_TRANSPORT_TIMEOUT_MS = 600_000;

function getProxyUrl(env = process.env) {
    return (
        env.PILOTDECK_PROXY ||
        env.https_proxy ||
        env.HTTPS_PROXY ||
        env.http_proxy ||
        env.HTTP_PROXY
    );
}

let dispatcherState;

/**
 * Install a global undici dispatcher. Env proxy settings keep precedence over
 * the first config-based proxy install during startup.
 *
 * @param {string} [explicitUrl] Override the env-driven proxy URL.
 * @returns {string | undefined} The activated proxy URL.
 */
export function installGlobalProxy(explicitUrl, extraNoProxy) {
    const proxyUrl = explicitUrl ?? getProxyUrl();
    if (!proxyUrl) {
        applyDirectDispatcher();
        return undefined;
    }

    const source = explicitUrl ? 'config' : 'env';
    if (
        source === 'config'
        && dispatcherState?.mode === 'proxy'
        && dispatcherState.source === 'env'
    ) {
        return undefined;
    }

    if (
        dispatcherState?.mode === 'proxy'
        && dispatcherState.source === source
        && dispatcherState.proxyUrl === proxyUrl
    ) {
        return undefined;
    }

    return applyGlobalProxy(proxyUrl, source, extraNoProxy);
}

export function getGlobalProxyStateForTesting() {
    return dispatcherState ? { ...dispatcherState } : undefined;
}

export function reinstallGlobalProxy(proxyUrl, extraNoProxy) {
    if (!proxyUrl) {
        applyDirectDispatcher(true);
        return undefined;
    }
    return applyGlobalProxy(proxyUrl, 'config', extraNoProxy);
}

function applyDirectDispatcher(logRemoval = false) {
    try {
        setGlobalDispatcher(new Agent(createLongTimeoutOptions()));
        dispatcherState = { mode: 'direct' };
        if (logRemoval) {
            console.log('[proxy] Global fetch proxy removed');
        }
    } catch {
        // best effort
    }
}

function applyGlobalProxy(proxyUrl, source, extraNoProxy) {
    try {
        const noProxy = buildNoProxy(extraNoProxy);
        const agent = new EnvHttpProxyAgent({
            httpProxy: proxyUrl,
            httpsProxy: proxyUrl,
            noProxy,
            ...createLongTimeoutOptions(),
        });
        setGlobalDispatcher(agent);
        dispatcherState = { mode: 'proxy', source, proxyUrl, noProxy };
        console.log(`[proxy] Global fetch proxy → ${proxyUrl} (noProxy: ${noProxy})`);
        return proxyUrl;
    } catch (error) {
        console.warn(
            `[proxy] Failed to install global proxy (${proxyUrl}):`,
            error instanceof Error ? error.message : String(error),
        );
        return undefined;
    }
}

function createLongTimeoutOptions() {
    return {
        headersTimeout: UNDICI_TRANSPORT_TIMEOUT_MS,
        bodyTimeout: UNDICI_TRANSPORT_TIMEOUT_MS,
    };
}

function buildNoProxy(extraNoProxy) {
    const userNoProxy = process.env.no_proxy || process.env.NO_PROXY || '';
    return [userNoProxy, extraNoProxy, '127.0.0.1', 'localhost']
        .filter(Boolean)
        .join(',');
}
