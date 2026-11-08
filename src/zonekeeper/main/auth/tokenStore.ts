import { UserError } from '../errors'

/** Wraps safeStorage, so tests don't need Electron. */
export interface Keychain {
  isAvailable(): boolean
  unavailableMessage?(): string | null
  encrypt(plain: string): Buffer
  decrypt(data: Buffer): string
}

export interface BlobFile {
  read(): Buffer | null
  write(data: Buffer): void
  remove(): void
}

const DEFAULT_UNAVAILABLE =
  "Secure storage isn't available on this system, so sign-in can't be saved."

export class EncryptionUnavailableError extends UserError {
  constructor(message: string = DEFAULT_UNAVAILABLE) {
    super(message)
    this.name = 'EncryptionUnavailableError'
  }
}

/** Null if usable, Linux's `basic_text` backend counts as unsafe. */
export function encryptionProblem(
  platform: string,
  encryptionAvailable: boolean,
  linuxBackend?: string
): string | null {
  if (!encryptionAvailable) return DEFAULT_UNAVAILABLE
  if (platform === 'linux' && (linuxBackend === undefined || linuxBackend === 'basic_text' || linuxBackend === 'unknown')) {
    return 'No system keyring was found, install and unlock one such as GNOME Keyring or KWallet.'
  }
  return null
}

export interface TokenStore {
  isAvailable(): boolean
  unavailableError(): EncryptionUnavailableError
  load(): string | null
  save(token: string): void
  clear(): void
}

export function createTokenStore(keychain: Keychain, file: BlobFile): TokenStore {
  return {
    isAvailable: () => keychain.isAvailable(),
    unavailableError: () => new EncryptionUnavailableError(keychain.unavailableMessage?.() ?? undefined),
    load() {
      if (!keychain.isAvailable()) return null
      try {
        const blob = file.read()
        if (!blob) return null
        const parsed: unknown = JSON.parse(keychain.decrypt(blob))
        if (!parsed || typeof parsed !== 'object') return null
        const t = (parsed as Record<string, unknown>).token
        // Old OAuth files count as signed out
        return typeof t === 'string' && t ? t : null
      } catch {
        // Unreadable counts as signed out
        return null
      }
    },
    save(token) {
      if (!keychain.isAvailable()) throw new EncryptionUnavailableError(keychain.unavailableMessage?.() ?? undefined)
      file.write(keychain.encrypt(JSON.stringify({ token })))
    },
    clear() {
      file.remove()
    }
  }
}
