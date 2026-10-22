const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const express = require("express");
const {
    canReadMessageMedia,
    claimUploadedAttachment,
    createMessageMediaHandler,
    getStoredUploadFilename,
    parseByteRange,
    resolveUploadPath
} = require("./privateMedia");

const USER_A = "64d000000000000000000001";
const USER_B = "64d000000000000000000002";
const USER_C = "64d000000000000000000003";
const MESSAGE_ID = "64d000000000000000000010";
const GROUP_ID = "64d000000000000000000020";

test("stored upload names reject traversal and remain inside the upload directory", () => {
    assert.equal(getStoredUploadFilename("/uploads/photo.png"), "photo.png");
    assert.equal(getStoredUploadFilename("/uploads/../secret"), null);
    assert.equal(getStoredUploadFilename("/uploads/subdir/photo.png"), null);
    assert.equal(getStoredUploadFilename("/uploads/..\\secret"), null);
    assert.equal(resolveUploadPath("C:/uploads", "../secret"), null);
});

test("new attachment references can only be claimed once by their authenticated uploader", async () => {
    let stored = { filename: "photo.png", ownerId: USER_A, purpose: "attachment", messageId: null };
    const model = {
        async findOneAndUpdate(filter, update) {
            if (stored.filename !== filter.filename || stored.ownerId !== filter.ownerId ||
                stored.purpose !== filter.purpose || stored.messageId !== filter.messageId) return null;
            stored = { ...stored, ...update.$set };
            return stored;
        }
    };
    assert.equal(await claimUploadedAttachment(model, "/uploads/photo.png", USER_B, MESSAGE_ID), false);
    assert.equal(await claimUploadedAttachment(model, "/uploads/photo.png", USER_A, MESSAGE_ID), true);
    assert.equal(stored.messageId, MESSAGE_ID);
    assert.equal(await claimUploadedAttachment(model, "/uploads/photo.png", USER_A, MESSAGE_ID), false);
    assert.equal(await claimUploadedAttachment(model, "/uploads/../secret", USER_A, MESSAGE_ID), false);
});

test("media visibility honors private participants, group membership, and deletedFor", () => {
    const privateMessage = { senderId: USER_A, receiverId: USER_B, deletedFor: [] };
    assert.equal(canReadMessageMedia(privateMessage, USER_A), true);
    assert.equal(canReadMessageMedia(privateMessage, USER_B), true);
    assert.equal(canReadMessageMedia(privateMessage, USER_C), false);
    assert.equal(canReadMessageMedia({ ...privateMessage, deletedFor: [USER_A] }, USER_A), false);

    const groupMessage = { groupId: GROUP_ID, deletedFor: [] };
    assert.equal(canReadMessageMedia(groupMessage, USER_A), true);
    assert.equal(canReadMessageMedia({ ...groupMessage, deletedFor: [USER_A] }, USER_A), false);
});

test("byte-range parsing accepts normal, open-ended, and suffix ranges and rejects invalid input", () => {
    assert.deepEqual(parseByteRange("bytes=2-5", 10), { start: 2, end: 5 });
    assert.deepEqual(parseByteRange("bytes=7-", 10), { start: 7, end: 9 });
    assert.deepEqual(parseByteRange("bytes=-3", 10), { start: 7, end: 9 });
    assert.equal(parseByteRange("bytes=20-", 10), false);
    assert.equal(parseByteRange("bytes=1-2,4-5", 10), false);
});

async function makeMediaServer(t, { message, members = [], fileBytes = Buffer.from("test-image"), filename = "photo.png", registeredMessageId = null }) {
    const uploadFolder = await fs.mkdtemp(path.join(os.tmpdir(), "chatspace-media-"));
    await fs.writeFile(path.join(uploadFolder, filename), fileBytes);
    const app = express();
    const Message = {
        findById: () => ({ lean: async () => message }),
        exists: async () => false
    };
    const Group = {
        exists: async (query) => members.some((memberId) => memberId === query.members)
    };
    const UploadedFile = {
        findOne: () => ({
            select() { return this; },
            lean: async () => registeredMessageId ? { messageId: registeredMessageId } : null
        })
    };
    app.get("/media/messages/:messageId", (req, res, next) => {
        if (req.get("Authorization") !== "Bearer test-token") return res.status(401).json({ message: "Authentication required" });
        req.user = { userId: req.get("X-Test-User") || USER_C };
        return next();
    }, createMessageMediaHandler({ Message, Group, UploadedFile, uploadFolder }));
    const server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    t.after(async () => {
        await new Promise((resolve) => server.close(resolve));
        await fs.rm(uploadFolder, { recursive: true, force: true });
    });
    return `http://127.0.0.1:${server.address().port}`;
}

function mediaMessage(overrides = {}) {
    return {
        _id: MESSAGE_ID,
        senderId: USER_A,
        receiverId: USER_B,
        groupId: null,
        deletedFor: [],
        fileUrl: "/uploads/photo.png",
        fileName: "photo.png",
        messageType: "image",
        ...overrides
    };
}

test("mock-authenticated media route denies unauthenticated and unrelated private users", async (t) => {
    const baseUrl = await makeMediaServer(t, { message: mediaMessage() });
    const unauthenticated = await fetch(`${baseUrl}/media/messages/${MESSAGE_ID}`);
    assert.equal(unauthenticated.status, 401);

    const unrelated = await fetch(`${baseUrl}/media/messages/${MESSAGE_ID}`, {
        headers: { Authorization: "Bearer test-token", "X-Test-User": USER_C }
    });
    assert.equal(unrelated.status, 404);
    assert.equal(await unrelated.text(), JSON.stringify({ message: "Media not found" }));
});

