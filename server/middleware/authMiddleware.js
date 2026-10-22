const { resolveFirebaseUser } = require("../firebaseIdentity");
const firebaseAuth = require("../firebaseAdmin");

const authMiddleware = async (req, res, next) => {
    try {
        const authHeader = req.headers.authorization;
        const token = authHeader?.match(/^Bearer\s+(\S+)$/i)?.[1];
        if (!token) {
            return res.status(401).json({
                message: "A Firebase ID token is required"
            });
        }

        const [user, decoded] = await Promise.all([
            resolveFirebaseUser(token),
            firebaseAuth.verifyIdToken(token)
        ]);
        const isDeletionRequest = req.method === "DELETE" && req.path === "/account";
        const isDeletionStatusRequest = req.method === "GET" && req.path === "/account/deletion-status";

        if (user.isDeleting && !isDeletionRequest && !isDeletionStatusRequest) {
            return res.status(403).json({
                message: "Account deletion is pending. Retry account deletion to complete it.",
                code: "ACCOUNT_DELETION_PENDING"
            });
        }

        req.user = {
            userId: user._id.toString(),
            firebaseUid: user.firebaseUid,
            authTime: decoded.auth_time,
            isDeleting: user.isDeleting
        };
        next();
    } catch (error) {
        const knownIdentityError = [
            "EMAIL_NOT_VERIFIED",
            "EMAIL_MISMATCH",
            "AMBIGUOUS_EMAIL",
            "USERNAME_REQUIRED",
            "USERNAME_LINK_REQUIRED",
            "ACCOUNT_ALREADY_LINKED",
            "ACCOUNT_LINK_CONFLICT"
        ].includes(error.code);
        const duplicateKey = error.code === 11000;
        const expiredToken = error.code === "auth/id-token-expired";

        return res.status(401).json({
            message: knownIdentityError
                ? error.message
                : duplicateKey
                    ? "This account conflicts with an existing ChatSpace account. Contact support to resolve the link."
                    : expiredToken
                        ? "Firebase ID token has expired"
                        : "Invalid Firebase ID token",
            code: knownIdentityError ? error.code : duplicateKey ? "ACCOUNT_LINK_CONFLICT" : "AUTH_INVALID"
        });
    }
};

module.exports = authMiddleware;
