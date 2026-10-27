export type ShortcutPlatform = 'mac' | 'pc'
export type Shortcut = { key: string; action: string }

export const shortcutGroups = [
  {
    title: '创建与编辑',
    shortcuts: [
      { key: 'Tab', action: '新增子主题' },
      { key: 'Return', action: '新增同级主题（中心主题除外）' },
      { key: '⌘ Return', action: '新增父主题（中心主题除外）' },
      { key: '直接输入', action: '替换选中节点文字' },
      { key: '空格 / F2 / 双击', action: '编辑选中节点的原文字' },
      { key: 'Return / Esc', action: '确认 / 取消文字编辑' },
      { key: '⇧ Return', action: '编辑时在节点文字内换行' },
    ],
  },
  {
    title: '选择与导航',
    shortcuts: [
      { key: '↑ / ↓ / ← / →', action: '按方向选择可见节点' },
      { key: 'Shift + 单击', action: '选择同一父节点下的同级范围' },
      { key: '⌥ + 单击', action: '加入或移除节点选择' },
      { key: 'Esc', action: '未编辑时取消节点选择；拖动时取消拖动' },
    ],
  },
  {
    title: '结构整理',
    shortcuts: [
      { key: '⌘ /', action: '折叠 / 展开当前分支' },
      { key: '⌥ ⌘ /', action: '折叠 / 展开选中子树' },
      { key: '⌥ ↑ / ⌥ ↓', action: '逆时针 / 顺时针调整同级顺序' },
    ],
  },
  {
    title: '复制与撤销',
    shortcuts: [
      { key: 'Delete / Backspace', action: '删除全部所选分支及子分支（中心主题除外）' },
      { key: '⌘ C / ⌘ X / ⌘ V', action: '复制 / 剪切 / 粘贴全部所选分支' },
      { key: '⌘ Z / ⇧ ⌘ Z', action: '撤销 / 重做' },
      { key: '⌘ S', action: '立即保存到本机并尝试同步' },
    ],
  },
  {
    title: '画布与侧栏',
    shortcuts: [
      { key: '⌘ [', action: '展开 / 收起左侧脑图列表' },
      { key: '⌘ ]', action: '展开 / 收起右侧节点面板' },
      { key: '滚轮', action: '以鼠标位置缩放画布' },
      { key: '空白处按住左键拖动', action: '平移画布' },
    ],
  },
]

export function shortcutPlatform(): ShortcutPlatform {
  return /Mac|iPhone|iPad/.test(navigator.platform) ? 'mac' : 'pc'
}

export function shortcutKey(key: string, platform: ShortcutPlatform) {
  return platform === 'mac'
    ? key
    : key
        .replaceAll('⌘', 'Ctrl')
        .replaceAll('⌥', 'Alt')
        .replaceAll('⇧', 'Shift')
        .replaceAll('Return', 'Enter')
}
