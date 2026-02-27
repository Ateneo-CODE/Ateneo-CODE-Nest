import { db } from '@/db'
import type { DailyUpdate, LabEntry, MedicationEntry, OrderEntry, Patient, VitalEntry } from '@/types'
import { decryptBlobToPayload, encryptPayloadToBlob, sha256Hex } from './crypto'

const SYNC_CONFIG_STORAGE_KEY = 'puhrr.sync.config'
const SYNC_DATA_VERSION = 1
const DEFAULT_SYNC_ENDPOINT = 'https://purh-sync-dfeeeqh8hhdhhfb0.southeastasia-01.azurewebsites.net'

type DeviceName = 'Phone' | 'Laptop'

type SyncPayload = {
  version: number
  exportedAt: string
  deviceTag: string
  patients: Patient[]
  dailyUpdates: DailyUpdate[]
  vitals?: VitalEntry[]
  medications?: MedicationEntry[]
  labs?: LabEntry[]
  orders?: OrderEntry[]
}

type RemoteDescription = {
  roomTag: string
  lastPushedAt: string
  lastPushedBy: string
  blobSizeBytes: number
}

type SyncPushResponse = {
  gistId: string
}

type SyncCheckResponse = {
  description: string
  updatedAt: string
}

type SyncPullResponse = {
  blob: string
}

export type SyncVersion = {
  sha: string
  pushedAt: string
  deviceTag: string
  sizeBytes: number
}

const isSyncVersion = (value: unknown): value is SyncVersion => {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Record<string, unknown>
  return (
    typeof candidate.sha === 'string'
    && typeof candidate.pushedAt === 'string'
    && typeof candidate.deviceTag === 'string'
    && typeof candidate.sizeBytes === 'number'
  )
}

export type SyncConfig = {
  roomCode: string
  roomHash: string
  roomTag: string
  deviceName: DeviceName
  deviceTag: string
  gistId: string | null
  lastSyncedAt: string | null
  syncEndpoint: string
}

type SyncResult = {
  config: SyncConfig
  operation: 'push' | 'pull' | 'noop'
  message: string
}

export type ConflictResult = {
  kind: 'conflict'
  config: SyncConfig
  versions: SyncVersion[]
  remoteDeviceTag: string
  remotePushedAt: string
}

export type SyncNowResult = SyncResult | ConflictResult

export type SyncInsight = {
  localLatestChangeAt: string | null
  remoteLatestPushAt: string | null
  remoteLatestPushedBy: string | null
  hasLocalChangesSinceLastSync: boolean
  remoteHasNewerData: boolean
}

const normalizeSyncEndpoint = (endpoint?: string): string => {
  if (!endpoint || !endpoint.trim()) {
    return DEFAULT_SYNC_ENDPOINT
  }

  return endpoint.trim().replace(/\/$/, '')
}

const isSyncConfig = (value: unknown): value is SyncConfig => {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Record<string, unknown>

  return (
    typeof candidate.roomCode === 'string'
    && typeof candidate.roomHash === 'string'
    && typeof candidate.roomTag === 'string'
    && (candidate.deviceName === 'Phone' || candidate.deviceName === 'Laptop')
    && typeof candidate.deviceTag === 'string'
    && (candidate.gistId === null || typeof candidate.gistId === 'string')
    && (candidate.lastSyncedAt === null || typeof candidate.lastSyncedAt === 'string')
    && typeof candidate.syncEndpoint === 'string'
  )
}

const parseDescription = (descriptionRaw: string): RemoteDescription | null => {
  try {
    const parsed = JSON.parse(descriptionRaw) as unknown
    if (!parsed || typeof parsed !== 'object') return null
    const candidate = parsed as Record<string, unknown>
    if (
      typeof candidate.roomTag !== 'string'
      || typeof candidate.lastPushedAt !== 'string'
      || typeof candidate.lastPushedBy !== 'string'
      || typeof candidate.blobSizeBytes !== 'number'
    ) {
      return null
    }

    return {
      roomTag: candidate.roomTag,
      lastPushedAt: candidate.lastPushedAt,
      lastPushedBy: candidate.lastPushedBy,
      blobSizeBytes: candidate.blobSizeBytes,
    }
  } catch {
    return null
  }
}

const toIsoNow = (): string => new Date().toISOString()

