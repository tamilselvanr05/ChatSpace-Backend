const mongoose = require("mongoose");

const uploadedFileSchema = new mongoose.Schema({
    filename: { type: String, required: true, unique: true, immutable: true },
    ownerId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    purpose: { type: String, enum: ["attachment"], default: "attachment", required: true },
    messageId: { type: mongoose.Schema.Types.ObjectId, ref: "Message", default: null }
}, { timestamps: true });

uploadedFileSchema.index({ ownerId: 1, messageId: 1 });

module.exports = mongoose.model("UploadedFile", uploadedFileSchema);
