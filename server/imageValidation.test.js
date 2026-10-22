const test = require("node:test");
const assert = require("node:assert/strict");
const { isSupportedImageBuffer } = require("./imageValidation");

test("image validation requires a supported format signature matching its MIME type", () => {
    assert.equal(isSupportedImageBuffer(Buffer.from([0xff, 0xd8, 0xff, 0x00]), "image/jpeg"), true);
    assert.equal(isSupportedImageBuffer(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), "image/png"), true);
    assert.equal(isSupportedImageBuffer(Buffer.from("RIFF1234WEBP"), "image/webp"), true);
    assert.equal(isSupportedImageBuffer(Buffer.from("not an image"), "image/jpeg"), false);
    assert.equal(isSupportedImageBuffer(Buffer.from([0xff, 0xd8, 0xff]), "image/png"), false);
});
