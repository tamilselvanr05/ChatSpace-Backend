const fs = require("fs");
const path = require("path");

function idString(value) {
    return value?._id?.toString?.() || value?.toString?.() || "";
}

function getStoredUploadFilename(fileUrl) {
    if (typeof fileUrl !== "string" || !fileUrl.startsWith("/uploads/")) return null;
    const filename = fileUrl.slice("/uploads/".length);
    if (!filename || filename === "." || filename === ".." ||
        filename.includes("/") || filename.includes("\\") || /[\u0000-\u001f\u007f]/.test(filename) ||
        path.basename(filename) !== filename) return null;
    return filename;
}

function resolveUploadPath(uploadFolder, filename) {
    const root = path.resolve(uploadFolder);
    const candidate = path.resolve(root, filename);
    return path.dirname(candidate) === root ? candidate : null;
}

function canReadMessageMedia(message, userId) {
    if (!message || !userId || (message.deletedFor || []).some((id) => idString(id) === idString(userId))) {
        return false;
    }
    const requester = idString(userId);
    if (message.groupId) return true;
    return [message.senderId, message.receiverId].some((id) => idString(id) === requester);
}

function parseByteRange(header, size) {
    if (header == null) return null;
    if (typeof header !== "string" || !Number.isSafeInteger(size) || size < 0) return false;
    const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
    if (!match || (!match[1] && !match[2]) || size === 0) return false;

    let start;
    let end;
    if (!match[1]) {
        const suffixLength = Number(match[2]);
        if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) return false;
        start = Math.max(0, size - suffixLength);
        end = size - 1;
    } else {
        start = Number(match[1]);
        end = match[2] ? Number(match[2]) : size - 1;
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= size) return false;
        end = Math.min(end, size - 1);
    }
    return { start, end };
}

function mediaContentType(message, filename) {
    const extension = path.extname(filename).toLowerCase();
    if (message.messageType === "image") {
        const imageTypes = {
            ".avif": "image/avif",
            ".bmp": "image/bmp",
            ".gif": "image/gif",
            ".jpeg": "image/jpeg",
            ".jpg": "image/jpeg",
            ".png": "image/png",
            ".webp": "image/webp"
        };
        if (imageTypes[extension]) return { type: imageTypes[extension], inline: true };
    }
    if (message.messageType === "audio") {
        const audioTypes = {
            ".aac": "audio/aac",
            ".m4a": "audio/mp4",
            ".mp3": "audio/mpeg",
            ".mp4": "audio/mp4",
            ".oga": "audio/ogg",
            ".ogg": "audio/ogg",
            ".wav": "audio/wav",
            ".weba": "audio/webm",
            ".webm": "audio/webm"
        };
        if (audioTypes[extension]) return { type: audioTypes[extension], inline: true };
    }
    return { type: "application/octet-stream", inline: false };
}

