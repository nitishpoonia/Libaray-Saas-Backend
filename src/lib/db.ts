import type { Prisma } from "../generated/prisma/client";
import { prisma } from "./prisma";

/** Either the main client or a transaction client, so services work inside or outside a transaction. */
export type Db = typeof prisma | Prisma.TransactionClient;
