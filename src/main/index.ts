import path from 'node:path'
import { app, BrowserWindow, Menu, Tray, nativeImage } from 'electron'
import { ScanManager } from './discovery/manager'
import { registerIpc, type IpcSchedulerHandle } from './ipc'
import { logger } from './logger'
import { SessionManager } from './session/manager'
import { initStore } from './store'
import { parseConnectArgv, parseDeepLinkUrl } from '../shared/deeplink'
import { IPC_CHANNELS, type DeepLinkRequest } from '../shared/types'

const devUrl = process.env.VITE_DEV_SERVER_URL
let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null
let quitting = false
// v1.7: 在线巡检与定时扫描定时器句柄，退出时统一释放，避免残留 interval 阻塞进程退出。
let schedulerHandle: IpcSchedulerHandle | null = null

// v1.7-D: 命令行 / landesk:// 链接解析出的预填参数。窗口未加载完时先缓存，
// 等 did-finish-load 再推送；渲染层收到后只填表，绝不自动发起连接。
let pendingDeepLinkRequest: DeepLinkRequest | null = null
let rendererReady = false

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

/** argv 中是否存在与本功能相关的参数（避免在正常启动时刷无效参数告警） */
function hasDeepLinkCandidate(argv: string[]): boolean {
  return argv.some(
    (arg) =>
      typeof arg === 'string' &&
      (/^landesk:/i.test(arg) || arg === '--connect' || arg.startsWith('--connect='))
  )
}

/**
 * 解析启动 / second-instance 传来的 argv。
 * Windows 下点击 landesk:// 链接会把 URL 作为普通参数传入，因此 URL 与 --connect 两种形态都支持。
 * 解析失败只写一条 warn 后忽略，绝不把参数拼进任何 shell 命令、也绝不自动连接。
 */
function handleDeepLinkArgv(argv: string[]): void {
  const linkArg = argv.find((arg) => typeof arg === 'string' && /^landesk:/i.test(arg))
  const request = linkArg ? parseDeepLinkUrl(linkArg) : parseConnectArgv(argv)
  if (!request) {
    if (hasDeepLinkCandidate(argv)) logger.warn('忽略无效的直连参数或 landesk 协议链接')
    return
  }
  pendingDeepLinkRequest = request
  flushPendingDeepLink()
}

/** 窗口已加载完成时把缓存的预填参数推送给渲染层；发送一次后即清空，避免重复预填。 */
function flushPendingDeepLink(): void {
  if (!rendererReady || !pendingDeepLinkRequest) return
  if (!mainWindow || mainWindow.isDestroyed()) return
  const request = pendingDeepLinkRequest
  pendingDeepLinkRequest = null
  mainWindow.webContents.send(IPC_CHANNELS.DEEPLINK_REQUEST, request)
  logger.info('已推送直连预填参数（需用户手动确认连接）', {
    ip: request.ip,
    protocol: request.protocol ?? '未指定'
  })
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
  rendererReady = false
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
    rendererReady = false
  })

  mainWindow.webContents.on('did-finish-load', () => {
    logger.info('主窗口已加载', { dev: !!devUrl })
    rendererReady = true
    flushPendingDeepLink()
  })
}

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', (_event, argv) => {
    showMainWindow()
    handleDeepLinkArgv(argv)
  })

  app.on('before-quit', () => {
    quitting = true
    // 退出前回收未结束的会话，避免历史长期停留在 connected
    sessionManager.endSession()
    // v1.7: 停掉在线巡检与定时扫描，防止定时器在退出流程中继续探测/落库。
    schedulerHandle?.disposeSchedulers()
    destroyTray()
  })

  void app.whenReady().then(async () => {
    try {
      await initStore()
      Menu.setApplicationMenu(null)
      createTray()
      schedulerHandle = registerIpc(() => mainWindow, scanManager, sessionManager)
      // 会话调起成功后隐藏主窗口，退到托盘驻留。
      // v1.7.1: 延迟 1.5 秒再隐藏——VNC viewer 等外部客户端的认证窗需要一点时间弹出，
      // 立即隐藏会让用户以为什么都没发生（"点了连接没弹窗口"）。延迟期间若用户又回到
      // 主控界面（focus），则取消隐藏，避免打断操作。
      sessionManager.setSessionLaunchedHandler(() => {
        const target = mainWindow
        if (!target) return
        setTimeout(() => {
          if (mainWindow === target && !target.isFocused()) target.hide()
        }, 1500)
      })
      createWindow()
      showMainWindow()
      handleDeepLinkArgv(process.argv)
      // v1.7-D: 注册 landesk:// 协议关联，使浏览器/脚本点击链接能唤起本应用。
      // 只写当前用户级关联（HKCU\Software\Classes），不需要管理员权限、不联网；
      // 仅打包版执行——开发模式注册会指向 electron.exe，属无效关联。
      // 失败只记日志不影响启动，命令行 --connect 参数路径始终可用。
      if (app.isPackaged) {
        try {
          const registered = app.setAsDefaultProtocolClient('landesk')
          logger.info('landesk:// 协议关联状态', { registered })
        } catch (error) {
          logger.warn('注册 landesk:// 协议关联失败，命令行 --connect 仍可用', error)
        }
      }
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
