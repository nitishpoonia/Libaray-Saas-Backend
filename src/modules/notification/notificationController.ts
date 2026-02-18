import { prisma } from "../../utils/prisma";
import dotenv from "dotenv";
import { Request, Response } from "express";
import admin from "../../config/firebase.js";
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc";
dayjs.extend(utc);
dotenv.config();

export const registerNotificationToken = async (
  req: Request,
  res: Response,
) => {
  try {
    const user = (req as any).user;
    if (!user?.id) return res.status(401).json({ error: "Unauthorized" });

    const body = req.body ?? {};
    console.log("BOdy in notification controller", body);
    const { token } = body;

    if (!token) {
      return res.status(400).json({ error: "All the fields are required" });
    }

    await prisma.libraryOwner.update({
      where: {
        id: user?.id,
      },
      data: {
        expo_push_token: token,
      },
    });

    return res.status(200).json({
      message: "Token registered successfully",
    });
  } catch (error) {
    console.error("Error registering notification token", error);
    return res.status(500).json({
      error: "Error registering notification token",
    });
  }
};

// ✅ Core logic — no req/res, called by cron job
export const processExpiringMembershipNotifications = async () => {
  const now = dayjs().utc().toDate();
  const sevenDaysLater = dayjs().utc().add(7, "day").toDate();

  const memberships = await prisma.memberships.findMany({
    where: {
      status: "active",
      end_date: {
        gte: now,
        lte: sevenDaysLater,
      },
      notificationLogs: {
        none: {
          notification_type: "expiry_within_7_days",
        },
      },
    },
    include: {
      library: {
        include: {
          owner: true,
        },
      },
    },
  });

  console.log("Memberships found:", memberships.length);

  if (memberships.length === 0) {
    console.log("No memberships expiring in next 7 days");
    return { successCount: 0, failureCount: 0 };
  }

  const libraryMap = new Map();

  for (const membership of memberships) {
    const libraryId = membership.library_id;
    const owner = membership.library.owner;

    if (!owner?.expo_push_token || !owner.notifications_enabled) continue;

    if (!libraryMap.has(libraryId)) {
      libraryMap.set(libraryId, {
        token: owner.expo_push_token,
        count: 0,
        renewalAmount: 0,
        membershipIds: [],
      });
    }

    const data = libraryMap.get(libraryId)!;
    data.count += 1;
    data.renewalAmount += Number(membership.total_fee);
    data.membershipIds.push(membership.id);
  }

  if (!libraryMap.size) {
    console.log("No owners eligible for notification");
    return { successCount: 0, failureCount: 0 };
  }

  let successCount = 0;
  let failureCount = 0;

  for (const [libraryId, data] of libraryMap) {
    const message = {
      notification: {
        title: "Upcoming Membership Renewals",
        body: `${data.count} memberships expiring in next 7 days. Expected renewal revenue: ₹${data.renewalAmount}`,
      },
      token: data.token,
      android: {
        priority: "high" as const,
        notification: {
          sound: "default",
        },
      },
    };

    try {
      await admin.messaging().send(message);
      successCount++;

      for (const membershipId of data.membershipIds) {
        await prisma.notificationLog.create({
          data: {
            library_id: libraryId,
            membership_id: membershipId,
            notification_type: "expiry_within_7_days",
          },
        });
      }
    } catch (error) {
      console.error("FCM Error:", error);
      failureCount++;
    }
  }

  console.log(
    `Notifications processed — Success: ${successCount}, Failed: ${failureCount}`,
  );
  return { successCount, failureCount };
};

// ✅ Express route handler — calls core logic, sends HTTP response
export const notifyLibraryOwnersForExpiringMemberships = async (
  req: Request,
  res: Response,
) => {
  try {
    const result = await processExpiringMembershipNotifications();
    return res.status(200).json({
      message: "Notifications processed",
      success: result.successCount,
      failed: result.failureCount,
    });
  } catch (error) {
    console.error("Notification job error:", error);
    return res.status(500).json({
      error: "Failed to process notifications",
    });
  }
};
