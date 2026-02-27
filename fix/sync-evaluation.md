# Sync System Evaluation — PUHRR (PortableElectronicHealthRecord)

## Summary

The sync system only syncs **patients** and **dailyUpdates**. It does **not** sync vitals,
medications, labs, or orders — confirming the users' reports. The JSON export/import
(`Settings → Export Backup` / `Import Backup`) correctly includes all six data tables.
The fix is to extend `syncService.ts` to include the missing four tables, matching the
export payload exactly.

---

## What the app stores

The Dexie database (`src/db.ts`) has seven tables:

| Table             | Synced today? | Exported (JSON backup)? |
|-------------------|:---:|:---:|
| `patients`        | ✅ | ✅ |
| `dailyUpdates`    | ✅ | ✅ |
| `vitals`          | ❌ | ✅ |
| `medications`     | ❌ | ✅ |
| `labs`            | ❌ | ✅ |
| `orders`          | ❌ | ✅ |
| `photoAttachments`| ❌ | ❌ (by design) |

Photos are intentionally excluded from both sync and export (large binary blobs, on-device only).
Everything else **should** be synced but currently isn't.

---

## Root cause in `src/features/sync/syncService.ts`

Four specific problems, all in the same file:

### 1. `SyncPayload` type is too narrow

```ts
// current — missing vitals, medications, labs, orders
type SyncPayload = {
  version: number
  exportedAt: string
  deviceTag: string
  patients: Patient[]
  dailyUpdates: DailyUpdate[]
}
```

### 2. `exportSyncPayload` only reads two tables

```ts
// current
const exportSyncPayload = async (deviceTag: string): Promise<SyncPayload> => {
  const [patients, dailyUpdates] = await Promise.all([
    db.patients.toArray(),
    db.dailyUpdates.toArray(),
  ])
  return { version: SYNC_DATA_VERSION, exportedAt: toIsoNow(), deviceTag, patients, dailyUpdates }
}
```

### 3. `replaceSyncedTables` only clears and restores two tables

```ts
// current
const replaceSyncedTables = async (payload: SyncPayload): Promise<void> => {
  await db.transaction('rw', [db.patients, db.dailyUpdates], async () => {
    await db.dailyUpdates.clear()
    await db.patients.clear()
    if (patientsToStore.length > 0) await db.patients.bulkPut(patientsToStore)
    if (payload.dailyUpdates.length > 0) await db.dailyUpdates.bulkPut(payload.dailyUpdates)
  })
}
```

This means a pull **wipes vitals/meds/labs/orders on the destination device** but never
restores them — silent data loss on every pull.

### 4. `getLatestLocalChangeAt` misses four tables for conflict detection

```ts
// current — only checks patients.lastModified and dailyUpdates.lastUpdated
const getLatestLocalChangeAt = async (): Promise<string | null> => {
  const [patients, dailyUpdates] = await Promise.all([
    db.patients.toArray(),
    db.dailyUpdates.toArray(),
  ])
  // ... only patients and dailyUpdates timestamps checked
}
```

If you add a new vital or medication but don't touch a patient profile or daily update, the
conflict detector does not see those changes as "local changes since last sync." You could
lose vitals/meds/labs/orders in a conflict resolution even if you edited them.

---

## Does the sync use import/export JSON?

**No, and that is the problem.** The `exportBackup` / `importBackup` functions in `App.tsx`
use a `BackupPayload` that correctly includes all six text tables:

```ts
// App.tsx — BackupPayload (correct, used by export/import)
{
  patients: Patient[]
  dailyUpdates: DailyUpdate[]
  vitals?: VitalEntry[]
  medications?: MedicationEntry[]
  labs?: LabEntry[]
  orders?: OrderEntry[]
}
```

The sync `SyncPayload` should use the same structure. It doesn't. That is the entire bug.

---

## The fix

Replace `src/features/sync/syncService.ts` with the corrected version in
[`fix/syncService.ts`](./syncService.ts) in this repository.

The four surgical changes are:

1. **Add types to import line** — `LabEntry, MedicationEntry, OrderEntry, VitalEntry`
2. **Extend `SyncPayload`** — add `vitals?`, `medications?`, `labs?`, `orders?`
3. **Extend `exportSyncPayload`** — read all six tables from Dexie
4. **Extend `replaceSyncedTables`** — clear and restore all six tables in one transaction
5. **Extend `getLatestLocalChangeAt`** — scan `createdAt` on vitals/meds/labs/orders

The fields are optional (`?`) in `SyncPayload` so that an older snapshot (pushed before this
fix) can still be pulled without breaking validation. If those arrays are absent the pull
simply skips clearing/inserting them, preserving local data — the same graceful-degradation
pattern already used by `importBackup`.

---

## Should sync and export/import be unified?

**Yes — they can share the same payload shape.** The simplest refactor would be to:

1. Move `BackupPayload` (currently defined inline in `App.tsx`) into `src/types.ts`
2. Rename it `FullDataPayload` (or keep `BackupPayload`)
3. Have `SyncPayload` extend it: `type SyncPayload = BackupPayload & { version: number; exportedAt: string; deviceTag: string }`
4. Reuse `importBackup`'s transaction logic inside `replaceSyncedTables`

This PR delivers the minimal fix (step 1–5 above) without the refactor, so the diff is as
small as possible and easy to review. The unification can be done as a follow-up.

---

## No Azure Function changes needed

The Azure Function proxies are a thin pass-through — they encrypt/decrypt nothing and don't
inspect the payload contents. Adding more fields to the JSON payload inside the encrypted
blob requires **no changes to the server side**. Only `syncService.ts` needs updating.
