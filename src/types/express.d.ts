import type { AuthUser } from "../models/User";

// Added to every request by middleware/auth.ts
declare global {
  namespace Express {
    interface Request {
      /** Logged-in user with the role populated (set by authenticate) */
      user?: AuthUser;
      /** Effective permission names of the user's role (set by authorize/requirePermission) */
      permissions?: Set<string>;
    }
  }
}

export {};
