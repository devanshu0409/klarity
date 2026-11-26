import { randomUUID } from 'node:crypto'
import { safeStorage } from 'electron'
import type { ClusterProfile, ClusterProfileInput } from '@shared/models'
import { invalid } from '../util/errors'
import { logger } from '../util/log'
import { JsonFile } from './jsonFile'

const log = logger('profiles')

interface PersistedProfile extends Omit<ClusterProfile, 'hasPassword' | 'hasRegistryPassword'> {
  /** SASL password, encrypted by the OS vault, base64. */
  passwordEnc?: string
  registryPasswordEnc?: string
}

interface ProfilesFile {
  version: 1
  profiles: PersistedProfile[]
}

let file: JsonFile<ProfilesFile> | null = null

function store(): JsonFile<ProfilesFile> {
  if (!file) file = new JsonFile<ProfilesFile>('clusters.json', { version: 1, profiles: [] })
  return file
}

function encrypt(secret: string): string {
  if (!safeStorage.isEncryptionAvailable()) {
    // Refuse rather than silently writing a password in the clear.
    throw invalid(
      'The OS credential vault is unavailable, so the password cannot be stored.',
      'Connect without SASL, or unlock your keychain and try again.'
    )
  }
  return safeStorage.encryptString(secret).toString('base64')
}

function decrypt(enc: string | undefined): string | undefined {
  if (!enc) return undefined
  try {
    return safeStorage.decryptString(Buffer.from(enc, 'base64'))
  } catch (err) {
    log.error('Stored secret could not be decrypted; treating it as absent', err)
    return undefined
  }
}

/** Strips secrets. This is the only shape that may leave the main process. */
function toPublic(p: PersistedProfile): ClusterProfile {
  const { passwordEnc, registryPasswordEnc, ...rest } = p
  return {
    ...rest,
    hasPassword: passwordEnc !== undefined,
    hasRegistryPassword: registryPasswordEnc !== undefined
  }
}

export function listProfiles(): ClusterProfile[] {
  return store()
    .get()
    .profiles.map(toPublic)
    .sort((a, b) => a.name.localeCompare(b.name))
}

export function getProfile(id: string): ClusterProfile {
  const found = store()
    .get()
    .profiles.find((p) => p.id === id)
  if (!found) throw invalid('That cluster no longer exists.', `Cluster id: ${id}`)
  return toPublic(found)
}

/** Secrets for connecting. Main-process only — never send the result over IPC. */
export function getSecrets(id: string): { password?: string; registryPassword?: string } {
  const found = store()
    .get()
    .profiles.find((p) => p.id === id)
  if (!found) throw invalid('That cluster no longer exists.', `Cluster id: ${id}`)
  return {
    password: decrypt(found.passwordEnc),
    registryPassword: decrypt(found.registryPasswordEnc)
  }
}

export function validateInput(input: ClusterProfileInput): void {
  if (!input.name.trim()) throw invalid('Give the cluster a name.')
  if (!input.bootstrapServers.trim()) throw invalid('Bootstrap servers are required.')
  for (const server of splitBootstrap(input.bootstrapServers)) {
    if (!/^[^\s:]+:\d{1,5}$/.test(server)) {
      throw invalid(
        `"${server}" is not a valid broker address.`,
        'Use host:port, separated by commas.'
      )
    }
  }
  if (input.sasl.enabled && !input.sasl.username.trim()) {
    throw invalid('SASL is enabled, so a username is required.')
  }
  if (input.schemaRegistry.enabled && !input.schemaRegistry.url.trim()) {
    throw invalid('Schema Registry is enabled, so its URL is required.')
  }
}

export function splitBootstrap(value: string): string[] {
  return value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

export function saveProfile(input: ClusterProfileInput): ClusterProfile {
  validateInput(input)

  const now = Date.now()
  const existing = input.id
    ? store()
        .get()
        .profiles.find((p) => p.id === input.id)
    : undefined

  // `undefined` keeps what is stored, `null` clears it, a string replaces it.
  const passwordEnc =
    input.password === undefined
      ? existing?.passwordEnc
      : input.password === null || input.password === ''
        ? undefined
        : encrypt(input.password)

  const registryPasswordEnc =
    input.registryPassword === undefined
      ? existing?.registryPasswordEnc
      : input.registryPassword === null || input.registryPassword === ''
        ? undefined
        : encrypt(input.registryPassword)

  const { password: _p, registryPassword: _r, sasl, schemaRegistry, ...rest } = input
  const { password: _sp, ...saslPublic } = sasl
  const { password: _rp, ...registryPublic } = schemaRegistry

  const persisted: PersistedProfile = {
    ...rest,
    id: existing?.id ?? input.id ?? randomUUID(),
    sasl: saslPublic,
    schemaRegistry: registryPublic,
    passwordEnc,
    registryPasswordEnc,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now
  }

  store().update((draft) => {
    const index = draft.profiles.findIndex((p) => p.id === persisted.id)
    if (index === -1) draft.profiles.push(persisted)
    else draft.profiles[index] = persisted
  })

  log.info(`Saved cluster profile "${persisted.name}"`)
  return toPublic(persisted)
}

export function cloneProfile(id: string): ClusterProfile {
  const source = store()
    .get()
    .profiles.find((p) => p.id === id)
  if (!source) throw invalid('That cluster no longer exists.', `Cluster id: ${id}`)

  const existingNames = new Set(store().get().profiles.map((p) => p.name))
  let name = `${source.name} (copy)`
  for (let n = 2; existingNames.has(name); n++) name = `${source.name} (copy ${n})`

  const now = Date.now()
  const cloned: PersistedProfile = {
    ...source,
    id: randomUUID(),
    name,
    createdAt: now,
    updatedAt: now
  }

  store().update((draft) => {
    draft.profiles.push(cloned)
  })

  log.info(`Cloned cluster profile "${source.name}" as "${cloned.name}"`)
  return toPublic(cloned)
}

export function deleteProfile(id: string): void {
  store().update((draft) => {
    draft.profiles = draft.profiles.filter((p) => p.id !== id)
  })
  log.info(`Deleted cluster profile ${id}`)
}
