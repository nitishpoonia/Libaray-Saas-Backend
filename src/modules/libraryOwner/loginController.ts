import { Request, Response } from "express";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import { prisma } from "../../utils/prisma.js";
import dotenv from "dotenv";
dotenv.config();
interface LoginBody {
  email: string;
  password: string;
}

export const loginLibraryOwner = async (
  req: Request<{}, {}, LoginBody>,
  res: Response
) => {
  try {
    const body = req.body ?? {};
    const { email, password } = body;

    if (!email || !password) {
      return res.status(400).json({ error: "Email and password are required" });
    }

    const owner = await prisma.libraryOwner.findUnique({
      where: { email },
    });

    if (!owner) {
      return res.status(400).json({ error: "Invalid email or password" });
    }

    const isMatch = await bcrypt.compare(password, owner.password_hash);
    if (!isMatch) {
      return res.status(400).json({ error: "Invalid email or password" });
    }

    // create JWT
    const token = jwt.sign(
      {
        id: owner.id,
        email: owner.email,
      },
      process.env.JWT_SECRET!,
      { expiresIn: "7d" }
    );

    return res.json({
      message: "Login successful",
      token,
      owner: {
        id: owner.id,
        name: owner.name,
        email: owner.email,
        phone: owner.phone,
      },
    });
  } catch (error) {
    console.error("Login error:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
};