const getLatestLocalChangeAt = async (): Promise<string | null> => {
  const [patients, dailyUpdates, vitals, medications, labs, orders] = await Promise.all([
    db.patients.toArray(),
    db.dailyUpdates.toArray(),
    db.vitals.toArray(),
    db.medications.toArray(),
    db.labs.toArray(),
    db.orders.toArray(),
  ])

  let latestTimestamp = 0

  for (const patient of patients) {
    const parsed = Date.parse(patient.lastModified ?? '')
    if (Number.isFinite(parsed) && parsed > latestTimestamp) {
      latestTimestamp = parsed
    }
  }

  for (const update of dailyUpdates) {
    const parsed = Date.parse(update.lastUpdated)
    if (Number.isFinite(parsed) && parsed > latestTimestamp) {
      latestTimestamp = parsed
    }
  }

  for (const entry of [...vitals, ...medications, ...labs, ...orders]) {
    const parsed = Date.parse(entry.createdAt)
    if (Number.isFinite(parsed) && parsed > latestTimestamp) {
      latestTimestamp = parsed
    }
  }

  return latestTimestamp > 0 ? new Date(latestTimestamp).toISOString() : null
}

const exportSyncPayload = async (deviceTag: string): Promise<SyncPayload> => {
  const [patients, dailyUpdates, vitals, medications, labs, orders] = await Promise.all([
    db.patients.toArray(),
    db.dailyUpdates.toArray(),
    db.vitals.toArray(),
    db.medications.toArray(),
    db.labs.toArray(),
    db.orders.toArray(),
  ])

  return {
    version: SYNC_DATA_VERSION,
    exportedAt: toIsoNow(),
    deviceTag,
    patients,
    dailyUpdates,
    vitals,
    medications,
    labs,
    orders,
  }
}

const sanitizeImportedPatient = (patient: Patient): Patient => {
  return {
    ...patient,
    lastModified: patient.lastModified ?? patient.admitDate ?? toIsoNow(),
  }
}

const isSyncPayload = (value: unknown): value is SyncPayload => {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Record<string, unknown>

  const validVitals = candidate.vitals === undefined || Array.isArray(candidate.vitals)
  const validMedications = candidate.medications === undefined || Array.isArray(candidate.medications)
  const validLabs = candidate.labs === undefined || Array.isArray(candidate.labs)
  const validOrders = candidate.orders === undefined || Array.isArray(candidate.orders)

  return (
    typeof candidate.version === 'number'
    && typeof candidate.exportedAt === 'string'
    && typeof candidate.deviceTag === 'string'
    && Array.isArray(candidate.patients)
    && Array.isArray(candidate.dailyUpdates)
    && validVitals
    && validMedications
    && validLabs
    && validOrders
  )
}

const replaceSyncedTables = async (payload: SyncPayload): Promise<void> => {
  const patientsToStore = payload.patients.map((patient) => sanitizeImportedPatient(patient))

  await db.transaction(
    'rw',
    [db.patients, db.dailyUpdates, db.vitals, db.medications, db.labs, db.orders],
    async () => {
      // Clear dependents (patientId references) before the parent patients table.
      await db.orders.clear()
      await db.labs.clear()
      await db.medications.clear()
      await db.vitals.clear()
      await db.dailyUpdates.clear()
      await db.patients.clear()

      if (patientsToStore.length > 0) {
        await db.patients.bulkPut(patientsToStore)
      }

      if (payload.dailyUpdates.length > 0) {
        await db.dailyUpdates.bulkPut(payload.dailyUpdates)
      }

      if (payload.vitals && payload.vitals.length > 0) {
        await db.vitals.bulkPut(payload.vitals)
      }

      if (payload.medications && payload.medications.length > 0) {
        await db.medications.bulkPut(payload.medications)
      }

      if (payload.labs && payload.labs.length > 0) {
        await db.labs.bulkPut(payload.labs)
      }

      if (payload.orders && payload.orders.length > 0) {
        await db.orders.bulkPut(payload.orders)
      }
    },
  )
}

const buildDescription = (config: SyncConfig, blobSizeBytes: number): string => {
  const description: RemoteDescription = {
    roomTag: config.roomTag,
    lastPushedAt: toIsoNow(),
    lastPushedBy: config.deviceTag,
    blobSizeBytes,
  }

  return JSON.stringify(description)
}

const fetchJson = async <T>(url: string, init?: RequestInit): Promise<T> => {
  const response = await fetch(url, init)
  if (!response.ok) {
    throw new Error(`Sync request failed (${response.status}).`)
  }

  return response.json() as Promise<T>
}

const findRoomGist = async (config: SyncConfig): Promise<string | null> => {
  try {
    const response = await fetchJson<SyncPushResponse>(
      `${config.syncEndpoint}/api/sync/find?roomTag=${encodeURIComponent(config.roomTag)}`,
    )
    return typeof response.gistId === 'string' && response.gistId.length > 0
      ? response.gistId
      : null
  } catch {
    return null
  }
}

