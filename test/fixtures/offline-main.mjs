import { startCompanion as start } from '../../src/main.js';
import { createPiManager } from '../../src/brain/manager.js';
export function startCompanion(options) {
  return start({ ...options, piManagerFactory: settings => createPiManager({ ...settings, hasAuth: () => false }) });
}
