import path from 'node:path'
import { app, BrowserWindow, Menu } from 'electron'
import { ScanManager } from './discovery/manager'
import { registerIpc } from './ipc'
import { logger } from './logger'
import { SessionManager } from './session/manager'
import { initStore } from './store'

const devUrl = process.env.VITE_DEV_SERVER_URL
let mainWindow: BrowserWindow | null = null

// 进度回调在 registerIpc 中会重新绑定到真实窗口
const scanManager = new ScanManager(() => {})
const sessionManager = new SessionManager()

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1240,
    height: 820,
    minWidth: 980,
    minHeight: 640,
    show: true,
    autoHideMenuBar: true,
    title: 'LanDesk - 局域网远程桌面',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  if (devUrl) {
    void mainWindow.loadURL(devUrl)
  } else {
    void mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'))
  }

  mainWindow.on('closed', () => {
    mainWindow = null
  })

  mainWindow.webContents.on('did-finish-load', () => {
    logger.info('主窗口已加载', { dev: !!devUrl })
  })
}

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })

  void app.whenReady().then(async () => {
    try {
      await initStore()
      Menu.setApplicationMenu(null)
      registerIpc(() => mainWindow, scanManager, sessionManager)
      createWindow()
      logger.info('LanDesk 启动完成', { version: app.getVersion() })
    } catch (error) {
      logger.error('应用启动失败', error)
      app.quit()
    }
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
}
