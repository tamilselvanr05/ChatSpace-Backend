function idString(value) {
    return value?._id?.toString?.() || value?.toString?.() || "";
}

function isSelfConversation(userId, peerId) {
    return Boolean(userId) && idString(userId) === idString(peerId);
}

function buildPrivateConversationQuery(userId, peerId) {
    const ownerId = idString(userId);
    const conversationId = idString(peerId);
    if (!ownerId || !conversationId) return null;
    if (ownerId === conversationId) {
        return { senderId: userId, receiverId: userId, groupId: null };
    }
    return {
        groupId: null,
        $or: [
            { senderId: userId, receiverId: peerId },
            { senderId: peerId, receiverId: userId }
        ]
    };
}

async function persistSelfMessage({ Message, userId, data, save }) {
    if (!Message || !userId || typeof save !== "function") return null;
    const message = new Message({
        ...data,
        senderId: userId,
        receiverId: userId,
        groupId: null
    });
    return await save(message, userId) ? message : null;
}

module.exports = { buildPrivateConversationQuery, isSelfConversation, persistSelfMessage };
