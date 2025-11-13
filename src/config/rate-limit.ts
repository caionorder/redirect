import rateLimit from 'express-rate-limit';

export const limiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 500,
  message: {
    error: 'Too many requests, please try again later.',
    retryAfter: 'windowMs'
  }
});
