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
      where: { id: user.id },
      select: {
        library: {
          select: {
            status: true,
            subscription_end: true,
          },
        },
      },
    });

    console.log("Library owner", owner);

    // No library found at all
    if (!owner?.library) {
      return res.status(403).json({ error: "No library found for this owner" });
    }

    const { status, subscription_end } = owner.library;

    // Check subscription_end hasn't passed
    if (subscription_end && new Date() > new Date(subscription_end)) {
      return res.status(403).json({ error: "Your subscription has expired" });
    }

    // Only allow active or trial
    if (status !== "active" && status !== "trial") {
      return res.status(403).json({
        error: "Your subscription is not active. Please renew to continue.",
      });
    }

    next();
  } catch (error) {
    console.error("Subscription check error:", error);
    res.status(500).json({ error: "Subscription check failed" });
  }
};
