/**
 * An error we expect and know how to answer. Throw it from anywhere (controller,
 * service, middleware); the error handler turns it into a JSON response.
 *
 * `code` is a stable machine-readable value the app can switch on
 * (for example SEAT_UNAVAILABLE), while `message` is for humans.
 */
export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export const badRequest = (message: string, code = "BAD_REQUEST", details?: unknown) =>
  new AppError(400, code, message, details);

export const unauthorized = (message = "Unauthorized", code = "UNAUTHORIZED") =>
  new AppError(401, code, message);

export const forbidden = (message = "Forbidden", code = "FORBIDDEN") =>
  new AppError(403, code, message);

export const notFound = (message = "Not found", code = "NOT_FOUND") =>
  new AppError(404, code, message);

export const conflict = (message: string, code = "CONFLICT", details?: unknown) =>
  new AppError(409, code, message, details);
