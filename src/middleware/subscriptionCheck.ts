import { Request, Response, NextFunction } from "express";
import { prisma } from "../utils/prisma";

export const subscriptionCheck = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const user = (req as any).user;
    if (!user?.id) return res.status(401).json({ error: "Unauthorized" });
    console.log("User id", user);

    const owner = await prisma.libraryOwner.findUnique({
      where: { id: user?.id },
      select: {
        library: {
          select: {
            status: true,
            subscription_start: true,
            subscription_end: true,
          },
        },
      },
    });
    console.log("Owner details", owner);

    const now = new Date();
    const isActive = owner && owner.library?.status === "active";

    const isTrial = owner && owner.library?.status === "trial";
    if (!owner || (!isActive && !isTrial)) {
      return res
        .status(403)
        .json({ error: "Active or trial subscription required" });
    }
    (req as any).ownerSubscription = owner;
    next();
  } catch (error) {
    res.status(500).json({ error: "Subscription check failed" });
  }
};
