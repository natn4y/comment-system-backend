import express from "express";
import http from "http";
import { Server } from "socket.io";
import { PrismaClient } from "@prisma/client";

// Import types separately to avoid CommonJS/ESM conflicts
import type { Request, Response } from "express";
import type { Socket } from "socket.io";

// Define interface for comment structure
interface Comment {
    id?: string;
    nickname: string;
    text: string;
    parentId?: string | null;
    edited?: boolean;
    likes?: number;
}

const prisma = new PrismaClient();
const app = express();
const port = 8003;

// Middleware setup
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Basic route for testing
app.get("/", (req: Request, res: Response) => {
    res.send("Express server with Socket.IO is running");
});

// Create HTTP server
const httpServer = http.createServer(app);

// Setup Socket.IO
const io = new Server(httpServer, {
    path: '/socket',
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

io.on("connection", (socket: Socket) => {
    console.log("New client connected");

    socket.on("comment", async (comment: Comment) => {
        try {
            const savedComment = await prisma.comment.create({
                data: {
                    nickname: comment.nickname,
                    text: comment.text,
                    parentId: comment.parentId || null,
                },
            });

            io.emit("newComment", savedComment);
        } catch (error) {
            console.error("Error saving comment:", error);
        }
    });

    socket.on("updateComment", async (comment: Comment) => {
        try {
            const updateComment = await prisma.comment.update({
                where: {
                    id: comment.id,
                },
                data: {
                    nickname: comment.nickname,
                    text: comment.text,
                    edited: comment.edited,
                },
            });

            io.emit("updateComment", updateComment);
        } catch (error) {
            console.error("Error saving comment:", error);
        }
    });

    socket.on("likeComment", async ({ commentId }: { commentId: string }) => {
        try {
            // Check if comment exists
            const existingComment = await prisma.comment.findUnique({
                where: { id: commentId },
            });

            if (!existingComment) {
                console.error("Comment not found");
                return;
            }

            // Logic to toggle between like and unlike
            const updatedLikes = existingComment.likes > 0 ? existingComment.likes - 1 : existingComment.likes + 1;

            // Update number of likes on the comment
            const updatedComment = await prisma.comment.update({
                where: {
                    id: commentId,
                },
                data: {
                    likes: updatedLikes,
                },
            });

            // Emit event to all clients with updated ID and likes count
            io.emit("likeComment", { commentId: updatedComment.id, likes: updatedComment.likes });
        } catch (error) {
            console.error("Error updating likes:", error);
        }
    });

    socket.on("deleteComment", async ({ commentId }: { commentId: string }) => {
        try {
            // Recursive function to delete comments and their children
            const deleteCommentRecursively = async (id: string) => {
                // First, find all child comments
                const childComments = await prisma.comment.findMany({
                    where: {
                        parentId: id,
                    },
                });

                // Delete all children recursively
                for (const child of childComments) {
                    await deleteCommentRecursively(child.id);
                }

                // Now delete the current comment
                await prisma.comment.delete({
                    where: {
                        id: id,
                    },
                });
            };

            // Start recursive deletion from the parent comment
            await deleteCommentRecursively(commentId);

            // Emit event to notify about deletion
            io.emit('deleteComment', { commentId });
        } catch (error) {
            console.error("Error deleting comment:", error);
            // Emit error message if needed
            io.emit('error', { message: 'Error deleting comment' });
        }
    });

    socket.on("disconnect", () => {
        console.log("Client disconnected");
    });
});

// Start server
httpServer.listen(port, () => {
    console.log(`Server running on http://localhost:${port}`);
});