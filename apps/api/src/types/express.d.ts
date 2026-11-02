import type { SessionInfo } from '../auth/auth.service.js';

declare global {
  namespace Express {
    interface Request {
      session?: SessionInfo;
      correlationId: string;
    }
  }
}

export {};
