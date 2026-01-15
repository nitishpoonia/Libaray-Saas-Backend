import { Request, Response } from "express";
import { prisma } from "../../utils/prisma";
import bcrypt from "bcrypt";

import { isEmail, isPhone } from "../../helpers/basicHelper";

interface UserProfile {
  name: string;
  email: string;
  phone: string;
  password: string;
}

export const getUserProfile = async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const userId = user?.id;

    if (!userId) {
      console.error("User Id not found in getUserProfile", userId);
      return res.status(401).json({
        message: "Unauthorized",
      });
    }

    const userProfile = await prisma.libraryOwner.findUnique({
      where: {
        id: userId,
      },
      select: {
        id: true,
        name: true,
        email: true,
        phone: true,
        joined_date: true,
      },
    });

    return res.status(200).json({
      message: "User profile fetched",
      data: { userProfile },
    });
  } catch (error) {
    console.error("Error getting user profile", error);
    return res.status(500).json({
      error: "Error fetching user profile",
    });
  }
};

export const updateUserProfile = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user?.id;

    if (!userId) {
      return res.status(401).json({
        error: "Unauthorized",
      });
    }

    const { name, email, phone } = req.body || {};

    if (!name && !email && !phone) {
      return res.status(400).json({
        error: "At least one field is required",
      });
    }

    if (email && !isEmail(email)) {
      return res.status(400).json({
        error: "Provided email is not valid",
      });
    }

    if (phone && !isPhone(phone)) {
      return res.status(400).json({
        error: "Provided phone is not valid",
      });
    }

    const updatedUser = await prisma.libraryOwner.update({
      where: { id: userId },
      data: {
        ...(name && { name }),
        ...(email && { email }),
        ...(phone && { phone }),
      },
      select: {
        name: true,
        email: true,
        phone: true,
      },
    });

    return res.status(200).json({
      message: "Profile updated successfully",
      data: updatedUser,
    });
  } catch (error) {
    console.error("Error updating user profile", error);
    return res.status(500).json({
      error: "Error updating user profile",
    });
  }
};

export const changePassword = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user?.id;

    if (!userId) {
      return res.status(401).json({
        error: "Unauthorized",
      });
    }

    const { currentPassword, newPassword } = req.body || {};

    if (!currentPassword || !newPassword) {
      return res.status(400).json({
        error: "Current password and new password are required",
      });
    }

    if (currentPassword === newPassword) {
      return res.status(400).json({
        error: "New password must be different from current password",
      });
    }

    // Fetch existing password hash
    const user = await prisma.libraryOwner.findUnique({
      where: { id: userId },
      select: { password_hash: true },
    });

    if (!user || !user.password_hash) {
      return res.status(404).json({
        error: "User not found",
      });
    }

    // Verify current password
    const isPasswordValid = await bcrypt.compare(
      currentPassword,
      user.password_hash
    );

    if (!isPasswordValid) {
      return res.status(400).json({
        error: "Current password is incorrect",
      });
    }

    // Hash new password
    const hashedPassword = await bcrypt.hash(newPassword, 10);

    // Update password
    await prisma.libraryOwner.update({
      where: { id: userId },
      data: {
        password_hash: hashedPassword,
      },
    });

    return res.status(200).json({
      message: "Password changed successfully",
    });
  } catch (error) {
    console.error("Error changing password", error);
    return res.status(500).json({
      error: "Error changing password",
    });
  }
};
