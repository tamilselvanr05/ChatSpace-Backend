const mongoose = require("mongoose");

const messageSchema = new mongoose.Schema(
    {
        senderId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "User",
            required: true
        },

        senderName: {
            type: String,
            default: ""
        },

        receiverId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "User",
            default: null
        },

        groupId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "Group",
            default: null
        },

        message: {
            type: String,
            default: ""
        },

        replyTo: {
            messageId: {
                type: mongoose.Schema.Types.ObjectId,
                ref: "Message",
                default: null
            },
            message: {
                type: String,
                default: ""
            },
            senderName: {
                type: String,
                default: ""
            },
            messageType: {
                type: String,
                default: "text"
            }
        },

        messageType: {
            type: String,
            enum: [
                "text",
                "image",
                "file",
                "audio"
            ],
            default: "text"
        },

        fileName: {
            type: String,
            default: null
        },

        fileUrl: {
            type: String,
            default: null
        },

        fileType: {
            type: String,
            default: null
        },

        fileSize: {
            type: Number,
            default: null
        },

        deletedFor: [
            {
                type: mongoose.Schema.Types.ObjectId,
                ref: "User"
            }
        ],
        starredBy: [
            {
                type: mongoose.Schema.Types.ObjectId,
                ref: "User"
            }
        ],
        deliveredTo: [
            {
                type: mongoose.Schema.Types.ObjectId,
                ref: "User"
            }
        ],
        readBy: [
            {
                type: mongoose.Schema.Types.ObjectId,
                ref: "User"
            }
        ]
    },
    {
        timestamps: true
    }
);

const Message = mongoose.model(
    "Message",
    messageSchema
);

module.exports = Message;
