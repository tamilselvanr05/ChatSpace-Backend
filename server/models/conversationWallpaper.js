const mongoose = require("mongoose");

const conversationWallpaperSchema = new mongoose.Schema({
    ownerId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    peerId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    filename: { type: String, required: true },
    contentType: { type: String, enum: ["image/jpeg", "image/png", "image/webp"], required: true }
}, { timestamps: true });

conversationWallpaperSchema.index({ ownerId: 1, peerId: 1 }, { unique: true });

module.exports = mongoose.model("ConversationWallpaper", conversationWallpaperSchema);
