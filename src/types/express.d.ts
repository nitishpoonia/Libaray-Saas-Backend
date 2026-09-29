// Adds our own fields to Express's Request type, so controllers get full typing
// instead of `(req as any).user`.

export type AuthUser = {
  id: number;
  sessionId: number;
};

/** OWNER is the organization owner; MANAGER and STAFF come from library_staff. */
export type LibraryRole = "OWNER" | "MANAGER" | "STAFF";

export type LibraryAccess = {
  role: LibraryRole;
  library: {
    id: number;
    organizationId: number;
    name: string;
    timezone: string;
    gracePeriodDays: number;
  };
};

declare global {
  namespace Express {
    interface Request {
      /** Set by authMiddleware. */
      user?: AuthUser;
      /** Set by libraryAccess for routes under /libraries/:libraryId. */
      access?: LibraryAccess;
    }
  }
}
