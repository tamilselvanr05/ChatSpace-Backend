const express = require("express");
const fs = require("fs");
const path = require("path");
const { getStoredUploadFilename, resolveUploadPath } = require("./privateMedia");
const { removeUploadIfUnreferenced, validateUploadedImage } = require("./profilePhotos");

function createConversationWallpaperRouter({
    authMiddleware,
    upload,
    isValidId,
    User,
    ConversationWallpaper,
    Message,
    UploadedFile,
    uploadFolder,
    fileSystem = fs,
    logger = console
}) {
    const router = express.Router();

    async function authorizePeer(req, res, next) {
        const { peerId } = req.params;
        if (!isValidId(peerId) || peerId === req.user.userId) {
            return res.status(404).json({ message: "Conversation wallpaper not found" });
        }
        try {
            const peer = await User.exists({
                _id: peerId,
                isDeleted: { $ne: true },
                isDeleting: { $ne: true }
            });
            if (!peer) return res.status(404).json({ message: "Conversation wallpaper not found" });
            return next();
        } catch (error) {
            logger.error("Conversation wallpaper authorization failed", error.code || error.name || "unknown");
            return res.status(500).json({ message: "Wallpaper could not be loaded." });
        }
    }

    router.get("/:peerId/wallpaper", authMiddleware, authorizePeer, async (req, res) => {
        try {
            const wallpaper = await ConversationWallpaper.findOne({ ownerId: req.user.userId, peerId: req.params.peerId }).lean();
            if (!wallpaper) return res.json({ wallpaper: null });
            return res.json({
                wallpaper: {
                    mediaPath: `/conversations/${req.params.peerId}/wallpaper/media`,
                    version: wallpaper.updatedAt?.toISOString?.() || String(wallpaper.updatedAt || "")
                }
            });
        } catch (error) {
            logger.error("Conversation wallpaper lookup failed", error.code || error.name || "unknown");
            return res.status(500).json({ message: "Wallpaper could not be loaded." });
        }
    });

    router.put("/:peerId/wallpaper", authMiddleware, authorizePeer, upload, async (req, res) => {
        if (!req.file || !await validateUploadedImage(req.file, fileSystem)) {
            if (req.file?.path) await fileSystem.promises.unlink(req.file.path).catch(() => {});
            return res.status(400).json({ message: "Choose a valid JPEG, PNG, or WebP image under 10 MB." });
        }

        try {
            const filter = { ownerId: req.user.userId, peerId: req.params.peerId };
            const previous = await ConversationWallpaper.findOne(filter).lean();
            const updated = await ConversationWallpaper.findOneAndUpdate(
                filter,
                { $set: { filename: req.file.filename, contentType: req.file.mimetype } },
                { new: true, upsert: true, setDefaultsOnInsert: true }
            );
            if (previous?.filename && previous.filename !== updated.filename) {
                await removeUploadIfUnreferenced({
                    fileUrl: `/uploads/${previous.filename}`,
                    userId: req.user.userId,
                    User,
                    Message,
                    UploadedFile,
                    ConversationWallpaper,
                    uploadFolder,
                    fileSystem
                });
            }
            return res.json({
                wallpaper: {
                    mediaPath: `/conversations/${req.params.peerId}/wallpaper/media`,
                    version: updated.updatedAt?.toISOString?.() || String(updated.updatedAt || "")
                }
            });
        } catch (error) {
            await fileSystem.promises.unlink(req.file.path).catch(() => {});
            logger.error("Conversation wallpaper update failed", error.code || error.name || "unknown");
            return res.status(500).json({ message: "Wallpaper could not be saved." });
        }
    });

    router.delete("/:peerId/wallpaper", authMiddleware, authorizePeer, async (req, res) => {
        try {
            const wallpaper = await ConversationWallpaper.findOneAndDelete({ ownerId: req.user.userId, peerId: req.params.peerId });
            if (wallpaper?.filename) {
                await removeUploadIfUnreferenced({
                    fileUrl: `/uploads/${wallpaper.filename}`,
                    userId: req.user.userId,
                    User,
                    Message,
                    UploadedFile,
                    ConversationWallpaper,
                    uploadFolder,
                    fileSystem
                });
            }
            return res.json({ wallpaper: null });
        } catch (error) {
            logger.error("Conversation wallpaper reset failed", error.code || error.name || "unknown");
            return res.status(500).json({ message: "Wallpaper could not be reset." });
        }
    });

    router.get("/:peerId/wallpaper/media", authMiddleware, authorizePeer, async (req, res) => {
        try {
            const wallpaper = await ConversationWallpaper.findOne({ ownerId: req.user.userId, peerId: req.params.peerId }).lean();
            const filename = wallpaper && getStoredUploadFilename(`/uploads/${wallpaper.filename}`);
            const filePath = filename && resolveUploadPath(uploadFolder, filename);
            if (!wallpaper || !filePath) return res.status(404).json({ message: "Wallpaper not found" });

            const realPath = await fileSystem.promises.realpath(filePath);
            const realRoot = await fileSystem.promises.realpath(uploadFolder);
            if (path.dirname(realPath) !== realRoot) return res.status(404).json({ message: "Wallpaper not found" });
            const stat = await fileSystem.promises.stat(realPath);
            if (!stat.isFile()) return res.status(404).json({ message: "Wallpaper not found" });
            res.set({
                "Cache-Control": "private, no-store",
                "Content-Length": String(stat.size),
                "Content-Security-Policy": "default-src 'none'; sandbox",
                "Content-Type": wallpaper.contentType,
                "X-Content-Type-Options": "nosniff"
            });
            return fileSystem.createReadStream(realPath).pipe(res);
        } catch (error) {
            if (error.code === "ENOENT" || error.code === "ENOTDIR") return res.status(404).json({ message: "Wallpaper not found" });
            logger.error("Conversation wallpaper media failed", error.code || error.name || "unknown");
            return res.status(500).json({ message: "Wallpaper could not be loaded." });
        }
    });

    return router;
}

module.exports = { createConversationWallpaperRouter };
