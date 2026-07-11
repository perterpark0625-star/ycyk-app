/* ocr.js - ??OCR?????????API? */

var _cachedToken = null;
var _tokenExpiry = 0;

// Load saved token from localStorage
try {
    var saved = localStorage.getItem("baidu_token_v2");
    if (saved) {
        var parsed = JSON.parse(saved);
        if (parsed.token && parsed.expiry > Date.now()) {
            _cachedToken = parsed.token;
            _tokenExpiry = parsed.expiry;
        }
    }
} catch(e) {}

function getTokenConfig() {
    // BAIDU_CONFIG is defined in config.js
    if (typeof BAIDU_CONFIG !== "undefined") {
        return BAIDU_CONFIG;
    }
    return { BUILTIN_TOKEN: "", TOKEN_PROXY_URL: "" };
}

async function getBaiduToken() {
    if (_cachedToken && Date.now() < _tokenExpiry) {
        return _cachedToken;
    }
    
    var cfg = getTokenConfig();
    
    // Try proxy if configured
    if (cfg.TOKEN_PROXY_URL) {
        try {
            var resp = await fetch(cfg.TOKEN_PROXY_URL);
            if (resp.ok) {
                var data = await resp.json();
                if (data.access_token) {
                    return saveToken(data.access_token, data.expires_in);
                }
            }
        } catch(e) {
            console.log("OCR: proxy failed, trying builtin");
        }
    }
    
    // Use builtin token
    if (cfg.BUILTIN_TOKEN) {
        _cachedToken = cfg.BUILTIN_TOKEN;
        _tokenExpiry = Date.now() + 29 * 86400 * 1000;
        return cfg.BUILTIN_TOKEN;
    }
    
    throw new Error("no_config");
}

function saveToken(token, expiresIn) {
    _cachedToken = token;
    _tokenExpiry = Date.now() + (expiresIn - 300) * 1000;
    try {
        localStorage.setItem("baidu_token_v2", JSON.stringify({
            token: token, expiry: _tokenExpiry
        }));
    } catch(e) {}
    return token;
}

async function recognizePlate(imageBlob, onProgress) {
    try {
        var result = await tryBaiduOCR(imageBlob, onProgress);
        if (result && result.plate) return result;
        return {plate: "", error: "???????"};
    } catch(e) {
        if (e.message === "quota_exceeded") return {plate: "", quotaExceeded: true};
        if (e.message === "no_config") return {plate: "", error: "?????OCR"};
        return {plate: "", error: e.message || "?????????"};
    }
}

async function tryBaiduOCR(imageBlob, onProgress) {
    if (onProgress) onProgress(0.05);

    var compressed = await compressImage(imageBlob, 1200, 0.85);
    if (onProgress) onProgress(0.1);

    if (!compressed || compressed.size < 100) {
        throw new Error("??????");
    }

    var dataUrl;
    try { dataUrl = await blobToBase64(compressed); }
    catch(e) { throw new Error("??????"); }

    var parts = dataUrl.split(",");
    var b64 = parts.length > 1 ? parts[1] : parts[0];
    if (!b64 || b64.length < 10) throw new Error("??????");

    if (onProgress) onProgress(0.2);

    var token;
    try { token = await getBaiduToken(); }
    catch(e) { throw new Error("Token????"); }
    
    if (onProgress) onProgress(0.4);

    var baiduUrl = "https://aip.baidubce.com/rest/2.0/ocr/v1/license_plate?access_token=" + token;
    var formBody = "image=" + encodeURIComponent(b64);
    
    var controller = new AbortController();
    var timer = setTimeout(function() { controller.abort(); }, 30000);

    try {
        var resp = await fetch(baiduUrl, {
            method: "POST",
            headers: {"Content-Type": "application/x-www-form-urlencoded"},
            body: formBody,
            signal: controller.signal
        });
        clearTimeout(timer);
        console.log("OCR: status=" + resp.status);

        var result = await resp.json();
        console.log("OCR: " + JSON.stringify(result).substring(0, 200));
        if (onProgress) onProgress(1.0);

        if (result.error_code) {
            if (result.error_code === 17 || result.error_code === 18) throw new Error("quota_exceeded");
            throw new Error("??OCR????");
        }
        if (result.words_result && result.words_result.number) {
            return {plate: result.words_result.number, confidence: 0.99, rawText: result.words_result.number};
        }
        throw new Error("??????");
    } catch(e) {
        clearTimeout(timer);
        if (e.name === "AbortError") throw new Error("????");
        if (e.message === "quota_exceeded") throw e;
        if (e.message === "??????") throw e;
        if (e.message && e.message.indexOf("??OCR") === 0) throw e;
        if (e.message === "Failed to fetch") throw new Error("??????");
        throw e;
    }
}

function compressImage(blob, maxSize, quality) {
    return new Promise(function(resolve) {
        var img = new Image();
        var url = URL.createObjectURL(blob);
        var resolved = false;
        var done = function(r) {
            if (!resolved) { resolved = true; URL.revokeObjectURL(url); resolve(r); }
        };
        img.onload = function() {
            var w = img.width, h = img.height;
            if (w > maxSize || h > maxSize) {
                var ratio = maxSize / Math.max(w, h);
                w = Math.round(w * ratio); h = Math.round(h * ratio);
            }
            var c = document.createElement("canvas");
            c.width = w; c.height = h;
            c.getContext("2d").drawImage(img, 0, 0, w, h);
            c.toBlob(function(r) { done(r && r.size > 0 ? r : blob); }, "image/jpeg", quality);
        };
        img.onerror = function() { done(blob); };
        setTimeout(function() { done(blob); }, 10000);
        img.src = url;
    });
}
