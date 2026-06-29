import { execFile } from 'child_process';
import { createRequire } from 'module';
import path from 'path';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);

export function resolveBundledClawhubScript() {
  try {
    return require.resolve('clawhub/bin/clawdhub.js');
  } catch {
    try {
      return path.join(path.dirname(require.resolve('clawhub/package.json')), 'bin', 'clawdhub.js');
    } catch {
      return null;
    }
  }
}

export function buildClawhubInvocation(args, options = {}) {
  const bundledScript = Object.hasOwn(options, 'bundledScript')
    ? options.bundledScript
    : resolveBundledClawhubScript();
  if (bundledScript) {
    return {
      file: options.nodePath || process.execPath,
      args: [bundledScript, ...args],
      source: 'bundled',
    };
  }
  return { file: 'clawhub', args, source: 'path' };
}

export async function execClawhub(args, options = {}) {
  const invocation = buildClawhubInvocation(args);
  try {
    return await execFileAsync(invocation.file, invocation.args, options);
  } catch (error) {
    error.clawhubInvocation = invocation;
    error.clawhubNotFound = invocation.source === 'path' && error.code === 'ENOENT';
    throw error;
  }
}

export function isClawhubNotFoundError(error) {
  return Boolean(error?.clawhubNotFound || (error?.code === 'ENOENT' && error?.clawhubInvocation?.source === 'path'));
}
