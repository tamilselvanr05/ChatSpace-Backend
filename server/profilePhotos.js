const express = require("express");
const fs = require("fs");
const path = require("path");
const { randomUUID } = require("crypto");
const { getStoredUploadFilename, resolveUploadPath } = require("./privateMedia");
const { isSupportedImageBuffer } = require("./imageValidation");
const { createProfilePublicId, getProfileAssetPublicId, PROFILE_FOLDER } = require("./profilePhotoCloudinary");

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

async function destroyCloudinaryProfileAsset(cloudinary, publicId, userId) {
    const ownerPrefix = `${PROFILE_FOLDER}/${userId}/`;
    const assetId = typeof publicId === "string" && publicId.startsWith(ownerPrefix)
        ? publicId.slice(ownerPrefix.length)
        : "";
    if (!cloudinary?.uploader?.destroy || createProfilePublicId(userId, assetId) !== publicId) return;
    try {
        await cloudinary.uploader.destroy(publicId, { resource_type: "image", invalidate: true });
    } catch (error) {
        console.warn("Cloudinary profile photo cleanup skipped", error.code || error.name || "unknown");
    }
}

async function removePreviousProfilePhoto({ fileUrl, userId, User, Message, UploadedFile, ConversationWallpaper, uploadFolder, fileSystem, cloudinary, cloudName }) {
    if (getStoredUploadFilename(fileUrl)) {
        await removeUploadIfUnreferenced({ fileUrl, userId, User, Message, UploadedFile, ConversationWallpaper, uploadFolder, fileSystem });
        return;
    }

    const publicId = getProfileAssetPublicId(fileUrl, cloudName, userId);
    if (!publicId) return;
    try {
        if (await User.exists({ profilePhoto: fileUrl, _id: { $ne: userId } })) return;
        await destroyCloudinaryProfileAsset(cloudinary, publicId, userId);
    } catch (error) {
        console.warn("Previous profile photo cleanup skipped", error.code || error.name || "unknown");
    }
}

function createProfilePhotoRouter({ authMiddleware, upload, User, Message, UploadedFile, ConversationWallpaper, io, uploadFolder, fileSystem = fs, cloudinary, cloudName, requireCloudinary = false }) {
    const router = express.Router();

    router.put("/", authMiddleware, upload, async (req, res) => {
        if (!req.file || !await validateUploadedImage(req.file, fileSystem)) {
            await discardUpload(req.file, fileSystem);
            return res.status(400).json({ message: "Choose a valid JPEG, PNG, or WebP image." });
        }

        let user;
        let previousPhoto;
        let uploadedPublicId;
        let keepLocalUpload = false;
        try {
            if (requireCloudinary && !cloudinary) {
                return res.status(503).json({ message: "Profile photo storage is not configured." });
            }

            user = await User.findOne({
                _id: req.user.userId,
                isDeleted: { $ne: true },
                isDeleting: { $ne: true }
            });
            if (!user) {
                await discardUpload(req.file, fileSystem);
                return res.status(404).json({ message: "User not found" });
            }

            previousPhoto = user.profilePhoto;
            let profilePhoto;
            if (cloudinary) {
                const userId = user._id.toString();
                const assetId = randomUUID().replace(/-/g, "");
                uploadedPublicId = createProfilePublicId(userId, assetId);
                const uploaded = await cloudinary.uploader.upload(req.file.path, {
                    folder: `${PROFILE_FOLDER}/${userId}`,
                    public_id: assetId,
                    resource_type: "image",
                    overwrite: false
                });
                profilePhoto = uploaded?.secure_url;
                if (getProfileAssetPublicId(profilePhoto, cloudName, userId) !== uploadedPublicId) {
                    throw new Error("Cloudinary returned an invalid profile photo reference.");
                }
            } else {
                profilePhoto = `/uploads/${req.file.filename}`;
            }
            user.profilePhoto = profilePhoto;
            await user.save();
            keepLocalUpload = !cloudinary;
            uploadedPublicId = null;

            try {
                io.emit("profilePhotoUpdated", {
                    userId: user._id.toString(),
                    profilePhoto
                });
            } catch (error) {
                console.warn("Profile photo update broadcast skipped", error.code || error.name || "unknown");
            }
            await removePreviousProfilePhoto({
                fileUrl: previousPhoto,
                userId: user._id,
                User,
                Message,
                UploadedFile,
                ConversationWallpaper,
                uploadFolder,
                fileSystem,
                cloudinary,
                cloudName
            });
            return res.json({ message: "Profile photo updated", profilePhoto });
        } catch (error) {
            if (user && previousPhoto !== undefined) user.profilePhoto = previousPhoto;
            if (uploadedPublicId) await destroyCloudinaryProfileAsset(cloudinary, uploadedPublicId, user?._id?.toString() || req.user.userId);
            console.error("Profile photo update failed", error.code || error.name || "unknown");
            return res.status(500).json({ message: "Profile photo could not be updated." });
        } finally {
            if (cloudinary || !keepLocalUpload) await discardUpload(req.file, fileSystem);
        }
    });

    router.delete("/", authMiddleware, async (req, res) => {
        let user;
        let previousPhoto;
        try {
            user = await User.findOne({
                _id: req.user.userId,
                isDeleted: { $ne: true },
                isDeleting: { $ne: true }
            });
            if (!user) return res.status(404).json({ message: "User not found" });
            if (!user.profilePhoto) return res.status(400).json({ message: "No profile photo to remove" });

            previousPhoto = user.profilePhoto;
            user.profilePhoto = null;
            await user.save();
            try {
                io.emit("profilePhotoUpdated", { userId: user._id.toString(), profilePhoto: null });
            } catch (error) {
                console.warn("Profile photo removal broadcast skipped", error.code || error.name || "unknown");
            }
            await removePreviousProfilePhoto({
                fileUrl: previousPhoto,
                userId: user._id,
                User,
                Message,
                UploadedFile,
                ConversationWallpaper,
                uploadFolder,
                fileSystem,
                cloudinary,
                cloudName
            });
            return res.json({ message: "Profile photo removed successfully" });
        } catch (error) {
            if (user && previousPhoto !== undefined) user.profilePhoto = previousPhoto;
            console.error("Profile photo removal failed", error.code || error.name || "unknown");
            return res.status(500).json({ message: "Profile photo could not be removed." });
        }
    });

    return router;
}

module.exports = { createProfilePhotoRouter, destroyCloudinaryProfileAsset, isSupportedImageBuffer, removeUploadIfUnreferenced, removePreviousProfilePhoto, validateUploadedImage };
