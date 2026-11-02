export interface SidebarVisibility {
  left: boolean
  right: boolean
}

type StorageAccess = () => Pick<Storage, 'getItem' | 'setItem'>
const key = 'mindme.sidebar.v1'

// 侧栏显示偏好只保存在当前浏览器，不进入脑图数据或同步队列。
export class SidebarStateStorage {
  constructor(private storage: StorageAccess = () => window.localStorage) {}

  load(): SidebarVisibility {
    const defaults = { left: true, right: true }
    try {
      const value = JSON.parse(this.storage().getItem(key) ?? 'null')
      if (!value || value.version !== 1) return defaults
      return {
        left: typeof value.left === 'boolean' ? value.left : defaults.left,
        right: typeof value.right === 'boolean' ? value.right : defaults.right,
      }
    } catch {
      return defaults
    }
  }

  save(visibility: SidebarVisibility) {
    try {
      this.storage().setItem(key, JSON.stringify({ version: 1, ...visibility }))
    } catch {
      // 存储不可用时，仍允许在当前页面切换侧栏。
    }
  }
}

export const sidebarState = new SidebarStateStorage()
