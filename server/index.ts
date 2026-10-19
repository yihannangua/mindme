import { configFromEnv } from './config'
import { createMindmeServer } from './app'
const config = configFromEnv(),
  app = createMindmeServer(config)
app.http.listen(config.port, config.host, () =>
  console.log(
    JSON.stringify({
      event: 'mindme 服务已启动',
      host: config.host,
      port: config.port,
      backend: 'node-sqlite',
    }),
  ),
)
const stop = () => {
  const timer = setTimeout(() => process.exit(1), 10000)
  timer.unref()
  void app
    .close()
    .then(() => process.exit(0))
    .catch(() => process.exit(1))
}
process.once('SIGTERM', stop)
process.once('SIGINT', stop)
