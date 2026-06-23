const WINDOWS_CMD_SHIMS = new Set([
  'claude',
  'npm',
  'npx',
  'task-master',
  'task-master-ai',
]);

function isWindows(platform = process.platform) {
  return platform === 'win32';
}

function hasWindowsExecutableExtension(command) {
  return /\.(?:cmd|exe|bat|com)$/i.test(command);
}

export function resolveWindowsCliCommand(command, platform = process.platform) {
  if (!isWindows(platform)) return command;

  const normalized = String(command).toLowerCase();
  if (normalized === 'which') return 'where.exe';
  if (WINDOWS_CMD_SHIMS.has(normalized) && !hasWindowsExecutableExtension(command)) {
    return `${command}.cmd`;
  }
  return command;
}

export function prepareCliSpawn(command, args = [], options = {}, platform = process.platform) {
  const windows = isWindows(platform);
  return {
    command: resolveWindowsCliCommand(command, platform),
    args,
    options: {
      ...options,
      shell: windows ? false : options.shell,
      windowsHide: windows ? true : options.windowsHide,
    },
  };
}

export function prepareBackgroundSpawnOptions(options = {}, platform = process.platform) {
  const windows = isWindows(platform);
  return {
    ...options,
    detached: windows ? false : options.detached,
    windowsHide: windows ? true : options.windowsHide,
  };
}

export function getOpenUrlSpawnCommand(url, platform = process.platform) {
  if (isWindows(platform)) {
    return { command: 'explorer.exe', args: [url] };
  }
  if (platform === 'darwin') {
    return { command: 'open', args: [url] };
  }
  return { command: 'xdg-open', args: [url] };
}
