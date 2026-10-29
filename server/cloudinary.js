const cloudinary = require("cloudinary").v2;

const cloudName = process.env.CLOUDINARY_CLOUD_NAME?.trim();
const apiKey = process.env.CLOUDINARY_API_KEY?.trim();
const apiSecret = process.env.CLOUDINARY_API_SECRET?.trim();
const providedValues = [cloudName, apiKey, apiSecret].filter(Boolean).length;

if (providedValues > 0 && providedValues < 3) {
    throw new Error("Configure CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, and CLOUDINARY_API_SECRET together.");
}

if (providedValues === 3) {
    cloudinary.config({ cloud_name: cloudName, api_key: apiKey, api_secret: apiSecret, secure: true });
}

module.exports = {
    cloudinary: providedValues === 3 ? cloudinary : null,
    cloudName: providedValues === 3 ? cloudName : null
};
