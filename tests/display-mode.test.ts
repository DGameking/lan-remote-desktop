import { describe, it, expect } from 'vitest'
import { buildRdpContent, normalizeDisplayMode } from '../src/main/protocols/rdp'
import { buildVncDisplayArgs } from '../src/main/protocols/vnc'
import { isDisplayMode, validateConnectRequest, validateSettingsPatch } from '../src/main/ipc/validators'
import type { DisplayMode } from '../src/shared/types'

const RDP_BASE = { ip: '192.168.1.20', clipboard: true, driveRedirection: false }

describe('v1.8 显示模式 - normalizeDisplayMode 兼容归一', () => {
  it('合法 displayMode 原样返回', () => {
    const modes: DisplayMode[] = ['fit', 'native', 'fixed', 'fullscreen']
    for (const mode of modes) expect(normalizeDisplayMode(mode)).toBe(mode)
  })

  it('displayMode 优先于旧 screenMode', () => {
    expect(normalizeDisplayMode('native', 'fullscreen')).toBe('native')
  })

  it('旧 screenMode 兼容：fullscreen→fullscreen，adaptive/window→fit', () => {
    expect(normalizeDisplayMode(undefined, 'fullscreen')).toBe('fullscreen')
    expect(normalizeDisplayMode(undefined, 'adaptive')).toBe('fit')
    expect(normalizeDisplayMode(undefined, 'window')).toBe('fit')
  })

  it('都不传时默认 fit', () => {
    expect(normalizeDisplayMode(undefined)).toBe('fit')
  })
})

describe('v1.8 显示模式 - RDP .rdp 参数映射（依据微软官方属性）', () => {
  it('fit 自适应：窗口 + dynamic resolution=1，且不写 desktopwidth/height', () => {
    const content = buildRdpContent({ ...RDP_BASE, displayMode: 'fit' })
    expect(content).toContain('screen mode id:i:1')
    expect(content).toContain('dynamic resolution:i:1')
    expect(content).toContain('smart sizing:i:0')
    expect(content).not.toContain('desktopwidth:i:')
    expect(content).not.toContain('desktopheight:i:')
  })

  it('native 远程原生：窗口 + smart sizing=1 + dynamic resolution=0，不写死分辨率', () => {
    const content = buildRdpContent({ ...RDP_BASE, displayMode: 'native' })
    expect(content).toContain('screen mode id:i:1')
    expect(content).toContain('smart sizing:i:1')
    expect(content).toContain('dynamic resolution:i:0')
    expect(content).not.toContain('desktopwidth:i:')
  })

  it('fixed 固定分辨率：窗口 + 指定宽高 + dynamic resolution=0', () => {
    const content = buildRdpContent({ ...RDP_BASE, displayMode: 'fixed', width: 2560, height: 1440 })
    expect(content).toContain('screen mode id:i:1')
    expect(content).toContain('desktopwidth:i:2560')
    expect(content).toContain('desktopheight:i:1440')
    expect(content).toContain('dynamic resolution:i:0')
  })

  it('fullscreen 全屏：screen mode id=2 且不写死分辨率', () => {
    const content = buildRdpContent({ ...RDP_BASE, displayMode: 'fullscreen' })
    expect(content).toContain('screen mode id:i:2')
    expect(content).toContain('dynamic resolution:i:1')
    expect(content).not.toContain('desktopwidth:i:')
  })

  it('fixed 宽高越界时回落 1920×1080，不生成畸形参数', () => {
    const content = buildRdpContent({ ...RDP_BASE, displayMode: 'fixed', width: -1, height: 99999 })
    expect(content).toContain('desktopwidth:i:1920')
    expect(content).toContain('desktopheight:i:1080')
  })

  it('screen mode id 只出现 1 或 2，绝不再出现废弃的 3', () => {
    for (const mode of ['fit', 'native', 'fixed', 'fullscreen'] as DisplayMode[]) {
      const content = buildRdpContent({ ...RDP_BASE, displayMode: mode })
      expect(content).toMatch(/screen mode id:i:[12]/)
      expect(content).not.toContain('screen mode id:i:3')
    }
  })
})

describe('v1.8 显示模式 - VNC(TigerVNC) 参数映射（依据官方手册）', () => {
  it('fit：窗口最大化 -Maximize', () => {
    expect(buildVncDisplayArgs('fit', undefined, undefined, true)).toEqual(['-Maximize'])
  })

  it('native：不传任何尺寸参数（保持远程原生分辨率）', () => {
    expect(buildVncDisplayArgs('native', undefined, undefined, true)).toEqual([])
  })

  it('fixed：-DesktopSize=WxH', () => {
    expect(buildVncDisplayArgs('fixed', 2560, 1440, true)).toEqual(['-DesktopSize=2560x1440'])
  })

  it('fixed 宽高越界回落 1920x1080', () => {
    expect(buildVncDisplayArgs('fixed', -5, 99999, true)).toEqual(['-DesktopSize=1920x1080'])
  })

  it('fullscreen：-FullScreen + -FullScreenMode=current', () => {
    expect(buildVncDisplayArgs('fullscreen', undefined, undefined, true)).toEqual([
      '-FullScreen',
      '-FullScreenMode=current'
    ])
  })

  it('非 TigerVNC 一律返回空数组（保守降级，不臆造参数）', () => {
    for (const mode of ['fit', 'native', 'fixed', 'fullscreen'] as DisplayMode[]) {
      expect(buildVncDisplayArgs(mode, 1920, 1080, false)).toEqual([])
    }
  })
})

describe('v1.8 显示模式 - IPC 校验', () => {
  it('isDisplayMode 白名单', () => {
    expect(isDisplayMode('fit')).toBe(true)
    expect(isDisplayMode('native')).toBe(true)
    expect(isDisplayMode('fixed')).toBe(true)
    expect(isDisplayMode('fullscreen')).toBe(true)
    expect(isDisplayMode('adaptive')).toBe(false)
    expect(isDisplayMode('window')).toBe(false)
    expect(isDisplayMode(null)).toBe(false)
  })

  it('validateConnectRequest 接收合法 displayMode，丢弃非法值', () => {
    const base = { deviceId: 'd1', ip: '192.168.1.20', protocol: 'rdp' }
    expect((validateConnectRequest({ ...base, displayMode: 'fixed' }) as { displayMode?: string }).displayMode).toBe('fixed')
    expect((validateConnectRequest({ ...base, displayMode: 'bogus' }) as { displayMode?: string }).displayMode).toBeUndefined()
  })

  it('validateSettingsPatch 接收 displayMode', () => {
    const patch = validateSettingsPatch({ displayMode: 'native' }) as { displayMode?: string }
    expect(patch.displayMode).toBe('native')
    expect(() => validateSettingsPatch({ displayMode: 'bogus' })).not.toThrow()
  })
})
