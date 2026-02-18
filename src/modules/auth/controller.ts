import { prisma } from "../../utils/prisma.js";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import dotenv from "dotenv";
import { Request, Response } from "express";
import { validateIdentifier } from "../../helpers/basicHelper.js";

dotenv.config();

interface SignupBody {
  name: string;
  identifier: string;
  password: string;
}
export const createLibraryOwner = async (
  req: Request<{}, {}, SignupBody>,
  res: Response,
) => {
  try {
    const body = req.body ?? {};

    const { name, identifier, password } = body as SignupBody;

    // 1. Validation
    if (!name || name.length < 2) {
      return res.status(400).json({ error: "Name is required (min 2 chars)" });
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
    if (!kind) {
      return res.status(400).json({ error: "Invalid email or phone format" });
    }
    if (!password || password.length < 8) {
      return res
        .status(400)
        .json({ error: "Password must be at least 8 characters" });
    }

    if (user) {
      return res
        .status(409)
        .json({ error: "Email or phone already registered" });
    }

    // 3. Hash password
    const password_hash = await bcrypt.hash(password, 10);

    // 4. Create owner
    const owner = await prisma.libraryOwner.create({
      data: {
        name,
        email: kind === "email" ? identifier : null,
        phone: kind === "phone" ? identifier : null,
        password_hash,
        joined_date: new Date(),
        library: {
          create: {
            status: "trial",
            subscription_start: new Date(),
            subscription_end: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
          },
        },
      },
      select: {
        id: true,
        name: true,
        email: true,
        phone: true,
        joined_date: true,
        created_at: true,
      },
    });

    const libraryCount = await prisma.library.count({
      where: {
        library_owner_id: owner.id,
        AND: [{ name: { not: null } }, { name: { not: "" } }],
      },
    });

    const token = jwt.sign(
      {
        id: owner.id,
      },
      process.env.JWT_SECRET!,
      { expiresIn: "7d" },
    );

    // 5. Send JSON response
    return res.status(201).json({
      message: "Signup successful",
      token,
      userId: owner.id,
      isLibraryCreated: libraryCount > 0,
      owner,
    });
  } catch (error: any) {
    if (error.code === "P2002") {
      return res
        .status(409)
        .json({ error: "Email or phone already registered" });
    }
    console.error("Signup error:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
};