const pushSnapshot = async (config: SyncConfig): Promise<SyncResult> => {
  const payload = await exportSyncPayload(config.deviceTag)
  const encryptedBlob = await encryptPayloadToBlob(payload, config.roomCode)
  const description = buildDescription(config, encryptedBlob.length)

  const response = await fetchJson<SyncPushResponse>(`${config.syncEndpoint}/api/sync/push`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      gistId: config.gistId,
      description,
      blob: encryptedBlob,
    }),
  })

  const nextConfig: SyncConfig = {
    ...config,
    gistId: response.gistId,
    lastSyncedAt: toIsoNow(),
  }

  saveSyncConfig(nextConfig)

  return {
    config: nextConfig,
    operation: 'push',
    message: 'Pushed encrypted snapshot.',
  }
}

const pullSnapshot = async (config: SyncConfig, sha?: string): Promise<SyncPayload> => {
  if (!config.gistId) {
    throw new Error('Sync is not linked to a room gist yet.')
  }

  const search = new URLSearchParams({ gistId: config.gistId })
  if (sha) {
    search.set('sha', sha)
  }

  const response = await fetchJson<SyncPullResponse>(`${config.syncEndpoint}/api/sync/pull?${search.toString()}`)
  const payload = await decryptBlobToPayload<unknown>(response.blob, config.roomCode)

  if (!isSyncPayload(payload)) {
    throw new Error('Remote payload format is invalid.')
  }

  if (payload.version !== SYNC_DATA_VERSION) {
    throw new Error('Remote payload version is unsupported. Please update PUHRR on both devices.')
  }

  return payload
}

const checkRemote = async (config: SyncConfig): Promise<SyncCheckResponse | null> => {
  if (!config.gistId) return null

  try {
    return await fetchJson<SyncCheckResponse>(
      `${config.syncEndpoint}/api/sync/check?gistId=${encodeURIComponent(config.gistId)}`,
    )
  } catch {
    return null
  }
}

const getRemoteVersions = async (config: SyncConfig, count = 5): Promise<SyncVersion[]> => {
  if (!config.gistId) return []

  try {
    const response = await fetchJson<unknown>(
      `${config.syncEndpoint}/api/sync/versions?gistId=${encodeURIComponent(config.gistId)}&count=${count}`,
    )

    if (!Array.isArray(response)) return []

    return response
      .filter(isSyncVersion)
      .sort((first, second) => second.pushedAt.localeCompare(first.pushedAt))
  } catch {
    return []
  }
}

export const getSyncInsight = async (currentConfig: SyncConfig): Promise<SyncInsight> => {
  const config = {
    ...currentConfig,
    syncEndpoint: normalizeSyncEndpoint(currentConfig.syncEndpoint),
  }

  const localLatestChangeAt = await getLatestLocalChangeAt()
  const localLatestMs = localLatestChangeAt ? Date.parse(localLatestChangeAt) : Number.NaN
  const lastSyncedMs = config.lastSyncedAt ? Date.parse(config.lastSyncedAt) : Number.NaN

  const hasLocalChangesSinceLastSync = Number.isFinite(lastSyncedMs)
    ? Number.isFinite(localLatestMs) && localLatestMs > lastSyncedMs
    : Number.isFinite(localLatestMs)

  if (!config.gistId) {
    return {
      localLatestChangeAt,
      remoteLatestPushAt: null,
      remoteLatestPushedBy: null,
      hasLocalChangesSinceLastSync,
      remoteHasNewerData: false,
    }
  }

  const remoteCheck = await checkRemote(config)
  if (!remoteCheck) {
    return {
      localLatestChangeAt,
      remoteLatestPushAt: null,
      remoteLatestPushedBy: null,
      hasLocalChangesSinceLastSync,
      remoteHasNewerData: false,
    }
  }

  const remoteDescription = parseDescription(remoteCheck.description)
  const remoteLatestPushAt = remoteDescription?.lastPushedAt ?? remoteCheck.updatedAt
  const remoteLatestPushedBy = remoteDescription?.lastPushedBy ?? null
  const remoteLatestMs = Date.parse(remoteLatestPushAt)

  const remoteHasNewerData = Number.isFinite(lastSyncedMs)
    ? Number.isFinite(remoteLatestMs) && remoteLatestMs > lastSyncedMs
    : Number.isFinite(remoteLatestMs)

  return {
    localLatestChangeAt,
    remoteLatestPushAt,
    remoteLatestPushedBy,
    hasLocalChangesSinceLastSync,
    remoteHasNewerData,
  }
}

export const readSyncConfig = (): SyncConfig | null => {
  if (typeof window === 'undefined') return null

  const rawValue = window.localStorage.getItem(SYNC_CONFIG_STORAGE_KEY)
  if (!rawValue) return null

  try {
    const parsed = JSON.parse(rawValue) as unknown
    if (!isSyncConfig(parsed)) return null

    return {
      ...parsed,
      syncEndpoint: normalizeSyncEndpoint(parsed.syncEndpoint),
    }
  } catch {
    return null
  }
}

