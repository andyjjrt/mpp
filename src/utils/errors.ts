export class AppError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly statusCode: number = 500,
    public readonly isOperational: boolean = true
  ) {
    super(message);
    this.name = this.constructor.name;
    Error.captureStackTrace(this, this.constructor);
  }
}

export class ConfigValidationError extends AppError {
  constructor(public readonly issues: readonly string[]) {
    super(
      `Configuration validation failed: ${issues.join('; ')}`,
      'CONFIG_VALIDATION_ERROR',
      500,
      true
    );
  }
}

export class RuntimeError extends AppError {
  constructor(message: string, statusCode: number = 500) {
    super(message, 'RUNTIME_ERROR', statusCode, true);
  }
}

export function toError(error: unknown): Error {
  if (error instanceof Error) {
    return error;
  }

  return new Error(typeof error === 'string' ? error : 'Unknown error');
}
