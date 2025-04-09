import { PrismaClient } from '@prisma/client';

export const prisma = new PrismaClient({
    datasources: {
        db: {
            url: "mongodb://localhost:27017/comment-system?directConnection=true",
        },
    },
});