export const saveSyncConfig = (config: SyncConfig): void => {
  if (typeof window === 'undefined') return

  window.localStorage.setItem(
    SYNC_CONFIG_STORAGE_KEY,
    JSON.stringify({
      ...config,
      syncEndpoint: normalizeSyncEndpoint(config.syncEndpoint),
    }),
  )
}

export const buildSyncConfig = async (
  roomCode: string,
  deviceName: DeviceName,
  syncEndpoint?: string,
): Promise<SyncConfig> => {
  const normalizedRoomCode = roomCode.trim()
  if (!normalizedRoomCode) {
    throw new Error('Room code is required.')
  }

  const roomHash = await sha256Hex(normalizedRoomCode)
  const roomTag = roomHash.slice(0, 5)
  const deviceTag = `${roomTag}-${deviceName}`

  return {
    roomCode: normalizedRoomCode,
    roomHash,
    roomTag,
    deviceName,
    deviceTag,
    gistId: null,
    lastSyncedAt: null,
    syncEndpoint: normalizeSyncEndpoint(syncEndpoint),
  }
}

export const syncNow = async (currentConfig: SyncConfig): Promise<SyncNowResult> => {
  const config = {
    ...currentConfig,
    syncEndpoint: normalizeSyncEndpoint(currentConfig.syncEndpoint),
  }

  let linkedConfig = config

  if (!linkedConfig.gistId) {
    const foundGistId = await findRoomGist(linkedConfig)
    if (foundGistId) {
      linkedConfig = { ...linkedConfig, gistId: foundGistId }
      saveSyncConfig(linkedConfig)

      const remotePayload = await pullSnapshot(linkedConfig)
      await replaceSyncedTables(remotePayload)

      const syncedConfig = {
        ...linkedConfig,
        lastSyncedAt: toIsoNow(),
      }
      saveSyncConfig(syncedConfig)

      return {
        config: syncedConfig,
        operation: 'pull',
        message: 'Pulled latest room data.',
      }
    }

    return pushSnapshot(linkedConfig)
  }

  const remoteCheck = await checkRemote(linkedConfig)
  if (!remoteCheck) {
    return pushSnapshot(linkedConfig)
  }

  const remoteDescription = parseDescription(remoteCheck.description)
  if (remoteDescription && remoteDescription.roomTag !== linkedConfig.roomTag) {
    throw new Error('Remote sync room does not match this room code.')
  }

  const remotePushedAt = remoteDescription?.lastPushedAt ?? remoteCheck.updatedAt
  const remoteDeviceTag = remoteDescription?.lastPushedBy ?? ''

  const lastSyncedMs = linkedConfig.lastSyncedAt ? Date.parse(linkedConfig.lastSyncedAt) : Number.NaN
  const remotePushedMs = Date.parse(remotePushedAt)
  const localLatestChange = await getLatestLocalChangeAt()
  const localLatestMs = localLatestChange ? Date.parse(localLatestChange) : Number.NaN

  const hasLocalChangesSinceLastSync = Number.isFinite(lastSyncedMs)
    ? Number.isFinite(localLatestMs) && localLatestMs > lastSyncedMs
    : Number.isFinite(localLatestMs)

  const remoteIsNewSinceLastSync = Number.isFinite(lastSyncedMs)
    ? Number.isFinite(remotePushedMs) && remotePushedMs > lastSyncedMs
    : Number.isFinite(remotePushedMs)

  if (remoteIsNewSinceLastSync) {
    if (hasLocalChangesSinceLastSync) {
      const versions = await getRemoteVersions(linkedConfig, 5)
      return {
        kind: 'conflict',
        config: linkedConfig,
        versions,
        remoteDeviceTag: remoteDeviceTag || 'remote room version',
        remotePushedAt,
      }
    }

    const remotePayload = await pullSnapshot(linkedConfig)
    await replaceSyncedTables(remotePayload)

    const syncedConfig = {
      ...linkedConfig,
      lastSyncedAt: toIsoNow(),
    }

    saveSyncConfig(syncedConfig)

    return {
      config: syncedConfig,
      operation: 'pull',
      message: 'Pulled latest room data.',
    }
  }

  return pushSnapshot(linkedConfig)
}

export const resolveConflictKeepLocal = async (config: SyncConfig): Promise<SyncResult> => {
  return pushSnapshot(config)
}

export const resolveConflictWithVersion = async (
  config: SyncConfig,
  versionSha: string,
): Promise<SyncResult> => {
  const payload = await pullSnapshot(config, versionSha)
  await replaceSyncedTables(payload)

  const updatedConfig = {
    ...config,
    lastSyncedAt: toIsoNow(),
  }
  saveSyncConfig(updatedConfig)

  return pushSnapshot(updatedConfig)
}

export const getDefaultSyncEndpoint = (): string => DEFAULT_SYNC_ENDPOINT
