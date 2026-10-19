import { createMap } from '../src/domain/model'
import { execute, type Command } from '../src/domain/commands'
import { diffSpace } from '../src/domain/operations'
import { emptySpace, type Context, type Operation, type Space } from '../src/domain/types'
let sequence = 0
export const ctx = (now = 1000): Context => ({ now, id: () => `test-${++sequence}` })
export const seed = () => createMap(emptySpace(), '测试脑图', ctx())
export const first = (space: Space) => Object.values(space.maps)[0]
export const edit = (space: Space, command: Command, now = 2000) =>
  execute(space, first(space).id, command, ctx(now)).space
export function operation(
  before: Space,
  after: Space,
  deviceId = 'device-a',
  at = 1000,
  deviceSeq = 1,
  baseRevision = 0,
  uncertainty = 0,
): Operation {
  return {
    schemaVersion: 1,
    opId: `op-${++sequence}`,
    stamp: { deviceId, at, deviceSeq, uncertainty },
    baseRevision,
    changes: diffSpace(before, after),
    state: 'pending',
    attempts: 0,
  }
}
