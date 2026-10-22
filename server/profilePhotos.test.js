const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const fs = require("fs");
const os = require("os");
const path = require("path");
const multer = require("multer");
const { createProfilePhotoRouter } = require("./profilePhotos");

const auth = (req, res, next) => {
    if (req.headers.authorization !== "Bearer valid") return res.status(401).json({ message: "Unauthorized" });
    req.user = { userId: "owner-1" };
    return next();
};

async function withServer(models, callback) {
    const uploadFolder = await fs.promises.mkdtemp(path.join(os.tmpdir(), "chatspace-profile-test-"));
    const app = express();
    app.use("/profile/photo", createProfilePhotoRouter({
        authMiddleware: auth,
        upload: multer({ storage: multer.diskStorage({ destination: uploadFolder, filename: (_req, file, done) => done(null, `${Date.now()}-${file.originalname}`) }), limits: { fileSize: 1024 * 1024 } }).single("file"),
        User: models.User,
        Message: models.Message || { exists: async () => false },
        UploadedFile: { exists: async () => false },
        ConversationWallpaper: { exists: async () => false },
        io: models.io,
        uploadFolder
    }));
    const server = app.listen(0);
    try {
        await new Promise((resolve) => server.once("listening", resolve));
        await callback(`http://127.0.0.1:${server.address().port}/profile/photo`, uploadFolder);
    } finally {
        server.closeAllConnections();
        await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
        await fs.promises.rm(uploadFolder, { recursive: true, force: true });
    }
}

function uploadRequest(url, bytes, contentType = "image/jpeg", filename = "photo.jpg", authorized = true) {
    const form = new FormData();
    form.append("file", new Blob([bytes], { type: contentType }), filename);
    return fetch(url, { method: "PUT", headers: authorized ? { authorization: "Bearer valid" } : {}, body: form });
}

test("profile photo upload uses authenticated owner, rejects fake image data, and broadcasts updates", async () => {
    const user = { _id: "owner-1", profilePhoto: null, async save() {} };
    const events = [];
    let query;
    await withServer({
        User: { async findOne(filter) { query = filter; return user; }, exists: async () => false },
        io: { emit: (...event) => events.push(event) }
    }, async (url, folder) => {
        const unauthorized = await uploadRequest(url, Buffer.from([0xff, 0xd8, 0xff]), "image/jpeg", "photo.jpg", false);
        assert.equal(unauthorized.status, 401);

        const invalid = await uploadRequest(url, Buffer.from("plain text"));
        assert.equal(invalid.status, 400);

        const response = await uploadRequest(url, Buffer.from([0xff, 0xd8, 0xff, 0x00]));
        assert.equal(response.status, 200);
        const data = await response.json();
        assert.match(data.profilePhoto, /^\/uploads\//);
        assert.deepEqual(query, { _id: "owner-1", isDeleted: { $ne: true }, isDeleting: { $ne: true } });
        assert.equal(user.profilePhoto, data.profilePhoto);
        assert.deepEqual(events, [["profilePhotoUpdated", { userId: "owner-1", profilePhoto: data.profilePhoto }]]);
        assert.equal((await fs.promises.readdir(folder)).length, 1);
    });
});
