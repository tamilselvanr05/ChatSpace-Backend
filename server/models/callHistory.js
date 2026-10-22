const mongoose = require("mongoose");

const callHistorySchema = new mongoose.Schema({
    callId: { type: String, required: true, unique: true, immutable: true },
    callerId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    calleeId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    callType: { type: String, enum: ["audio", "video"], required: true },
    status: { type: String, enum: ["pending", "completed", "missed", "rejected", "cancelled"], default: "pending", required: true },
    initiatedAt: { type: Date, required: true, default: Date.now },
    connectedAt: { type: Date, default: null },
    endedAt: { type: Date, default: null },
    durationSeconds: { type: Number, min: 0, default: 0 }
}, { timestamps: true });

callHistorySchema.index({ callerId: 1, calleeId: 1, initiatedAt: -1 });
callHistorySchema.index({ calleeId: 1, callerId: 1, initiatedAt: -1 });

module.exports = mongoose.model("CallHistory", callHistorySchema);
