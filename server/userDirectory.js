const express = require("express");

const USER_FIELDS = "username about profilePhoto isOnline showOnlineStatus isDeleted";

function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildUserDirectoryQuery(userId, hiddenConversationIds = [], search = "") {
    const normalizedSearch = typeof search === "string" ? search.trim() : "";
    const query = {
        _id: { $ne: userId },
        isDeleted: { $ne: true }
    };
    if (normalizedSearch) {
        query.username = { $regex: escapeRegExp(normalizedSearch), $options: "i" };
    } else {
        query._id.$nin = hiddenConversationIds;
    }
    return query;
}

function createUserDirectoryRouter({ authMiddleware, User, io, isValidId, sanitizePresence, logger = console }) {
    const router = express.Router();

    router.get("/", authMiddleware, async (req, res) => {
        const search = typeof req.query.search === "string" ? req.query.search.trim() : "";
        if (search.length > 100) return res.status(400).json({ message: "Search text is too long." });

        try {
            const currentUser = await User.findById(req.user.userId).select("hiddenConversations").lean();
            if (!currentUser) return res.status(404).json({ message: "User not found." });
            const users = await User.find(buildUserDirectoryQuery(
                req.user.userId,
                currentUser.hiddenConversations || [],
                search
            )).select(USER_FIELDS).lean();
            return res.status(200).json({
                message: "Users fetched successfully",
                users: users.map((user) => ({
                    ...sanitizePresence(user, req.user.userId),
                    ...(search ? {
                        isHiddenConversation: (currentUser.hiddenConversations || [])
                            .some((hiddenId) => hiddenId.toString() === user._id.toString())
                    } : {})
                }))
            });
        } catch (error) {
            logger.error("User directory lookup failed", error.code || error.name || "unknown");
            return res.status(500).json({ message: "People could not be loaded." });
        }
    });

    router.post("/:userId/restore", authMiddleware, async (req, res) => {
        const { userId } = req.params;
        const ownerId = req.user.userId;
        if (!isValidId(userId) || userId === ownerId.toString()) {
            return res.status(400).json({ message: "Choose a valid private conversation." });
        }

        try {
            const target = await User.exists({ _id: userId, isDeleted: { $ne: true } });
            if (!target) return res.status(404).json({ message: "User not found." });
            await User.updateOne({ _id: ownerId }, { $pull: { hiddenConversations: userId } });
            io.to(ownerId.toString()).emit("conversationRestored", { userId: userId.toString() });
            return res.status(200).json({ message: "Conversation is available in your list." });
        } catch (error) {
            logger.error("Conversation restore failed", error.code || error.name || "unknown");
            return res.status(500).json({ message: "Conversation could not be restored." });
        }
    });

    return router;
}

module.exports = { buildUserDirectoryQuery, createUserDirectoryRouter };
