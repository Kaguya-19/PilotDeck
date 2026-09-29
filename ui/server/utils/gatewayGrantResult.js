export function normalizeGatewayGrantResult(result) {
    if (!result || typeof result !== 'object' || result.granted !== true) {
        return { granted: false };
    }
    return typeof result.entry === 'string'
        ? { granted: true, entry: result.entry }
        : { granted: true };
}
