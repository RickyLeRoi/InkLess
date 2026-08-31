// backend/src/domain/errors.js

export class DomainError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   */
  constructor(code, message) {
    super(message);
    this.name = 'DomainError';
    this.code = code;
  }
}

export class ValidationError extends DomainError {
  /** @param {string} message */
  constructor(message) {
    super('VALIDATION_FAILED', message);
    this.name = 'ValidationError';
  }
}

export class IllegalTransitionError extends DomainError {
  /**
   * @param {string} from
   * @param {string} to
   */
  constructor(from, to) {
    super('ILLEGAL_TRANSITION', `Cannot move from "${from}" to "${to}"`);
    this.name = 'IllegalTransitionError';
  }
}

export class NotFoundError extends DomainError {
  /**
   * @param {string} entity
   * @param {string} id
   */
  constructor(entity, id) {
    super('NOT_FOUND', `${entity} "${id}" does not exist`);
    this.name = 'NotFoundError';
  }
}
