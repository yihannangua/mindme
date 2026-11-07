export interface MapGroup {
  id: string
  name: string
  order: number
  collapsed: boolean
}

export interface MapGroupState {
  version: 1
  groups: MapGroup[]
  assignments: Record<string, string>
}

type StorageAccess = () => Pick<Storage, 'getItem' | 'setItem'>
const key = 'mindme.map-groups.v1'
const maxGroups = 100
const maxNameLength = 40
const cleanName = (value: string) => value.trim().replace(/\s+/g, ' ')
const nameKey = (value: string) => cleanName(value).normalize('NFC').toLocaleLowerCase()
const safeId = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(value)

const empty = (): MapGroupState => ({ version: 1, groups: [], assignments: {} })

const normalize = (value: unknown): MapGroupState => {
  if (!value || typeof value !== 'object') return empty()
  const data = value as Partial<MapGroupState>
  if (data.version !== 1 || !Array.isArray(data.groups)) return empty()
  const ids = new Set<string>(),
    names = new Set<string>(),
    groups: MapGroup[] = []
  for (const item of data.groups) {
    if (!item || typeof item !== 'object') continue
    const id = (item as MapGroup).id,
      name = cleanName(typeof (item as MapGroup).name === 'string' ? (item as MapGroup).name : '')
    if (
      !safeId(id) ||
      !name ||
      name.length > maxNameLength ||
      ids.has(id) ||
      names.has(nameKey(name))
    )
      continue
    ids.add(id)
    names.add(nameKey(name))
    groups.push({
      id,
      name,
      order: Number.isFinite((item as MapGroup).order) ? (item as MapGroup).order : groups.length,
      collapsed: (item as MapGroup).collapsed === true,
    })
    if (groups.length >= maxGroups) break
  }
  groups.sort((a, b) => a.order - b.order || a.name.localeCompare(b.name))
  const normalizedGroups = groups.map((group, index) => ({ ...group, order: index }))
  const assignments: Record<string, string> = {}
  if (data.assignments && typeof data.assignments === 'object' && !Array.isArray(data.assignments))
    for (const [mapId, groupId] of Object.entries(data.assignments))
      if (safeId(mapId) && ids.has(groupId)) assignments[mapId] = groupId
  return { version: 1, groups: normalizedGroups, assignments }
}

export class MapGroupStorage {
  private fallback = empty()
  private loaded = false
  constructor(private storage: StorageAccess = () => window.localStorage) {}

  load(): MapGroupState {
    if (this.loaded) return this.fallback
    this.loaded = true
    try {
      this.fallback = normalize(JSON.parse(this.storage().getItem(key) ?? 'null'))
      return this.fallback
    } catch {
      return this.fallback
    }
  }

  save(state: MapGroupState): MapGroupState {
    this.fallback = normalize(state)
    try {
      this.storage().setItem(key, JSON.stringify(this.fallback))
    } catch {
      // 本机存储不可用时仍保留本次页面内的分组。
    }
    return this.fallback
  }

  create(state: MapGroupState, input: string): MapGroupState {
    const name = cleanName(input)
    if (!name) throw new Error('分组名称不能为空')
    if (name.length > maxNameLength) throw new Error(`分组名称不能超过 ${maxNameLength} 个字符`)
    if (state.groups.some((group) => nameKey(group.name) === nameKey(name)))
      throw new Error('分组名称已存在')
    if (state.groups.length >= maxGroups) throw new Error(`最多支持 ${maxGroups} 个分组`)
    return {
      ...state,
      groups: [
        ...state.groups,
        {
          id: `group-${crypto.randomUUID()}`,
          name,
          order: state.groups.length,
          collapsed: false,
        },
      ],
    }
  }

  rename(state: MapGroupState, id: string, input: string): MapGroupState {
    const group = state.groups.find((item) => item.id === id)
    if (!group) throw new Error('分组不存在')
    const name = cleanName(input)
    if (!name) throw new Error('分组名称不能为空')
    if (name.length > maxNameLength) throw new Error(`分组名称不能超过 ${maxNameLength} 个字符`)
    if (state.groups.some((item) => item.id !== id && nameKey(item.name) === nameKey(name)))
      throw new Error('分组名称已存在')
    return {
      ...state,
      groups: state.groups.map((item) => (item.id === id ? { ...item, name } : item)),
    }
  }

  toggle(state: MapGroupState, id: string): MapGroupState {
    return {
      ...state,
      groups: state.groups.map((group) =>
        group.id === id ? { ...group, collapsed: !group.collapsed } : group,
      ),
    }
  }

  assign(state: MapGroupState, mapId: string, groupId: string | null): MapGroupState {
    const assignments = { ...state.assignments }
    if (!groupId || !state.groups.some((group) => group.id === groupId)) delete assignments[mapId]
    else assignments[mapId] = groupId
    return { ...state, assignments }
  }
}

export const mapGroupStorage = new MapGroupStorage()

export const groupIdForMap = (state: MapGroupState, mapId: string) =>
  state.groups.some((group) => group.id === state.assignments[mapId])
    ? state.assignments[mapId]
    : null
