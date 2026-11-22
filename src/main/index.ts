import path from 'node:path'
import { app, BrowserWindow, Menu, Tray, nativeImage } from 'electron'
import { ScanManager } from './discovery/manager'
import { registerIpc } from './ipc'
import { logger } from './logger'
import { SessionManager } from './session/manager'
import { initStore } from './store'

const devUrl = process.env.VITE_DEV_SERVER_URL
let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null
let quitting = false

// 项目 resources/ 为空且 electron-builder 未配 icon；用内嵌 16x16 PNG（深蓝显示器图形）
// 作为托盘图标，createFromDataURL 不依赖任何外部文件，托盘创建不会因缺文件失败。
// 后续补 resources/tray.ico 后可改为 nativeImage.createFromPath(path.join(...))。
const TRAY_ICON_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAANklEQVR4nGOQi5rznxLMMHgMeP3pD0kYqwEVq54RhUcNGNQGUJQO0DEuDUQnZbININbpVMtMADE5tWXDT2O0AAAAAElFTkSuQmCC'

// 进度回调在 registerIpc 中会重新绑定到真实窗口
const scanManager = new ScanManager(() => {})
const sessionManager = new SessionManager()

/** 唤出主窗口（托盘"回到主控"、second-instance、activate 共用） */
function showMainWindow(): void {
  if (!mainWindow) {
    createWindow()
    return
  }
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}

/** 创建系统托盘：回到主控 / 结束会话 / 退出。初始化失败时按无托盘模式运行。 */
function createTray(): void {
  if (tray) return
  try {
    tray = new Tray(nativeImage.createFromDataURL(TRAY_ICON_DATA_URL))
    tray.setToolTip('LanDesk - 局域网远程桌面')
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: '回到主控', click: () => showMainWindow() },
        { label: '结束会话', click: () => sessionManager.endSession() },
        { type: 'separator' },
        { label: '退出 LanDesk', click: () => app.quit() }
      ])
    )
    tray.on('double-click', () => showMainWindow())
    logger.info('系统托盘已就绪')
  } catch (error) {
    // 托盘不可用时窗口关闭走原有退出路径，保证功能不中断
    logger.warn('系统托盘初始化失败，窗口关闭将直接退出应用', error)
    tray = null
  }
}

/** 销毁托盘单例（app.quit 前调用），避免残留图标。 */
function destroyTray(): void {
  if (!tray) return
  try {
    tray.destroy()
  } catch {
    // 销毁失败静默忽略，进程退出时系统会回收
  }
  tray = null
}

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

  // v1.5-P0-2: 有托盘时点关闭仅隐藏窗口，退到托盘驻留；真正退出由托盘菜单控制。
  mainWindow.on('close', (event) => {
    if (tray && !quitting) {
      event.preventDefault()
      mainWindow?.hide()
    }
  })

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
  app.on('second-instance', () => showMainWindow())

  app.on('before-quit', () => {
    quitting = true
    // 退出前回收未结束的会话，避免历史长期停留在 connected
    sessionManager.endSession()
    destroyTray()
  })

  void app.whenReady().then(async () => {
    try {
      await initStore()
      Menu.setApplicationMenu(null)
      createTray()
      registerIpc(() => mainWindow, scanManager, sessionManager)
      // 会话调起成功后隐藏主窗口，退到托盘驻留
      sessionManager.setSessionLaunchedHandler(() => {
        mainWindow?.hide()
      })
      createWindow()
      logger.info('LanDesk 启动完成', { version: app.getVersion() })
    } catch (error) {
      logger.error('应用启动失败', error)
      app.quit()
    }
  })

  app.on('window-all-closed', () => {
    // 有托盘时由托盘菜单"退出"控制生命周期，不随窗口关闭退出
    if (tray) return
    if (process.platform !== 'darwin') app.quit()
  })

  app.on('activate', () => {
    showMainWindow()
  })
}
