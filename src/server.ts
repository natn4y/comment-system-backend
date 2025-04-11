import express from "express";
import http from "http";
import cors from 'cors'

// Import types separately to avoid CommonJS/ESM conflicts
import type { Request, Response } from "express";
import { Server, Socket } from "socket.io";
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient({
    datasources: {
        db: {
            url: process.env.DATABASE_URL
        },
    },
});
// Define interface for comment structure
interface Comment {
    id?: string;
    nickname: string;
    text: string;
    parentId?: string | null;
    edited?: boolean;
    likes?: number;
}

const app = express();
const port = 8003;

// Middleware setup
app.use(cors())
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Basic route for testing
app.get("/", (req: Request, res: Response) => {
    res.send("Express server with Socket.IO is running");
});

app.get("/comments", (req: Request, res: Response) => {
    const page = parseInt(req.query.page as string || '1', 10);
    const limit = parseInt(req.query.limit as string || '10', 10);
    const skip = (page - 1) * limit;

    Promise.all([
        prisma.comment.findMany({
            orderBy: { createdAt: 'desc' },
            skip,
            take: limit,
        }),
        prisma.comment.count()
    ])
        .then(([comments, totalComments]) => {
            res.send({
                comments,
                totalComments,
                totalPages: Math.ceil(totalComments / limit),
                currentPage: page
            });
        })
        .catch(error => {
            console.error('Error fetching comments:', error);
            res.status(500).send({ error: 'Error fetching comments' });
        });
});

// POST - Criar um novo comentário
app.post("/comments", (req: Request, res: Response) => {
    const { nickname, text, parentId } = req.body;

    // Validação sem usar 'return'
    if (!nickname || !text) {
        res.status(400).send({ error: 'Nickname and text are required' });
    } else {
        Promise.all([
            prisma.comment.create({
                data: {
                    nickname,
                    text,
                    parentId: parentId || null,
                    likes: 0,
                },
            })
        ])
            .then(([comment]) => {
                res.status(201).send(comment);
            })
            .catch(error => {
                console.error('Error creating comment:', error);
                res.status(500).send({ error: 'Error creating comment' });
            });
    }
});

// PUT - Atualizar um comentário existente
app.put("/comments", (req: Request, res: Response) => {
    const { id, text } = req.body;

    // Validação sem usar 'return'
    if (!id || !text) {
        res.status(400).send({ error: 'Comment ID and text are required' });
    } else {
        Promise.all([
            prisma.comment.updateMany({
                where: { id },
                data: {
                    text,
                    edited: true
                },
            })
        ])
            .then(([comment]) => {
                if (comment.count === 0) {
                    res.status(404).send({ error: 'Comment not found or unauthorized' });
                } else {
                    res.send({ success: true });
                }
            })
            .catch(error => {
                console.error('Error updating comment:', error);
                res.status(500).send({ error: 'Error updating comment' });
            });
    }
});

// DELETE - Excluir um comentário
app.delete("/comments", (req: Request, res: Response) => {
    let id = req.query.id as string;

    // Se não estiver nos parâmetros de consulta, tente obter do corpo
    if (!id && req.body) {
        id = req.body.id;
    }

    // Validação sem usar 'return'
    if (!id) {
        res.status(400).send({ error: 'Comment ID is required' });
    } else {
        Promise.all([
            prisma.comment.deleteMany({
                where: { id },
            })
        ])
            .then(([comment]) => {
                if (comment.count === 0) {
                    res.status(404).send({ error: 'Comment not found or unauthorized' });
                } else {
                    res.send({ success: true });
                }
            })
            .catch(error => {
                console.error('Error deleting comment:', error);
                res.status(500).send({ error: 'Error deleting comment' });
            });
    }
});

// Create HTTP server
const httpServer = http.createServer(app);

// Setup Socket.IO
const io = new Server(httpServer, {
    cors: {
        origin: '*', // Permite qualquer origem
        methods: ['GET', 'POST'],
        credentials: true,
    },
    transports: ['websocket', 'polling'], // Habilita WebSocket com fallback para polling
    path: "/comment-system/socket.io"
});

io.on("connection", (socket: Socket) => {
    console.log("New client connected");

    socket.on("comment", async (comment: Comment) => {
        try {
            console.log(comment);
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
