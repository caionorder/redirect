import { NextFunction, Request, Response } from 'express';
import { ApiError } from '../utils/api-error';

export function errorHandler(
  err: Error,
  req: Request,
  res: Response,
  next: NextFunction,
) {
  console.error('Error details:', {
    message: err.message,
    stack: err.stack,
  });

  let apiError = err;

  if (!(err instanceof ApiError)) {
    // @ts-ignore
    if (err.code === 11000) {
      apiError = ApiError.conflict('Duplicate entry');
    } else {
      apiError = ApiError.internal('Internal server error');
    }
  }

  const { statusCode, message } = apiError as ApiError;
  const errorResponse = {
    error: message,
    ...(process.env.NODE_ENV === 'development' && { stack: err.stack }),
  };

  res.status(statusCode).json(errorResponse);
}
