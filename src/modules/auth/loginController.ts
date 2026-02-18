import { Request, Response } from "express";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import { prisma } from "../../utils/prisma.js";
import dotenv from "dotenv";
import { validateIdentifier } from "../../helpers/basicHelper.js";
dotenv.config();
interface LoginBody {
  identifier: string;
  password: string;
}

export const loginLibraryOwner = async (
  req: Request<{}, {}, LoginBody>,
  res: Response,
) => {
  try {
    const body = req.body ?? {};
    const { identifier, password } = body;
    console.log("boyd", body);

    if (!identifier || !password) {
      return res
        .status(400)
        .json({ error: "Identifier and password are required" });
    }

    let user;
    const kind = validateIdentifier(identifier);

    if (kind === "email") {
      user = await prisma.libraryOwner.findUnique({
        where: { email: identifier },
      });
    } else {
      user = await prisma.libraryOwner.findUnique({
        where: { phone: identifier },
      });
    }

    if (!user) {
      return res.status(400).json({ error: "Invalid email/phone or password" });
    }

    const isMatch = await bcrypt.compare(password, user.password_hash);
    if (!isMatch) {
      return res.status(400).json({ error: "Invalid email or password" });
    }

    const libraryCount = await prisma.library.count({
      where: { library_owner_id: user.id },
    });

    // create JWT
    const token = jwt.sign(
      {
        id: user.id,
        email: user.email,
      },
      process.env.JWT_SECRET!,
      { expiresIn: "7d" },
    );

    return res.json({
      message: "Login successful",
      token,
      owner: {
        id: user.id,
        name: user.name,
        email: user.email,
        phone: user.phone,
      },
      isLibraryCreated: libraryCount > 0,
      userId: user.id,
    });
  } catch (error) {
    console.error("Login error:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
};
