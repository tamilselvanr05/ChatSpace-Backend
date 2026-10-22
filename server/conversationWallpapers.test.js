const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const fs = require("fs");
const os = require("os");
const path = require("path");
const multer = require("multer");
const { createConversationWallpaperRouter } = require("./conversationWallpapers");

const idA = "aaaaaaaaaaaaaaaaaaaaaaaa";
const idB = "bbbbbbbbbbbbbbbbbbbbbbbb";
const idC = "cccccccccccccccccccccccc";

async function withWallpaperServer(callback) {
    const uploadFolder = await fs.promises.mkdtemp(path.join(os.tmpdir(), "chatspace-wallpaper-test-"));
    const records = new Map();
    const keyFor = ({ ownerId, peerId }) => `${ownerId}:${peerId}`;
    const ConversationWallpaper = {
        findOne(filter) {
            const record = records.get(keyFor(filter)) || null;
            return { lean: async () => record && { ...record } };
        },
        async findOneAndUpdate(filter, update) {
            const record = { ...(records.get(keyFor(filter)) || {}), ...update.$set, ownerId: filter.ownerId, peerId: filter.peerId, updatedAt: new Date() };
            records.set(keyFor(filter), record);
            return { ...record };
        },
        async findOneAndDelete(filter) {
            const record = records.get(keyFor(filter)) || null;
            records.delete(keyFor(filter));
            return record;
        },
        exists: async ({ filename }) => [...records.values()].some((record) => record.filename === filename)
    };
    const auth = (req, res, next) => {
        const userId = req.headers.authorization?.replace("Bearer ", "");
        if (![idA, idB, idC].includes(userId)) return res.status(401).json({ message: "Unauthorized" });
        req.user = { userId };
        return next();
    };
    const upload = multer({ storage: multer.diskStorage({ destination: uploadFolder, filename: (_req, file, done) => done(null, `${Date.now()}-${Math.random().toString(16).slice(2)}-${file.originalname}`) }), limits: { fileSize: 1024 * 1024 } }).single("file");
    const app = express();
    app.use("/conversations", createConversationWallpaperRouter({
        authMiddleware: auth,
        upload,
        isValidId: (id) => /^[a-f\d]{24}$/i.test(id),
        User: { exists: async (filter) => !filter.profilePhoto },
        ConversationWallpaper,
        Message: { exists: async () => false },
        UploadedFile: { exists: async () => false },
        uploadFolder,
        logger: { error() {} }
    }));
    const server = app.listen(0);
    try {
        await new Promise((resolve) => server.once("listening", resolve));
        await callback(`http://127.0.0.1:${server.address().port}/conversations`, records, uploadFolder);
    } finally {
        server.closeAllConnections();
        await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
        await fs.promises.rm(uploadFolder, { recursive: true, force: true });
    }
}

function headers(userId) { return { authorization: `Bearer ${userId}` }; }
function imageForm() {
    const body = new FormData();
    body.append("file", new Blob([Buffer.from([0xff, 0xd8, 0xff, 0x00])], { type: "image/jpeg" }), "wallpaper.jpg");
    return body;
}

test("wallpaper data and protected media are scoped to the authenticated owner", async () => {
    await withWallpaperServer(async (base, records) => {
        const saveA = await fetch(`${base}/${idB}/wallpaper`, { method: "PUT", headers: headers(idA), body: imageForm() });
        assert.equal(saveA.status, 200);
        const saveB = await fetch(`${base}/${idA}/wallpaper`, { method: "PUT", headers: headers(idB), body: imageForm() });
        assert.equal(saveB.status, 200);

        const privateRead = await fetch(`${base}/${idB}/wallpaper`, { headers: headers(idC) });
        assert.deepEqual(await privateRead.json(), { wallpaper: null });
        assert.equal(records.size, 2);

        const metadata = await fetch(`${base}/${idB}/wallpaper`, { headers: headers(idA) }).then((response) => response.json());
        const media = await fetch(`http://127.0.0.1:${new URL(base).port}${metadata.wallpaper.mediaPath}`, { headers: headers(idA) });
        assert.equal(media.status, 200);
        assert.equal(media.headers.get("cache-control"), "private, no-store");
        assert.equal(media.headers.get("content-type"), "image/jpeg");

        const blockedMedia = await fetch(`http://127.0.0.1:${new URL(base).port}${metadata.wallpaper.mediaPath}`, { headers: headers(idC) });
        assert.equal(blockedMedia.status, 404);
    });
});

test("replacing and resetting a wallpaper affects only one owner and conversation", async () => {
    await withWallpaperServer(async (base, records, uploadFolder) => {
        assert.equal((await fetch(`${base}/${idB}/wallpaper`, { method: "PUT", headers: headers(idA), body: imageForm() })).status, 200);
        const previousFilename = records.get(`${idA}:${idB}`).filename;
        assert.equal((await fs.promises.readdir(uploadFolder)).length, 1);
        assert.equal((await fetch(`${base}/${idB}/wallpaper`, { method: "PUT", headers: headers(idA), body: imageForm() })).status, 200);
        assert.notEqual(records.get(`${idA}:${idB}`).filename, previousFilename);
        assert.equal((await fs.promises.readdir(uploadFolder)).length, 1);

        assert.equal((await fetch(`${base}/${idA}/wallpaper`, { method: "PUT", headers: headers(idB), body: imageForm() })).status, 200);

        assert.equal((await fetch(`${base}/${idB}/wallpaper`, { method: "DELETE", headers: headers(idA) })).status, 200);
        assert.equal(records.has(`${idA}:${idB}`), false);
        assert.equal(records.has(`${idB}:${idA}`), true);
        assert.equal((await fetch(`${base}/${idA}/wallpaper`, { headers: headers(idA) })).status, 404);
        assert.equal((await fetch(`${base}/invalid/wallpaper`, { headers: headers(idA) })).status, 404);
    });
});
