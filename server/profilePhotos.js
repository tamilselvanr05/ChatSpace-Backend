const express = require("express");
const fs = require("fs");
const path = require("path");
const { getStoredUploadFilename, resolveUploadPath } = require("./privateMedia");
const { isSupportedImageBuffer } = require("./imageValidation");

const extensionsByType = {
    "image/jpeg": new Set([".jpg", ".jpeg"]),
    "image/png": new Set([".png"]),
    "image/webp": new Set([".webp"])
};

async function validateUploadedImage(file, fileSystem = fs) {
    if (!file || !extensionsByType[file.mimetype]?.has(path.extname(file.filename || "").toLowerCase())) return false;
    try {
        const bytes = await fileSystem.promises.readFile(file.path);
        return isSupportedImageBuffer(bytes, file.mimetype);
    } catch {
        return false;
    }
}

async function removeUploadIfUnreferenced({ fileUrl, userId, User, Message, UploadedFile, ConversationWallpaper, uploadFolder, fileSystem = fs }) {
    const filename = getStoredUploadFilename(fileUrl);
    const filePath = filename && resolveUploadPath(uploadFolder, filename);
    if (!filePath) return;

    try {
        const checks = [
            User.exists({ profilePhoto: fileUrl, _id: { $ne: userId } }),
            Message.exists({ fileUrl }),
            UploadedFile?.exists ? UploadedFile.exists({ filename }) : false,
            ConversationWallpaper?.exists ? ConversationWallpaper.exists({ filename }) : false
        ];
        if ((await Promise.all(checks)).some(Boolean)) return;
        await fileSystem.promises.unlink(filePath);
    } catch (error) {
        if (error.code !== "ENOENT") console.warn("Unreferenced upload cleanup skipped", error.code || "unknown");
    }
}

async function discardUpload(file, fileSystem = fs) {
    if (!file?.path) return;
    try {
        await fileSystem.promises.unlink(file.path);
    } catch (error) {
        if (error.code !== "ENOENT") console.warn("Invalid image cleanup skipped", error.code || "unknown");
    }
}

function createProfilePhotoRouter({ authMiddleware, upload, User, Message, UploadedFile, ConversationWallpaper, io, uploadFolder, fileSystem = fs }) {
    const router = express.Router();

    router.put("/", authMiddleware, upload, async (req, res) => {
        if (!req.file || !await validateUploadedImage(req.file, fileSystem)) {
            await discardUpload(req.file, fileSystem);
            return res.status(400).json({ message: "Choose a valid JPEG, PNG, or WebP image." });
        }

        try {
            const user = await User.findOne({
                _id: req.user.userId,
                isDeleted: { $ne: true },
                isDeleting: { $ne: true }
            });
            if (!user) {
                await discardUpload(req.file, fileSystem);
                return res.status(404).json({ message: "User not found" });
            }

            const previousPhoto = user.profilePhoto;
            const profilePhoto = `/uploads/${req.file.filename}`;
            user.profilePhoto = profilePhoto;
            await user.save();

            try {
                io.emit("profilePhotoUpdated", {
                    userId: user._id.toString(),
                    profilePhoto
                });
            } catch (error) {
                console.warn("Profile photo update broadcast skipped", error.code || error.name || "unknown");
            }
            await removeUploadIfUnreferenced({
                fileUrl: previousPhoto,
                userId: user._id,
                User,
                Message,
                UploadedFile,
                ConversationWallpaper,
                uploadFolder,
                fileSystem
            });
            return res.json({ message: "Profile photo updated", profilePhoto });
        } catch (error) {
            await discardUpload(req.file, fileSystem);
            console.error("Profile photo update failed", error.code || error.name || "unknown");
            return res.status(500).json({ message: "Profile photo could not be updated." });
        }
    });

    router.delete("/", authMiddleware, async (req, res) => {
        try {
            const user = await User.findOne({
                _id: req.user.userId,
                isDeleted: { $ne: true },
                isDeleting: { $ne: true }
            });
            if (!user) return res.status(404).json({ message: "User not found" });
            if (!user.profilePhoto) return res.status(400).json({ message: "No profile photo to remove" });

            const previousPhoto = user.profilePhoto;
            user.profilePhoto = null;
            await user.save();
            try {
                io.emit("profilePhotoUpdated", { userId: user._id.toString(), profilePhoto: null });
            } catch (error) {
                console.warn("Profile photo removal broadcast skipped", error.code || error.name || "unknown");
            }
            await removeUploadIfUnreferenced({
                fileUrl: previousPhoto,
                userId: user._id,
                User,
                Message,
                UploadedFile,
                ConversationWallpaper,
                uploadFolder,
                fileSystem
            });
            return res.json({ message: "Profile photo removed successfully" });
        } catch (error) {
            console.error("Profile photo removal failed", error.code || error.name || "unknown");
            return res.status(500).json({ message: "Profile photo could not be removed." });
        }
    });

    return router;
}

module.exports = { createProfilePhotoRouter, isSupportedImageBuffer, removeUploadIfUnreferenced, validateUploadedImage };
