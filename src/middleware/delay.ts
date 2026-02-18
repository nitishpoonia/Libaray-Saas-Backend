// delayMiddleware.js
import { Request, Response, NextFunction } from "express";
export const delayMiddleware = (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  setTimeout(() => {
    next();
  }, 2000); // 2 seconds delay
};
