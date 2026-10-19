export interface ClockReading {
  at: number
  uncertainty: number
}
export class EstimatedClock {
  private sample: { server: number; wall: number; monotonic: number; uncertainty: number } | null =
    null
  calibrate(server: number, startWall: number, endWall: number, monotonic: number) {
    this.sample = {
      server: server + (endWall - startWall) / 2,
      wall: endWall,
      monotonic,
      uncertainty: Math.max(5, (endWall - startWall) / 2 + 5),
    }
  }
  read(wall: number, monotonic: number): ClockReading {
    if (!this.sample) return { at: wall, uncertainty: 86400000 }
    const elapsed = Math.max(0, monotonic - this.sample.monotonic)
    // 使用单调时间估算，增加漂移范围；系统时钟跳变不改变已发生操作的顺序。
    return {
      at: this.sample.server + elapsed,
      uncertainty:
        this.sample.uncertainty + elapsed * 0.00005 + Math.abs(wall - this.sample.wall - elapsed),
    }
  }
}
