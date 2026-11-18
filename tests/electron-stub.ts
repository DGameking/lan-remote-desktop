// 单元测试用的 electron mock：仅提供纯函数测试所需的最小 API 面。
// 真实运行时绝不会加载此文件（仅 vitest.config.ts 的 alias 指向它）。
const store = new Map<string, unknown>()

export const safeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (value: string) => Buffer.from(value, 'utf8'),
  decryptString: (value: Buffer) => value.toString('utf8')
}

export const app = {
  getPath: () => require('node:path').join(require('node:os').tmpdir(), 'landesk-test'),
  getAppPath: () => process.cwd(),
  getName: () => 'LanDesk',
  getVersion: () => '1.0.0',
  isPackaged: false,
  on: () => undefined,
  whenReady: () => Promise.resolve(),
  quit: () => undefined
}

export const ipcMain = { on: () => undefined, handle: () => undefined, removeHandler: () => undefined }
export const contextBridge = { exposeInMainWorld: () => undefined }
export const Tray = class { on() {} setContextMenu() {} setToolTip() {} destroy() {} }
export const Menu = { buildFromTemplate: () => ({}), setApplicationMenu: () => undefined }
export const BrowserWindow = class { static getAllWindows() { return [] } }
export const shell = { openExternal: () => Promise.resolve() }

export default { app, ipcMain, contextBridge, safeStorage, Tray, Menu, BrowserWindow, shell }
