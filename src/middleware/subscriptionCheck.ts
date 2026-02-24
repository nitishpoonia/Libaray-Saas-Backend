import { Request, Response, NextFunction } from "express";
import { prisma } from "../utils/prisma";

export const subscriptionCheck = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const user = (req as any).user;
    if (!user?.id) return res.status(401).json({ error: "Unauthorized" });
    console.log("Subscription middleware hit:", req.method, req.originalUrl);

    const owner = await prisma.libraryOwner.findUnique({
      where: { id: user?.id },
      select: {
        library: true,
      },
    });
    console.log("Library owner", owner);

    if (owner?.library) {
      return res.status(400).json({
        error: "Only one library can be created",
      });
    }

    next();
  } catch (error) {
    res.status(500).json({ error: "Subscription check failed" });
  }
};
