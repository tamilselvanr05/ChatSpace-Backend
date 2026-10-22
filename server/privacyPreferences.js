const express = require("express");

const PREFERENCE_FIELDS = new Set([
    "showOnlineStatus",
    "readReceiptsEnabled",
    "typingIndicatorEnabled"
]);

function visibleOnlineStatus(user, viewerId) {
    if (!user) return false;
    const isSelf = user._id?.toString?.() === viewerId?.toString?.();
    return Boolean(user.isOnline && (isSelf || user.showOnlineStatus !== false));
}

function typingMayBeBroadcast(typingIndicatorEnabled) {
    return typingIndicatorEnabled !== false;
}

function sanitizePresence(user, viewerId) {
    if (!user) return user;
    const safeUser = user.toObject ? user.toObject() : { ...user };
    safeUser.isOnline = visibleOnlineStatus(safeUser, viewerId);
    delete safeUser.showOnlineStatus;
    return safeUser;
}

function sanitizeGroupPresence(group, viewerId) {
    if (!group) return group;
    const safeGroup = group.toObject ? group.toObject() : { ...group };
    safeGroup.members = (safeGroup.members || []).map((member) => sanitizePresence(member, viewerId));
    return safeGroup;
}

async function clearTypingForUser({ userId, io, Group, areUsersBlocked }) {
    const sockets = await io.in(userId.toString()).fetchSockets();
    const activeConversations = new Map();
    for (const socket of sockets) {
        const active = socket.data?.activeTypingConversations;
        if (!active) continue;
        for (const [key, conversation] of active.entries()) activeConversations.set(key, conversation);
    }

    try {
        for (const conversation of activeConversations.values()) {
            if (conversation.groupId) {
                const group = await Group.findOne({ _id: conversation.groupId, members: userId })
                    .select("members")
                    .lean();
                for (const memberId of group?.members || []) {
                    const recipientId = memberId.toString();
                    if (recipientId !== userId.toString()) {
                        io.to(recipientId).emit("userTyping", {
                            senderId: userId.toString(),
                            username: conversation.username,
                            groupId: conversation.groupId,
                            isTyping: false
                        });
                    }
                }
            } else if (conversation.receiverId && !(await areUsersBlocked(userId.toString(), conversation.receiverId))) {
                io.to(conversation.receiverId).emit("userTyping", {
                    senderId: userId.toString(),
                    isTyping: false
                });
            }
        }
    } finally {
        for (const socket of sockets) socket.data?.activeTypingConversations?.clear();
    }
}

function createPrivacyPreferencesRouter({ authMiddleware, User, Group, io, areUsersBlocked, logger = console }) {
    const router = express.Router();

    router.get("/", authMiddleware, async (req, res) => {
        try {
            const user = await User.findById(req.user.userId)
                .select("showOnlineStatus readReceiptsEnabled typingIndicatorEnabled")
                .lean();
            if (!user) return res.status(404).json({ message: "User not found" });
            return res.json({
                showOnlineStatus: user.showOnlineStatus !== false,
                readReceiptsEnabled: user.readReceiptsEnabled !== false,
                typingIndicatorEnabled: user.typingIndicatorEnabled !== false
            });
        } catch (error) {
            logger.error("Privacy preferences lookup failed", error.code || error.name || "unknown");
            return res.status(500).json({ message: "Privacy settings could not be loaded." });
        }
    });

    router.patch("/", authMiddleware, async (req, res) => {
        const { preference, enabled } = req.body || {};
        if (!PREFERENCE_FIELDS.has(preference) || typeof enabled !== "boolean") {
            return res.status(400).json({ message: "Choose a valid privacy setting and On or Off." });
        }

        try {
            const projection = { [preference]: 1 };
            if (preference === "showOnlineStatus") projection.isOnline = 1;
            const user = await User.findByIdAndUpdate(
                req.user.userId,
                { $set: { [preference]: enabled } },
                { new: true, projection }
            ).lean();
            if (!user) return res.status(404).json({ message: "User not found" });

            if (preference === "showOnlineStatus") {
                try {
                    io.emit("userStatusChanged", {
                        userId: req.user.userId.toString(),
                        isOnline: enabled && Boolean(user.isOnline)
                    });
                } catch (error) {
                    logger.error("Online status update broadcast failed", error.code || error.name || "unknown");
                }
            } else if (preference === "typingIndicatorEnabled" && !enabled) {
                try {
                    await clearTypingForUser({ userId: req.user.userId, io, Group, areUsersBlocked });
                } catch (error) {
                    logger.error("Typing indicator cleanup failed", error.code || error.name || "unknown");
                }
            }

            return res.json({ preference, enabled: user[preference] !== false });
        } catch (error) {
            logger.error("Privacy preference update failed", error.code || error.name || "unknown");
            return res.status(500).json({ message: "Privacy setting could not be saved." });
        }
    });

    return router;
}

module.exports = {
    PREFERENCE_FIELDS,
    clearTypingForUser,
    createPrivacyPreferencesRouter,
    sanitizeGroupPresence,
    sanitizePresence,
    typingMayBeBroadcast,
    visibleOnlineStatus
};
