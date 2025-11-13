import rateLimit from 'express-rate-limit';

export const limiter = rateLimit({
  windowMs: 60 * 100000, // 1 minute
  max: 50000,
  message: {
    error: 'Too many requests, please try again later.',
    retryAfter: 'windowMs'
  }
});
