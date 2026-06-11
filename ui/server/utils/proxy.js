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
import { EnvHttpProxyAgent, setGlobalDispatcher } from 'undici';

function getProxyUrl(env = process.env) {
    return (
        env.PILOTDECK_PROXY ||
        env.https_proxy ||
        env.HTTPS_PROXY ||
        env.http_proxy ||
        env.HTTP_PROXY
    );
}

let installed = false;

/**
 * Install a global undici EnvHttpProxyAgent. Safe to call multiple
 * times — only the first effective call wins. Returns the proxy URL
 * that was activated, or undefined if no proxy is configured.
 *
 * @param {string} [explicitUrl] Override the env-driven proxy URL.
 * @returns {string | undefined} The activated proxy URL.
 */
export function installGlobalProxy(explicitUrl) {
    if (installed) return undefined;
    const proxyUrl = explicitUrl ?? getProxyUrl();
    if (!proxyUrl) return undefined;
    try {
        const userNoProxy = process.env.no_proxy || process.env.NO_PROXY || '';
        const noProxy = [userNoProxy, '127.0.0.1', 'localhost']
            .filter(Boolean)
            .join(',');
        const agent = new EnvHttpProxyAgent({
            httpProxy: proxyUrl,
            httpsProxy: proxyUrl,
            noProxy,
        });
        setGlobalDispatcher(agent);
        installed = true;
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
