const test = require("node:test");
const assert = require("node:assert/strict");
const {
    buildPrivateConversationQuery,
    isSelfConversation,
    persistSelfMessage
} = require("./selfConversation");
const { canReadMessageMedia } = require("./privateMedia");

const owner = "64b000000000000000000001";
const other = "64b000000000000000000002";

test("self history query is restricted to the authenticated owner's self messages", () => {
    assert.deepEqual(buildPrivateConversationQuery(owner, owner), {
        senderId: owner,
        receiverId: owner,
        groupId: null
    });
    assert.equal(isSelfConversation(owner, owner), true);
    assert.equal(isSelfConversation(other, owner), false);
    assert.equal(canReadMessageMedia({ senderId: owner, receiverId: owner }, owner), true);
    assert.equal(canReadMessageMedia({ senderId: owner, receiverId: owner }, other), false);
});

test("self messages persist with authenticated sender and recipient and remain separate from other chats", async () => {
    const stored = [];
    class MockMessage {
        constructor(fields) { Object.assign(this, fields); }
    }
    const message = await persistSelfMessage({
        Message: MockMessage,
        userId: owner,
        data: { message: "saved note", senderId: other, receiverId: other, groupId: other },
        save: async (record) => { stored.push(record); return true; }
    });

    assert.equal(message.senderId, owner);
    assert.equal(message.receiverId, owner);
    assert.equal(message.groupId, null);
    assert.equal(stored.length, 1);
    assert.deepEqual(stored.filter((record) =>
        record.senderId === owner && record.receiverId === other
    ), []);
    assert.equal(await persistSelfMessage({
        Message: MockMessage,
        userId: owner,
        data: { message: "retry" },
        save: async () => false
    }), null);
});

test("ordinary private conversation query remains symmetric and owner scoped", () => {
    assert.deepEqual(buildPrivateConversationQuery(owner, other), {
        groupId: null,
        $or: [
            { senderId: owner, receiverId: other },
            { senderId: other, receiverId: owner }
        ]
    });
});
