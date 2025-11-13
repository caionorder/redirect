export class ApiError extends Error {
  public readonly statusCode: number;
  public readonly isOperational: boolean;

  constructor(message: string, statusCode: number = 500, isOperational: boolean = true) {
    super(message);
    this.statusCode = statusCode;
    this.isOperational = isOperational;
    Object.setPrototypeOf(this, ApiError.prototype); // Restore prototype chain
  }

  static badRequest(message: string) {
    return new ApiError(message, 400);
  }

  static unauthorized(message: string) {
    return new ApiError(message, 401);
  }

  static forbidden(message: string) {
    return new ApiError(message, 403);
  }

  static notFound(message: string) {
    return new ApiError(message, 404);
  }

  static conflict(message: string) {
    return new ApiError(message, 409);
  }

  static internal(message: string) {
    return new ApiError(message, 500, false); // Internal errors are not operational
  }
}
