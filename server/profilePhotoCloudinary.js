const PROFILE_FOLDER = "chatspace/profiles";
const ASSET_ID_PATTERN = /^[a-f\d]{32}$/i;
const OWNER_ID_PATTERN = /^[a-z\d_-]{1,64}$/i;

function createProfilePublicId(userId, assetId) {
    if (!OWNER_ID_PATTERN.test(String(userId)) || !ASSET_ID_PATTERN.test(String(assetId))) return null;
    return `${PROFILE_FOLDER}/${userId}/${assetId}`;
}

function getProfilePublicIdFromUrl(reference, cloudName, userId) {
    if (typeof reference !== "string" || !cloudName || !OWNER_ID_PATTERN.test(String(userId))) return null;
    let parsed;
    try {
        parsed = new URL(reference);
    } catch {
        return null;
    }
    if (parsed.protocol !== "https:" || parsed.hostname !== "res.cloudinary.com" || parsed.port ||
        parsed.username || parsed.password || parsed.search || parsed.hash) return null;

    let segments;
    try {
        segments = parsed.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    } catch {
        return null;
    }
    if (segments.shift() !== cloudName || segments.shift() !== "image" || segments.shift() !== "upload") return null;
    if (/^v\d+$/.test(segments[0] || "")) segments.shift();
    if (segments.length !== 4 || segments[0] !== "chatspace" || segments[1] !== "profiles" || segments[2] !== String(userId)) {
        return null;
    }
    const filename = segments[3];
    const assetId = filename.replace(/\.(?:jpe?g|png|webp)$/i, "");
    if (!ASSET_ID_PATTERN.test(assetId) || filename === assetId) return null;
    return createProfilePublicId(userId, assetId);
}

function getProfileAssetPublicId(reference, cloudName, userId) {
    return getProfilePublicIdFromUrl(reference, cloudName, userId);
}

module.exports = { PROFILE_FOLDER, createProfilePublicId, getProfileAssetPublicId, getProfilePublicIdFromUrl };
