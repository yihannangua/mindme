// Cloudflare 兼容入口；独立服务器共用同一份增量存储规则。
export { initializeStorage, persistState, readDelta } from '../../shared/storage'
