import { useEffect, useRef, useState } from 'react'
import { Search, X } from 'lucide-react'
import { Dialog } from '../components/Dialog'
import { helpArticles, type HelpIllustration } from './help-content'
import { shortcutGroups, shortcutKey, shortcutPlatform, type ShortcutPlatform } from './Shortcuts'

const matches = (text: string, query: string) =>
  query
    .trim()
    .toLocaleLowerCase()
    .split(/\s+/)
    .every((word) => text.toLocaleLowerCase().includes(word))

function ShortcutGuide() {
  const [platform, setPlatform] = useState<ShortcutPlatform>(shortcutPlatform)
  const [query, setQuery] = useState('')
  const groups = shortcutGroups
    .map((group) => ({
      ...group,
      shortcuts: group.shortcuts.filter(({ key, action }) =>
        matches(`${group.title} ${key} ${shortcutKey(key, platform)} ${action}`, query),
      ),
    }))
    .filter((group) => group.shortcuts.length)
  return (
    <section aria-label="完整快捷键表">
      <div className="help-shortcut-controls">
        <div className="segmented" role="group" aria-label="快捷键系统">
          <button
            aria-pressed={platform === 'mac'}
            className={platform === 'mac' ? 'active' : ''}
            onClick={() => setPlatform('mac')}
          >
            macOS
          </button>
          <button
            aria-pressed={platform === 'pc'}
            className={platform === 'pc' ? 'active' : ''}
            onClick={() => setPlatform('pc')}
          >
            Windows / Linux
          </button>
        </div>
        <input
          type="search"
          aria-label="筛选快捷键"
          placeholder="查找按键或操作，如 Tab、折叠"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </div>
      <p className="muted small">
        {platform === 'mac'
          ? '⌘ = Command，⌥ = Option，⇧ = Shift；Return 是回车键。'
          : 'Ctrl 是控制键，Alt 是修饰键，Enter 是回车键。'}
      </p>
      <div className="help-shortcut-groups">
        {groups.map((group) => (
          <section key={group.title}>
            <h3>{group.title}</h3>
            <table className="help-shortcut-table" aria-label={group.title}>
              <thead>
                <tr>
                  <th scope="col">操作</th>
                  <th scope="col">按键 / 手势</th>
                </tr>
              </thead>
              <tbody>
                {group.shortcuts.map(({ key, action }) => (
                  <tr key={key}>
                    <td>{action}</td>
                    <td>
                      <kbd>{shortcutKey(key, platform)}</kbd>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        ))}
      </div>
      {!groups.length && <p role="status">没有匹配的快捷键，试试操作名称或清空筛选。</p>}
    </section>
  )
}

function SyncFlow() {
  return (
    <div className="help-sync-flow" role="group" aria-label="本机保存与云端同步状态图">
      <p className="help-sync-origin">编辑了脑图内容</p>
      <div className="help-sync-branches">
        <section className="help-sync-local" aria-label="本机保存状态">
          <h4>本机保存</h4>
          <p>
            <span>正在本地保存…</span>
            <b aria-hidden="true">→</b>
            <strong>本地已保存</strong>
          </p>
          <small>内容已写入当前浏览器，尚不代表已上传。</small>
          <div className="help-sync-exception">
            <b>本地未保存</b>
            <span>重试保存或导出应急备份</span>
          </div>
        </section>
        <section className="help-sync-cloud" aria-label="云端同步状态">
          <h4>云端同步</h4>
          <p>
            <span>待同步</span>
            <b aria-hidden="true">→</b>
            <strong>已同步</strong>
          </p>
          <small>“已同步”表示云端已确认当前修改。</small>
          <div className="help-sync-exception">
            <b>离线或同步失败</b>
            <span>保留本机数据，联网后再处理</span>
          </div>
        </section>
      </div>
    </div>
  )
}

function Illustration({ item }: { item: HelpIllustration }) {
  return (
    <figure className={`help-illustration ${item.detail ? 'detail' : ''}`}>
      <img src={item.src} alt={item.alt} loading="lazy" />
      <figcaption>
        <p>{item.caption}</p>
        {item.legend && (
          <ol>
            {item.legend.map((entry) => (
              <li key={entry}>{entry}</li>
            ))}
          </ol>
        )}
      </figcaption>
      <a className="help-image-open" href={item.src} target="_blank" rel="noreferrer">
        查看原图
      </a>
    </figure>
  )
}

export function Help({
  close,
  shortcuts: openShortcuts,
}: {
  close: () => void
  shortcuts?: boolean
}) {
  const [activeId, setActiveId] = useState(openShortcuts ? 'shortcuts' : 'start')
  const [query, setQuery] = useState('')
  const articleRef = useRef<HTMLElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const filtered = helpArticles.filter((article) => {
    const body = article.sections
      .map((section) =>
        [
          section.title,
          ...(section.paragraphs ?? []),
          ...(section.steps ?? []),
          section.notice?.title ?? '',
          section.notice?.text ?? '',
          section.illustrations
            ?.map((item) => `${item.alt} ${item.caption} ${item.legend?.join(' ') ?? ''}`)
            .join(' ') ?? '',
        ].join(' '),
      )
      .join(' ')
    const keys =
      article.id === 'shortcuts'
        ? shortcutGroups
            .flatMap((group) =>
              group.shortcuts.map(
                ({ key, action }) => `${group.title} ${key} ${shortcutKey(key, 'pc')} ${action}`,
              ),
            )
            .join(' ')
        : ''
    return matches(`${article.title} ${article.summary} ${article.keywords} ${body} ${keys}`, query)
  })
  const active = filtered.find((article) => article.id === activeId) ?? filtered[0]
  useEffect(() => {
    if (articleRef.current) articleRef.current.scrollTop = 0
  }, [active?.id])
  useEffect(() => {
    const frame = requestAnimationFrame(() => searchRef.current?.focus())
    return () => cancelAnimationFrame(frame)
  }, [])
  const navigate = (id: string) => {
    setQuery('')
    setActiveId(id)
  }
  return (
    <Dialog title="使用指南" close={close} className="help-dialog">
      <div className="help-center">
        <label className="help-search">
          <Search size={16} aria-hidden="true" />
          <input
            ref={searchRef}
            autoFocus
            type="search"
            aria-label="搜索帮助文章"
            placeholder="搜索操作、快捷键或问题"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          {query && (
            <button aria-label="清空帮助搜索" onClick={() => setQuery('')}>
              <X size={15} />
            </button>
          )}
        </label>
        <div className="help-layout">
          <nav className="help-nav" aria-label="帮助栏目">
            <p className="help-nav-label" role="status">
              {query.trim() ? `找到 ${filtered.length} 个栏目` : '按任务查找'}
            </p>
            {filtered.map((article) => (
              <button
                key={article.id}
                className={article.id === active?.id ? 'active' : ''}
                aria-current={article.id === active?.id ? 'page' : undefined}
                onClick={() => setActiveId(article.id)}
              >
                <span>{article.title}</span>
                <small>{article.summary}</small>
              </button>
            ))}
          </nav>
          <article
            className="help-article"
            ref={articleRef}
            aria-label={active?.title ?? '帮助搜索结果'}
          >
            {active ? (
              <>
                <p className="help-kicker">
                  使用指南 <span>/</span> {active.title}
                </p>
                <h2>{active.title}</h2>
                <p className="help-summary">{active.summary}</p>
                <div className="help-copy">
                  {active.sections.map((section) => (
                    <section key={section.title}>
                      <h3>{section.title}</h3>
                      {section.steps && (
                        <ol>
                          {section.steps.map((step) => (
                            <li key={step}>{step}</li>
                          ))}
                        </ol>
                      )}
                      {section.paragraphs?.map((paragraph) => (
                        <p key={paragraph}>{paragraph}</p>
                      ))}
                      {section.illustrations?.map((item) => (
                        <Illustration item={item} key={item.src} />
                      ))}
                      {section.visual === 'sync-flow' && <SyncFlow />}
                      {section.notice && (
                        <aside
                          className={section.notice.caution ? 'help-warning' : 'help-note'}
                          aria-label={section.notice.title}
                        >
                          <strong>{section.notice.title}</strong>
                          <p>{section.notice.text}</p>
                        </aside>
                      )}
                    </section>
                  ))}
                  {active.id === 'shortcuts' && <ShortcutGuide />}
                </div>
                <nav className="help-related" aria-label="相关主题">
                  <span>接着了解</span>
                  {active.related.map((id) => (
                    <button key={id} onClick={() => navigate(id)}>
                      {helpArticles.find((item) => item.id === id)!.title} →
                    </button>
                  ))}
                </nav>
              </>
            ) : (
              <div className="help-empty" role="status">
                <h2>没有找到相关内容</h2>
                <p>试试“同步”“导入”或按键名称，也可以清空搜索浏览全部栏目。</p>
                <button onClick={() => setQuery('')}>浏览全部栏目</button>
              </div>
            )}
          </article>
        </div>
      </div>
    </Dialog>
  )
}
