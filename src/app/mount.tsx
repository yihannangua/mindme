import ReactDOM from 'react-dom/client'
import App from '../App'
export async function mount() {
  window.addEventListener('pageshow', (event) => {
    if (event.persisted) location.reload()
  })
  const root = ReactDOM.createRoot(document.getElementById('root')!)
  const start = () => root.render(<App />)
  if (!navigator.locks) {
    start()
    return
  }
  // 同一浏览器数据库由一个页面写入，避免两个标签以旧快照相互覆盖。
  await navigator.locks.request('mindme-local-writer-v1', { ifAvailable: true }, async (lock) => {
    if (!lock) {
      root.render(
        <main className="boot">
          <div className="brand">
            <i />
            mindme
          </div>
          <h1>脑图已在另一个页面打开</h1>
          <p>请使用已打开的页面，或关闭它后在这里重试。不同浏览器和设备可正常同步。</p>
          <button className="primary" onClick={() => location.reload()}>
            重新打开
          </button>
        </main>,
      )
      return
    }
    start()
    await new Promise<void>((resolve) =>
      window.addEventListener('pagehide', () => resolve(), { once: true }),
    )
  })
}
