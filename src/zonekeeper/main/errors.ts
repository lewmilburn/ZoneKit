/** Safe to show the user as is. */
export class UserError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UserError'
  }
}

/** apply refused before writing. */
export class ZoneNotWrittenError extends UserError {
  constructor(message: string) {
    super(message)
    this.name = 'ZoneNotWrittenError'
  }
}

/** The zone changed since the preview, nothing written. */
export class StaleZoneError extends UserError {
  constructor(message: string) {
    super(message)
    this.name = 'StaleZoneError'
  }
}
