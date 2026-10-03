// Adds our own fields to Express's Request type, so controllers can use
// `req.user` with full typing instead of `(req as any).user`.

export type AuthUser = {
  id: number;
};

declare global {
  namespace Express {
    interface Request {
      /** Set by authMiddleware after the JWT is verified. */
      user?: AuthUser;
    }
  }
}
