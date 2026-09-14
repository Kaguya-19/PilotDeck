/**
 * Definition for the process substrate used by the interactive terminal.
 * Session identity, reconnect buffering and teardown remain with
 * TerminalSessionRegistry; this port owns only PTY creation.
 */

/**
 * @typedef {object} TerminalPtySpawnRequest
 * @property {string} shell
 * @property {string[]} args
 * @property {string} name
 * @property {number} cols
 * @property {number} rows
 * @property {string} cwd
 * @property {Record<string, string | undefined>} env
 */

/** @typedef {{ spawn(request: TerminalPtySpawnRequest): unknown }} TerminalPtyPort */

/**
 * Node `node-pty` provider for the terminal process substrate.
 *
 * @param {{ spawn?: (shell: string, args: string[], options: Record<string, unknown>) => unknown }} nodePty
 * @returns {TerminalPtyPort}
 */
export function createNodeTerminalPtyPort(nodePty) {
    if (!nodePty || typeof nodePty.spawn !== 'function') {
        throw new TypeError('Terminal PTY provider requires node-pty.spawn().');
    }

    return Object.freeze({
        spawn(request) {
            return nodePty.spawn(request.shell, request.args, {
                name: request.name,
                cols: request.cols,
                rows: request.rows,
                cwd: request.cwd,
                env: request.env,
            });
        },
    });
}
