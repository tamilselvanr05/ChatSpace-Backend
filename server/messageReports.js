const express = require("express");

const REPORT_REASONS = [
    "suspected_scam",
    "suspicious_link",
    "impersonation",
    "sensitive_information",
    "other",
    // Accept existing client values during rollout while the UI uses the current reason list.
    "credential_request",
    "spam"
];

function createReportRateLimiter({ limit = 5, windowMs = 10 * 60_000, now = Date.now } = {}) {
    const attemptsByUser = new Map();
    return (userId) => {
        const current = now();
        const windowStart = current - windowMs;
        const recent = (attemptsByUser.get(userId) || []).filter((timestamp) => timestamp > windowStart);
        if (recent.length >= limit) {
            attemptsByUser.set(userId, recent);
            return false;
        }
        recent.push(current);
        attemptsByUser.set(userId, recent);
        for (const [id, timestamps] of attemptsByUser) {
            if (!timestamps.some((timestamp) => timestamp > windowStart)) attemptsByUser.delete(id);
        }
        return true;
    };
}

function createMessageReportRouter({
    authMiddleware,
    isValidId,
    Message,
    Group,
    MessageReport,
    consumeLimit = createReportRateLimiter(),
    logger = console
}) {
    const router = express.Router();
    router.post("/:messageId/report", authMiddleware, async (req, res) => {
        const { messageId } = req.params;
        const reason = req.body?.reason;
        const details = req.body?.details == null ? "" : req.body.details;
        if (!isValidId(messageId)) return res.status(400).json({ message: "Invalid message ID" });
        if (!REPORT_REASONS.includes(reason) || typeof details !== "string" || details.trim().length > 500) {
            return res.status(400).json({ message: "Choose a valid report reason and keep details within 500 characters" });
        }

        try {
            const reporterId = req.user.userId;
            const message = await Message.findOne({ _id: messageId, deletedFor: { $ne: reporterId } })
                .select("senderId receiverId groupId")
                .lean();
            if (!message) return res.status(404).json({ message: "Message not found" });

            let canAccess = false;
            if (message.groupId) {
                canAccess = Boolean(await Group.exists({ _id: message.groupId, members: reporterId }));
            } else {
                canAccess = message.senderId.toString() === reporterId || message.receiverId?.toString() === reporterId;
            }
            if (!canAccess) return res.status(404).json({ message: "Message not found" });

            if (await MessageReport.exists({ reporterId, messageId })) {
                return res.status(409).json({ message: "You have already reported this message" });
            }
            if (!consumeLimit(reporterId)) return res.status(429).json({ message: "Report limit reached. Try again later." });

            await MessageReport.create({ reporterId, messageId, reason, details: details.trim() });
            return res.status(201).json({ message: "Report submitted" });
        } catch (error) {
            if (error.code === 11000) return res.status(409).json({ message: "You have already reported this message" });
            logger.error("Submit message report error:", error.code || "unknown");
            return res.status(500).json({ message: "Report could not be submitted" });
        }
    });
    return router;
}

module.exports = { REPORT_REASONS, createMessageReportRouter, createReportRateLimiter };
