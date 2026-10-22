const mongoose = require("mongoose");

const messageReportSchema = new mongoose.Schema({
    reporterId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    messageId: { type: mongoose.Schema.Types.ObjectId, ref: "Message", required: true },
    reason: { type: String, enum: ["suspected_scam", "suspicious_link", "impersonation", "sensitive_information", "other", "credential_request", "spam"], required: true },
    details: { type: String, default: "", maxlength: 500 }
}, { timestamps: true });

messageReportSchema.index({ reporterId: 1, messageId: 1 }, { unique: true });
messageReportSchema.index({ createdAt: -1 });

module.exports = mongoose.model("MessageReport", messageReportSchema);
