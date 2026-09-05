export type StatusTone = 'operational' | 'degraded' | 'outage' | 'unknown'

export interface ServiceStatus {
  id: 'website' | 'api' | 'assets' | 'mail'
  name: string
  description: string
  url: string
  status: Exclude<StatusTone, 'unknown'>
  latencyMs: number | null
  httpStatus: number | null
  checkedAt: number
  message: string
}

export interface NodeStatus {
  name: string
  status: StatusTone
  timestamp: number | null
  systemType: string | null
  cpuUsage: number | null
  memoryUsage: number | null
  message: string
}

export interface MinecraftStatus {
  address: string
  status: StatusTone
  online: boolean
  playersOnline: number | null
  playersMax: number | null
  version: string | null
  protocol: string | null
  latencyMs: number | null
  message: string
}

export interface AvailabilityPoint {
  time: number
  status: 'online' | 'offline'
}

export interface StatusSnapshot {
  generatedAt: number
  refreshAfterMs: number
  overall: StatusTone
  services: ServiceStatus[]
  node: NodeStatus
  minecraft: MinecraftStatus
  history: AvailabilityPoint[]
  errors: Partial<Record<'node' | 'minecraft' | 'history' | 'storage' | 'worker', string>>
  stale?: boolean
}

export interface StatusHistorySample {
  capturedAt: number
  overall: StatusTone
  services: ServiceStatus[]
  node: NodeStatus
  minecraft: MinecraftStatus
  errors: Partial<Record<'node' | 'minecraft' | 'storage', string>>
}
