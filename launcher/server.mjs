import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { SettingsStore } from './lib/settings.mjs';
import { LauncherProcesses } from './lib/processes.mjs';
import { createLauncherHttp, listenAvailable } from './lib/http.mjs';
import { existingInstance, instanceUrl, claimInstance, removeInstance, removeStaleInstance } from './lib/instance.mjs';

export function openBrowser(url) {
  const child = spawn('cmd.exe', ['/d', '/c', 'start', '""', url], { windowsHide: true });
  child.on('error', () => console.error('无法打开浏览器，请重新双击启动器。'));
}

export async function startLauncher({ repo = fileURLToPath(new URL('../../', import.meta.url)), browser = openBrowser } = {}) {
  const launcherDir = join(repo, 'companion', 'launcher');
  const instanceFile = join(launcherDir, '.instance.json');
  const existing = await existingInstance(instanceFile);
  if (existing) { browser(instanceUrl(existing)); return null; }
  removeStaleInstance(instanceFile);
  const store = new SettingsStore(join(launcherDir, 'settings.json'), repo);
  const manager = new LauncherProcesses(repo, store);
  const token = randomBytes(24).toString('base64url');
  let closing;
  const shutdown = () => closing ??= (async () => {
    await manager.stop();
    await new Promise(resolve => { server.close(resolve); server.closeIdleConnections(); });
    removeInstance(instanceFile);
    process.off('SIGINT', signalHandler);
    process.off('SIGBREAK', signalHandler);
    process.off('SIGTERM', signalHandler);
  })();
  const signalHandler = () => { shutdown().catch(() => { console.error('停止启动器失败，请检查进程。'); process.exitCode = 1; }); };
  const server = createLauncherHttp({ token, store, manager,
    uiFile: join(launcherDir, 'ui', 'index.html'), skinFile: join(repo, 'assets', 'skins', 'companion.png'), quit: shutdown });
  const port = await listenAvailable(server);
  try { claimInstance(instanceFile, { pid: process.pid, port, token }); }
  catch (error) {
    await new Promise(resolve => server.close(resolve));
    if (error.code !== 'EEXIST') throw error;
    const winner = await existingInstance(instanceFile);
    if (winner) browser(instanceUrl(winner));
    else throw new Error('另一个启动器正在启动，请稍后重试');
    return null;
  }
  process.on('SIGINT', signalHandler);
  process.on('SIGBREAK', signalHandler);
  process.on('SIGTERM', signalHandler);
  browser(instanceUrl({ port, token }));
  console.log(`Companion 启动器：http://127.0.0.1:${port}/`);
  return { server, manager, store, shutdown, port };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startLauncher().catch(() => { console.error('Companion 启动器启动失败，请检查文件权限或端口。'); process.exitCode = 1; });
}
