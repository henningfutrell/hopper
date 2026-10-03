/** A refused engine command. `code` maps to an HTTP status at the edge. */
export class EngineError extends Error {
  readonly code: 'invalid' | 'not_found' | 'conflict';

  constructor(code: 'invalid' | 'not_found' | 'conflict', message: string) {
    super(message);
    this.name = 'EngineError';
    this.code = code;
  }
}
