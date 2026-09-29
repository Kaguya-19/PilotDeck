import { describe, expect, it, vi } from 'vitest';
import { createNodeTerminalPtyPort } from './terminalPtyPort.js';

describe('createNodeTerminalPtyPort', () => {
    it('projects a terminal spawn request without taking terminal session ownership', () => {
        const pty = { pid: 42, kill: vi.fn() };
        const spawn = vi.fn(() => pty);
        const port = createNodeTerminalPtyPort({ spawn });
        const request = {
            shell: 'bash',
            args: ['-c', 'pilotdeck'],
            name: 'xterm-256color',
            cols: 120,
            rows: 40,
            cwd: '/workspace',
            env: { TERM: 'xterm-256color', COLORTERM: 'truecolor' },
        };

        expect(port.spawn(request)).toBe(pty);
        expect(spawn).toHaveBeenCalledWith('bash', ['-c', 'pilotdeck'], {
            name: 'xterm-256color',
            cols: 120,
            rows: 40,
            cwd: '/workspace',
            env: { TERM: 'xterm-256color', COLORTERM: 'truecolor' },
        });
    });

    it('rejects an incomplete Node PTY provider at composition time', () => {
        expect(() => createNodeTerminalPtyPort({})).toThrow(/node-pty\.spawn/);
    });
});
