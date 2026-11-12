// One error type for readable API errors: { error: { code, message } }.
export class AppError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export const errors = {
  badRequest: (message, code = 'validation_error') => new AppError(400, code, message),
  forbidden: (message, code = 'forbidden') => new AppError(403, code, message),
  notFound: (message = 'Not found.', code = 'not_found') => new AppError(404, code, message),
  conflict: (message, code) => new AppError(409, code, message),
  tooMany: (message, code = 'rate_limited') => new AppError(429, code, message),
  unavailable: (message, code = 'judge_unavailable') => new AppError(503, code, message),
};