test("authorized private participant receives safe inline media and valid range responses", async (t) => {
    const bytes = Buffer.from("0123456789");
    const baseUrl = await makeMediaServer(t, { message: mediaMessage(), fileBytes: bytes });
    const headers = { Authorization: "Bearer test-token", "X-Test-User": USER_B };
    const response = await fetch(`${baseUrl}/media/messages/${MESSAGE_ID}`, { headers });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "image/png");
    assert.equal(response.headers.get("content-disposition").startsWith("inline;"), true);
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    assert.match(response.headers.get("content-security-policy"), /sandbox/);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);

    const rangeResponse = await fetch(`${baseUrl}/media/messages/${MESSAGE_ID}`, {
        headers: { ...headers, Range: "bytes=2-4" }
    });
    assert.equal(rangeResponse.status, 206);
    assert.equal(rangeResponse.headers.get("content-range"), "bytes 2-4/10");
    assert.equal(await rangeResponse.text(), "234");
});

test("group attachments require current membership and per-user message visibility", async (t) => {
    const groupMessage = mediaMessage({ groupId: GROUP_ID, receiverId: null });
    const baseUrl = await makeMediaServer(t, { message: groupMessage, members: [USER_B] });
    const member = await fetch(`${baseUrl}/media/messages/${MESSAGE_ID}`, {
        headers: { Authorization: "Bearer test-token", "X-Test-User": USER_B }
    });
    assert.equal(member.status, 200);
    await member.arrayBuffer();

    const nonMember = await fetch(`${baseUrl}/media/messages/${MESSAGE_ID}`, {
        headers: { Authorization: "Bearer test-token", "X-Test-User": USER_C }
    });
    assert.equal(nonMember.status, 404);
});

test("invalid IDs, deleted messages, mismatched uploads, and missing files do not expose paths", async (t) => {
    const hiddenUrl = await makeMediaServer(t, { message: mediaMessage({ deletedFor: [USER_B] }) });
    const hidden = await fetch(`${hiddenUrl}/media/messages/${MESSAGE_ID}`, {
        headers: { Authorization: "Bearer test-token", "X-Test-User": USER_B }
    });
    assert.equal(hidden.status, 404);

    const invalid = await fetch(`${hiddenUrl}/media/messages/../../server.js`, {
        headers: { Authorization: "Bearer test-token", "X-Test-User": USER_A }
    });
    assert.equal(invalid.status, 404);

    const mismatchedUrl = await makeMediaServer(t, {
        message: mediaMessage(),
        registeredMessageId: "64d000000000000000000011"
    });
    const mismatched = await fetch(`${mismatchedUrl}/media/messages/${MESSAGE_ID}`, {
        headers: { Authorization: "Bearer test-token", "X-Test-User": USER_A }
    });
    assert.equal(mismatched.status, 404);

    const missingUrl = await makeMediaServer(t, {
        message: mediaMessage(),
        filename: "different.png"
    });
    const missing = await fetch(`${missingUrl}/media/messages/${MESSAGE_ID}`, {
        headers: { Authorization: "Bearer test-token", "X-Test-User": USER_A }
    });
    assert.equal(missing.status, 404);
    assert.doesNotMatch(await missing.text(), /chatspace-media|uploads|[A-Z]:\\/i);
});

test("non-previewable file types are downloaded as inert octet-stream attachments", async (t) => {
    const baseUrl = await makeMediaServer(t, {
        message: mediaMessage({ fileUrl: "/uploads/report.html", messageType: "file", fileName: "report.html" }),
        filename: "report.html",
        fileBytes: Buffer.from("<script>alert(1)</script>")
    });
    const response = await fetch(`${baseUrl}/media/messages/${MESSAGE_ID}`, {
        headers: { Authorization: "Bearer test-token", "X-Test-User": USER_A }
    });
    assert.equal(response.headers.get("content-type"), "application/octet-stream");
    assert.equal(response.headers.get("content-disposition").startsWith("attachment;"), true);
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
});

test("authorized audio uses inline audio headers and supports seeking ranges", async (t) => {
    const baseUrl = await makeMediaServer(t, {
        message: mediaMessage({ fileUrl: "/uploads/voice.webm", messageType: "audio", fileName: "voice.webm" }),
        filename: "voice.webm",
        fileBytes: Buffer.from("0123456789")
    });
    const response = await fetch(`${baseUrl}/media/messages/${MESSAGE_ID}`, {
        headers: {
            Authorization: "Bearer test-token",
            "X-Test-User": USER_A,
            Range: "bytes=5-8"
        }
    });
    assert.equal(response.status, 206);
    assert.equal(response.headers.get("content-type"), "audio/webm");
    assert.equal(response.headers.get("content-disposition").startsWith("inline;"), true);
    assert.equal(response.headers.get("content-range"), "bytes 5-8/10");
    assert.equal(await response.text(), "5678");
});

test("video attachments remain protected and download as files with their extension", async (t) => {
    const baseUrl = await makeMediaServer(t, {
        message: mediaMessage({
            fileUrl: "/uploads/clip.mp4",
            fileName: "holiday clip.mp4",
            fileType: "video/mp4",
            messageType: "file"
        }),
        filename: "clip.mp4",
        fileBytes: Buffer.from("video-data")
    });
    const denied = await fetch(`${baseUrl}/media/messages/${MESSAGE_ID}`, {
        headers: { Authorization: "Bearer test-token", "X-Test-User": USER_C }
    });
    assert.equal(denied.status, 404);

    const response = await fetch(`${baseUrl}/media/messages/${MESSAGE_ID}`, {
        headers: { Authorization: "Bearer test-token", "X-Test-User": USER_B }
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "application/octet-stream");
    assert.match(response.headers.get("content-disposition"), /^attachment;/);
    assert.equal(await response.text(), "video-data");
});
