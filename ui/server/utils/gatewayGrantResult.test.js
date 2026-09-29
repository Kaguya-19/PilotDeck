import { describe, expect, it } from 'vitest';
import { normalizeGatewayGrantResult } from './gatewayGrantResult.js';

describe('normalizeGatewayGrantResult', () => {
    it('preserves successful structured grant results', () => {
        expect(normalizeGatewayGrantResult({ granted: true, entry: 'tool-a' })).toEqual({
            granted: true,
            entry: 'tool-a',
        });
    });

    it('returns a denied structure for invalid grant results', () => {
        expect(normalizeGatewayGrantResult(null)).toEqual({ granted: false });
        expect(normalizeGatewayGrantResult({ granted: false, entry: 'tool-a' })).toEqual({ granted: false });
    });
});
