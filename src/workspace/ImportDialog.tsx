import { useEffect, useRef, useState } from 'react'
import { Dialog } from '../components/Dialog'
import { parseOutline, type ImportResult } from '../importers/outline'
import { parseXmindFile } from '../importers/xmind'
import { parseBackup, type Backup } from '../importers/backup'
import { message } from '../app/store'
export function ImportDialog({
  close,
  importResult,
  importJson,
  target,
}: {
  close: () => void
  importResult: (result: ImportResult, intoSelection: boolean) => Promise<void>
  importJson: (backup: Backup) => Promise<void>
  target: boolean
}) {
  const [mode, setMode] = useState<'outline' | 'xmind' | 'backup'>('outline'),
    [text, setText] = useState(''),
    [error, setError] = useState(''),
    [report, setReport] = useState(''),
    [busy, setBusy] = useState(false),
    input = useRef<HTMLInputElement>(null)
  const alive = useRef(true)
  useEffect(
    () => () => {
      alive.current = false
    },
    [],
  )
  const run = async (action: () => Promise<void>) => {
    setError('')
    setReport('')
    setBusy(true)
    try {
      await action()
    } catch (error) {
      setError(message(error))
    } finally {
      setBusy(false)
    }
  }
  const complete = (result: ImportResult) =>
    setReport(
      result.drafts.length
        ? `已导入 ${result.drafts.length} 张内容。${result.warnings.join('；') || '文字、层级和已识别标记已保留。'}`
        : '内容为空，没有新建脑图',
    )
  return (
    <Dialog title="导入内容" close={close}>
      <div className="segmented">
        {(['outline', 'xmind', 'backup'] as const).map((key) => (
          <button
            key={key}
            className={mode === key ? 'active' : ''}
            onClick={() => {
              setMode(key)
              setError('')
              setReport('')
            }}
          >
            {key === 'outline' ? 'Markdown / 大纲' : key === 'xmind' ? 'XMind 8 文件' : 'JSON 备份'}
          </button>
        ))}
      </div>
      {mode === 'outline' ? (
        <>
          <p className="muted">
            {target ? '导入为选中节点的子分支，保留原内容。' : '未选择节点，将新建脑图。'}
            标题和列表缩进决定层级。
          </p>
          <textarea
            className="outline-input"
            aria-label="导入大纲"
            placeholder={'# 我的计划\n## 目标\n- 第一步\n- 第二步'}
            value={text}
            onChange={(event) => setText(event.target.value)}
          />
          <button
            className="primary"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                const result = parseOutline(text)
                await importResult(result, true)
                complete(result)
              })
            }
          >
            导入大纲
          </button>
        </>
      ) : (
        <>
          <p className="muted">
            {mode === 'xmind'
              ? '支持 XMind 8 的 .xmind 文件（20 MiB 以内）。全部脑图分别新建并打开；损坏文件整批取消。'
              : '导入单图或全空间备份，创建新副本并自动处理重名。保留原有脑图和标签。'}
          </p>
          <div className="file-drop">
            <span>{mode === 'xmind' ? 'XMind 8' : 'mindme JSON'}</span>
            <button disabled={busy} onClick={() => input.current?.click()}>
              {busy ? '正在校验…' : '选择文件'}
            </button>
          </div>
          <input
            hidden
            ref={input}
            type="file"
            aria-label="选择导入文件"
            accept={mode === 'xmind' ? '.xmind' : '.json'}
            onChange={(event) => {
              const file = event.target.files?.[0]
              if (!file) return
              void run(async () => {
                if (mode === 'xmind') {
                  const result = await parseXmindFile(file)
                  if (!alive.current) return
                  await importResult(result, false)
                  complete(result)
                } else {
                  if (file.size > 20 * 1024 * 1024) throw new Error('备份文件超过 20 MiB')
                  const backup = parseBackup(await file.text())
                  if (!alive.current) return
                  await importJson(backup)
                  setReport(
                    `已恢复 ${backup.maps.length} 张脑图的新副本。历史版本和回收站不在备份范围内。`,
                  )
                }
              })
              event.target.value = ''
            }}
          />
        </>
      )}
      {error && (
        <p className="error-message" role="alert">
          {error}
        </p>
      )}
      {report && (
        <div className="import-report" role="status">
          {report}
        </div>
      )}
    </Dialog>
  )
}