function contentDisposition(filename, inline) {
    const fallback = filename.replace(/[^\x20-\x7e]|["\\;]/g, "_").slice(0, 120) || "attachment";
    const encoded = encodeURIComponent(filename).replace(/[!'()*]/g, (character) =>
        `%${character.charCodeAt(0).toString(16).toUpperCase()}`
    );
    return `${inline ? "inline" : "attachment"}; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

function createMessageMediaHandler({ Message, Group, UploadedFile, uploadFolder, fileSystem = fs }) {
    return async (req, res) => {
        const messageId = req.params.messageId;
        const userId = req.user?.userId;
        if (!/^[a-f\d]{24}$/i.test(messageId || "") || !userId) {
            return res.status(userId ? 404 : 401).json({ message: "Media not found" });
        }

        try {
            const message = await Message.findById(messageId).lean();
            if (!canReadMessageMedia(message, userId) || !message.fileUrl) {
                return res.status(404).json({ message: "Media not found" });
            }
            if (message.groupId && !await Group.exists({ _id: message.groupId, members: userId })) {
                return res.status(404).json({ message: "Media not found" });
            }

            const filename = getStoredUploadFilename(message.fileUrl);
            const filePath = filename && resolveUploadPath(uploadFolder, filename);
            if (!filename || !filePath) return res.status(404).json({ message: "Media not found" });

            const uploadRecord = await UploadedFile.findOne({ filename }).select("messageId").lean();
            if (uploadRecord) {
                if (idString(uploadRecord.messageId) !== idString(message._id)) {
                    return res.status(404).json({ message: "Media not found" });
                }
            } else if (await Message.exists({ fileUrl: message.fileUrl, _id: { $ne: message._id } })) {
                return res.status(404).json({ message: "Media not found" });
            }

            const realPath = await fileSystem.promises.realpath(filePath);
            const realRoot = await fileSystem.promises.realpath(uploadFolder);
            if (path.dirname(realPath) !== realRoot) return res.status(404).json({ message: "Media not found" });
            const stats = await fileSystem.promises.stat(realPath);
            if (!stats.isFile()) return res.status(404).json({ message: "Media not found" });

            const range = parseByteRange(req.headers.range, stats.size);
            res.set({
                "Accept-Ranges": "bytes",
                "Cache-Control": "private, no-store",
                "Content-Security-Policy": "default-src 'none'; sandbox",
                "Content-Disposition": contentDisposition(filename, mediaContentType(message, filename).inline),
                "Content-Type": mediaContentType(message, filename).type,
                "X-Content-Type-Options": "nosniff"
            });
            if (range === false) {
                res.set("Content-Range", `bytes */${stats.size}`);
                return res.status(416).end();
            }
            if (stats.size === 0) return res.status(200).end();

            const start = range?.start ?? 0;
            const end = range?.end ?? stats.size - 1;
            res.set("Content-Length", String(range ? end - start + 1 : stats.size));
            if (range) res.set("Content-Range", `bytes ${start}-${end}/${stats.size}`);
            res.status(range ? 206 : 200);
            const stream = fileSystem.createReadStream(realPath, { start, end });
            stream.on("error", () => {
                if (!res.headersSent) res.status(404).json({ message: "Media not found" });
                else res.destroy();
            });
            return stream.pipe(res);
        } catch (error) {
            if (error.code === "ENOENT" || error.code === "ENOTDIR") {
                return res.status(404).json({ message: "Media not found" });
            }
            console.error("Protected media request failed", error.code || error.name || "unknown");
            return res.status(500).json({ message: "Media could not be loaded" });
        }
    };
}

function createProfileMediaHandler({ User, uploadFolder, fileSystem = fs }) {
    return async (req, res) => {
        const targetUserId = req.params.userId;
        if (!/^[a-f\d]{24}$/i.test(targetUserId || "") || !req.user?.userId) {
            return res.status(req.user?.userId ? 404 : 401).json({ message: "Media not found" });
        }
        try {
            const user = await User.findOne({ _id: targetUserId, isDeleted: { $ne: true }, isDeleting: { $ne: true } })
                .select("profilePhoto").lean();
            const filename = getStoredUploadFilename(user?.profilePhoto);
            const filePath = filename && resolveUploadPath(uploadFolder, filename);
            if (!filename || !filePath) return res.status(404).json({ message: "Media not found" });

            const realPath = await fileSystem.promises.realpath(filePath);
            const realRoot = await fileSystem.promises.realpath(uploadFolder);
            if (path.dirname(realPath) !== realRoot) return res.status(404).json({ message: "Media not found" });
            const stats = await fileSystem.promises.stat(realPath);
            if (!stats.isFile()) return res.status(404).json({ message: "Media not found" });

            const type = mediaContentType({ messageType: "image" }, filename);
            res.set({
                "Cache-Control": "private, no-store",
                "Content-Disposition": contentDisposition(filename, type.inline),
                "Content-Security-Policy": "default-src 'none'; sandbox",
                "Content-Length": String(stats.size),
                "Content-Type": type.type,
                "X-Content-Type-Options": "nosniff"
            });
            return fileSystem.createReadStream(realPath).pipe(res);
        } catch (error) {
            if (error.code === "ENOENT" || error.code === "ENOTDIR") {
                return res.status(404).json({ message: "Media not found" });
            }
            console.error("Protected profile media request failed", error.code || error.name || "unknown");
            return res.status(500).json({ message: "Media could not be loaded" });
        }
    };
}

function claimUploadedAttachment(UploadedFile, fileUrl, ownerId, messageId) {
    const filename = getStoredUploadFilename(fileUrl);
    if (!filename) return Promise.resolve(false);
    return UploadedFile.findOneAndUpdate(
        { filename, ownerId, purpose: "attachment", messageId: null },
        { $set: { messageId } },
        { new: true }
    ).then(Boolean);
}

function releaseUploadedAttachment(UploadedFile, fileUrl, ownerId, messageId) {
    const filename = getStoredUploadFilename(fileUrl);
    if (!filename) return Promise.resolve();
    return UploadedFile.updateOne({ filename, ownerId, messageId }, { $set: { messageId: null } });
}

module.exports = {
    canReadMessageMedia,
    claimUploadedAttachment,
    contentDisposition,
    createMessageMediaHandler,
    createProfileMediaHandler,
    getStoredUploadFilename,
    mediaContentType,
    parseByteRange,
    releaseUploadedAttachment,
    resolveUploadPath
};
