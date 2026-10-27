/* ocr.js - 百度 OCR：汽车车牌 + 火车车皮号（7 位数字）自动识别
 *
 * 设计要点：
 * 1. 对外仍然只暴露 recognizePlate(blob, onProgress)，返回 {plate, type, error, quotaExceeded}
 *    —— app.js 不需要任何改动，界面不变。
 * 2. plate_first（默认）：先调「车牌识别」接口，汽车场景与旧版完全一致（零回归）；
 *    车牌识别失败时再调「通用文字识别（高精度版）」，从文字里判断是车牌还是 7 位车皮号。
 * 3. 若车牌识别返回额度用尽，不会直接报错，而是继续用通用文字识别兜底，
 *    避免「火车照片烧完车牌额度后汽车也不能用」。
 * 4. 车皮号只认「独立成串的连续 7 位数字」，并排除车型号(C70/X70)、载重(70t)、
 *    自重(23.5t)、换长(1.3)、定检日期等干扰。
 */

var _cachedToken = null;
var _tokenExpiry = 0;

/* ==================== 配置 ==================== */
/* 识别顺序：plate_first = 先车牌识别（汽车零变化，推荐）
 *           text_first  = 先通用文字识别（火车多时更省车牌额度） */
var OCR_ORDER = "plate_first";

var URL_PLATE = "https://aip.baidubce.com/rest/2.0/ocr/v1/license_plate";
var URL_TEXT = "https://aip.baidubce.com/rest/2.0/ocr/v1/accurate_basic";
var OCR_TIMEOUT_MS = 25000;

/* 省份简称：京津沪渝冀豫云辽黑湘皖鲁新苏浙赣鄂桂甘晋蒙陕吉闽贵粤青藏川宁琼
 * 这里用 \uXXXX 转义写死，避免文件编码/服务器 charset 出问题时把判定逻辑弄坏 */
var PLATE_PROVINCES = "\u4eac\u6d25\u6caa\u6e1d\u5180\u8c6b\u4e91\u8fbd\u9ed1\u6e58\u7696\u9c81\u65b0\u82cf\u6d59\u8d63\u9102\u6842\u7518\u664b\u8499\u9655\u5409\u95fd\u8d35\u7ca4\u9752\u85cf\u5ddd\u5b81\u743c";
/* 车牌中文后缀：挂 学 警 港 澳 领 使 */
var PLATE_SUFFIX = "\u6302\u5b66\u8b66\u6e2f\u6fb3\u9886\u4f7f";

/* 车皮号位数：恒定 7 位 */
var TRAIN_NO_DIGITS = 7;

/* 最近一次识别的原始返回，出问题时可在控制台执行 __ocrLastDebug 查看 */
var _lastDebug = null;

/* ==================== Token（与原逻辑一致） ==================== */
try {
    var saved = localStorage.getItem("baidu_token_v2");
    if (saved) {
        var parsed = JSON.parse(saved);
        if (parsed.token && parsed.expiry > Date.now()) {
            _cachedToken = parsed.token;
            _tokenExpiry = parsed.expiry;
        }
    }
} catch (e) {}

function getTokenConfig() {
    if (typeof BAIDU_CONFIG !== "undefined") return BAIDU_CONFIG;
    return { BUILTIN_TOKEN: "", TOKEN_PROXY_URL: "" };
}

async function getBaiduToken() {
    if (_cachedToken && Date.now() < _tokenExpiry) return _cachedToken;

    var cfg = getTokenConfig();

    if (cfg.TOKEN_PROXY_URL) {
        try {
            var resp = await fetch(cfg.TOKEN_PROXY_URL);
            if (resp.ok) {
                var data = await resp.json();
                if (data.access_token) return saveToken(data.access_token, data.expires_in || 2592000);
            }
        } catch (e) {
            console.log("OCR: token 代理失败，尝试内置 token");
        }
    }

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
    } catch (e) {}
    return token;
}

/* ==================== 纯函数：文字处理 ==================== */

/* 全角转半角 + 转大写，保留空白（数字判断要靠空白做边界） */
function toHalfWidth(s) {
    if (!s) return "";
    var out = "";
    for (var i = 0; i < s.length; i++) {
        var c = s.charCodeAt(i);
        if (c >= 0xFF01 && c <= 0xFF5E) {
            out += String.fromCharCode(c - 0xFEE0);
        } else if (c === 0x3000) {
            out += " ";
        } else {
            out += s.charAt(i);
        }
    }
    return out.toUpperCase();
}

/* 车牌用：在半角基础上再去掉空白和分隔点 */
function ocrNormalize(s) {
    return toHalfWidth(s).replace(/[\s·•・.:：\-_/\\|]/g, "");
}

/* 找出字符串里所有「独立成串」的 n 位数字（前后都不许再是数字）
 * 不用正则 lookbehind，兼容老 WebView */
function findDigitRuns(str, n) {
    var res = [];
    if (!str) return res;
    var i = 0, len = str.length;
    while (i < len) {
        if (!(str.charAt(i) >= "0" && str.charAt(i) <= "9")) { i++; continue; }
        var j = i;
        while (j < len && str.charAt(j) >= "0" && str.charAt(j) <= "9") j++;
        if (j - i === n) res.push(str.substring(i, j));
        i = j;
    }
    return res;
}

/* 判断一段文字是不是车牌号 */
function matchPlate(s) {
    var t = ocrNormalize(s);
    if (!t || t.length < 7) return null;

    var cands = [];

    for (var i = 0; i < t.length; i++) {
        if (PLATE_PROVINCES.indexOf(t.charAt(i)) < 0) continue;

        /* 省份 + 字母 + 5~6 位字母数字（7 位普通牌 / 8 位新能源牌） */
        for (var coreLen = 7; coreLen <= 8; coreLen++) {
            if (i + coreLen > t.length) continue;
            var core = t.substring(i, i + coreLen);
            var letter = core.charAt(1);
            if (!(letter >= "A" && letter <= "Z")) continue;
            var tail = core.substring(2);
            if (!/^[A-Z0-9]+$/.test(tail)) continue;
            if (tail.length !== 5 && tail.length !== 6) continue;

            var end = i + coreLen;
            if (end < t.length && PLATE_SUFFIX.indexOf(t.charAt(end)) >= 0) end++;
            cands.push({ value: t.substring(i, end), start: i, end: end });
        }

        /* 挂车等：省份 + 字母 + 4 位字母数字 + 中文后缀 */
        if (i + 7 <= t.length && PLATE_SUFFIX.indexOf(t.charAt(i + 6)) >= 0) {
            var c6 = t.substring(i, i + 6);
            if (/^[A-Z][A-Z0-9]{4}$/.test(c6.substring(1))) {
                cands.push({ value: t.substring(i, i + 7), start: i, end: i + 7 });
            }
        }
    }

    if (!cands.length) return null;

    /* 优先「正好顶到文字结尾」的候选（车牌通常独立成一整块），其次取较短的 */
    cands.sort(function (a, b) {
        var at = (a.end === t.length) ? 0 : 1;
        var bt = (b.end === t.length) ? 0 : 1;
        if (at !== bt) return at - bt;
        if (a.value.length !== b.value.length) return a.value.length - b.value.length;
        return a.start - b.start;
    });
    return cands[0].value;
}

/* 从一段文字里取车皮号候选（仅 7 位独立数字）
 * 先在原串上找「独立成串」的 7 位数字（空白就是边界，所以不会把相邻数字粘起来）；
 * 找不到时才尝试拼接被空格分开的纯数字片段，且要求拼出来刚好 7 位、前一段至少 3 位，
 * 这样「载重 70」+「12345」这类不会被误拼。 */
function matchTrainNo(s) {
    if (!s) return null;

    var t = toHalfWidth(s);

    var direct = findDigitRuns(t, TRAIN_NO_DIGITS);
    if (direct.length) return direct[0];

    var tokens = t.split(/\s+/);
    var nums = [];
    for (var i = 0; i < tokens.length; i++) {
        var tk = tokens[i];
        if (tk && /^[0-9]+$/.test(tk)) nums.push(tk);
    }
    for (var j = 0; j + 1 < nums.length; j++) {
        if (nums[j].length >= 3 && nums[j].length + nums[j + 1].length === TRAIN_NO_DIGITS) {
            return nums[j] + nums[j + 1];
        }
    }
    return null;
}

/* 文字块面积 / 高度，用于多个候选时挑最像的（通常车号字最大） */
function blockScore(w) {
    var loc = w && w.location;
    if (!loc) return 0;
    var h = loc.height || 0;
    var area = (loc.width || 0) * (loc.height || 0);
    return h * 1000 + area;
}

/* 车号被漆在两块车皮板上时，OCR 会拆成两个纯数字块（例如 3421 + 462 = 3421462）。
 * 只在整图找不到现成 7 位数字时才用，且要求前段 >=3 位、后段 >=2 位、拼起来正好 7 位，
 * 这样「载重/自重/换长」这类数字不会被误拼。 */
function joinAdjacentDigitBlocks(wordsResult) {
    if (!wordsResult || wordsResult.length < 2) return null;
    var nums = [];
    for (var i = 0; i < wordsResult.length; i++) {
        var t = toHalfWidth((wordsResult[i] && wordsResult[i].words) || "").trim();
        nums.push(/^[0-9]+$/.test(t) ? t : null);
    }
    for (var j = 0; j + 1 < nums.length; j++) {
        var a = nums[j], b = nums[j + 1];
        if (!a || !b) continue;
        if (a.length >= 3 && b.length >= 2 && a.length + b.length === TRAIN_NO_DIGITS) {
            return a + b;
        }
    }
    return null;
}

/* 从「通用文字识别」的 words_result 里判断是车牌还是车皮号 */
function classifyWords(wordsResult) {
    var out = { plate: null, trainNo: null };
    if (!wordsResult || !wordsResult.length) return out;

    /* 1) 车牌：任意一个文字块里出现合法车牌就认 */
    for (var i = 0; i < wordsResult.length; i++) {
        var p = matchPlate(wordsResult[i] && wordsResult[i].words);
        if (p) { out.plate = p; break; }
    }
    if (out.plate) return out;

    /* 2) 车皮号：取「字号最大」的那个 7 位数字 */
    var best = null, bestScore = -1;
    for (var j = 0; j < wordsResult.length; j++) {
        var w = wordsResult[j];
        var no = matchTrainNo(w && w.words);
        if (!no) continue;
        var score = blockScore(w);
        /* 纯数字文字块加分，避免从长句里抠出来的误判 */
        var plain = /^[0-9]+$/.test(ocrNormalize(w.words || ""));
        if (plain) score += 100000000;
        if (score > bestScore) { bestScore = score; best = no; }
    }

    /* 3) 兜底：跨文字块拼接（车号分漆在两块车皮板上的情况） */
    if (!best) best = joinAdjacentDigitBlocks(wordsResult);

    out.trainNo = best;
    return out;
}

/* ==================== 网络请求 ==================== */

async function baiduPost(url, token, b64, extra) {
    var body = "image=" + encodeURIComponent(b64);
    if (extra) body += extra;

    var controller = new AbortController();
    var timer = setTimeout(function () { controller.abort(); }, OCR_TIMEOUT_MS);
    try {
        var resp = await fetch(url + "?access_token=" + token, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: body,
            signal: controller.signal
        });
        clearTimeout(timer);
        return await resp.json();
    } catch (e) {
        clearTimeout(timer);
        if (e && e.name === "AbortError") throw new Error("识别超时，请检查网络");
        if (e && e.message === "Failed to fetch") throw new Error("网络连接失败，请检查网络");
        throw e;
    }
}

/* 图片超过这个大小才压缩。
 * App 内拍照出来就是 1600px、300~400KB，再走一遍 canvas 压缩毫无收益，
 * 而 WebView 里 canvas 解码+编码要 4 秒左右（是识别耗时的大头），所以直接跳过。
 * 相册里的大图（几 MB）仍然压缩到 1200px / 0.85。 */
var OCR_SKIP_COMPRESS_BYTES = 1500 * 1024;

/* 把图片压成 1200px / 0.85 的 JPEG，再转 base64 */
async function prepareImage(imageBlob, onProgress) {
    if (onProgress) onProgress(0.05);

    var prepared = imageBlob;
    if (!imageBlob || imageBlob.size > OCR_SKIP_COMPRESS_BYTES) {
        prepared = await compressImage(imageBlob, 1200, 0.85);
    }
    if (!prepared || prepared.size < 100) throw new Error("图片处理失败");
    if (onProgress) onProgress(0.15);

    var dataUrl = await toBase64(prepared);
    var parts = dataUrl.split(",");
    var b64 = parts.length > 1 ? parts[1] : parts[0];
    if (!b64 || b64.length < 10) throw new Error("图片处理失败");
    if (onProgress) onProgress(0.25);
    return b64;
}

/* 优先用 db.js 里的 blobToBase64；没有就自己转，避免依赖丢失导致整条链路挂死 */
function toBase64(blob) {
    if (typeof blobToBase64 === "function") return blobToBase64(blob);
    return new Promise(function (resolve, reject) {
        var fr = new FileReader();
        fr.onloadend = function () { resolve(fr.result); };
        fr.onerror = function () { reject(new Error("图片处理失败")); };
        fr.readAsDataURL(blob);
        setTimeout(function () { reject(new Error("图片处理超时")); }, 8000);
    });
}

/* 车牌接口原样返回、但不符合车牌规则的值（车皮号照片很常见：百度会把 7 位数字当车牌返回）。
 * 不当场采用，先让「通用文字识别」给出完整判断，实在没有结果时才用它兜底。 */
var _plateRaw = null;

/* 调车牌识别：识别到返回 {plate,type}；没识别到返回 null；额度用尽抛 quota_exceeded */
async function callPlateApi(b64, token) {
    var r = await baiduPost(URL_PLATE, token, b64, "");
    _lastDebug = { api: "license_plate", result: r };

    if (r.error_code) {
        if (r.error_code === 17 || r.error_code === 18) throw new Error("quota_exceeded");
        if (r.error_code === 110 || r.error_code === 111) throw new Error("OCR授权失效，请检查百度配置");
        /* 282xxx = target recognize error：图里没有车牌，属于车皮号照片的正常情况 */
        if (r.error_code >= 282000 && r.error_code < 283000) return null;
        console.log("OCR plate error:", r.error_code, r.error_msg);
        return null;
    }

    var num = (r.words_result && r.words_result.number) || "";
    if (!num) return null;

    if (matchPlate(num)) {
        return { plate: num, type: "car", source: "plate" };
    }

    /* 返回了内容但不像车牌（例如把车皮号当车牌）——记下来兜底，不直接采用 */
    _plateRaw = ocrNormalize(num) || num;
    return null;
}

/* 调通用文字识别：返回 {plate,type} 或 null */
async function callTextApi(b64, token) {
    var r = await baiduPost(URL_TEXT, token, b64, "&detect_direction=true");
    _lastDebug = { api: "accurate_basic", result: r };

    if (r.error_code) {
        if (r.error_code === 17 || r.error_code === 18) throw new Error("quota_exceeded");
        console.log("OCR text error:", r.error_code, r.error_msg);
        return null;
    }
    var words = r.words_result || [];
    var c = classifyWords(words);
    if (c.plate) return { plate: c.plate, type: "car", source: "text" };
    if (c.trainNo) return { plate: c.trainNo, type: "train", source: "text" };
    return null;
}

/* ==================== 对外入口 ==================== */

async function recognizePlate(imageBlob, onProgress) {
    try {
        var b64 = await prepareImage(imageBlob, onProgress);

        var token;
        try {
            token = await getBaiduToken();
        } catch (e) {
            return { plate: "", error: "未配置百度OCR" };
        }
        if (onProgress) onProgress(0.4);

        var quotaHit = false;
        var order = (OCR_ORDER === "text_first") ? ["text", "plate"] : ["plate", "text"];
        var lastError = null;
        _plateRaw = null;

        for (var i = 0; i < order.length; i++) {
            if (onProgress) onProgress(0.4 + i * 0.25);
            try {
                var got = (order[i] === "plate")
                    ? await callPlateApi(b64, token)
                    : await callTextApi(b64, token);
                if (got && got.plate) {
                    if (onProgress) onProgress(1);
                    return got;
                }
            } catch (e) {
                if (e.message === "quota_exceeded") { quotaHit = true; continue; }
                lastError = e;
            }
        }

        if (onProgress) onProgress(1);

        /* 车牌接口给过值、只是不合车牌规则：作为最后兜底（车皮号常见） */
        if (_plateRaw) {
            var isTrain = (findDigitRuns(toHalfWidth(_plateRaw), TRAIN_NO_DIGITS).length === 1);
            return { plate: _plateRaw, type: isTrain ? "train" : "car", source: "plate_raw" };
        }

        /* 两个接口都试过还没结果 */
        if (quotaHit && lastError) return { plate: "", error: lastError.message };
        if (quotaHit) return { plate: "", quotaExceeded: true };
        if (lastError) return { plate: "", error: lastError.message };
        return { plate: "", error: "识别失败，请手动输入" };

    } catch (e) {
        return { plate: "", error: (e && e.message) ? e.message : "识别失败，请手动输入" };
    }
}

/* ==================== 图片压缩（原逻辑保留） ==================== */
function compressImage(blob, maxSize, quality) {
    return new Promise(function (resolve) {
        var img = new Image();
        var url = URL.createObjectURL(blob);
        var resolved = false;
        var done = function (r) {
            if (!resolved) { resolved = true; URL.revokeObjectURL(url); resolve(r); }
        };
        img.onload = function () {
            var w = img.width, h = img.height;
            if (w > maxSize || h > maxSize) {
                var ratio = maxSize / Math.max(w, h);
                w = Math.round(w * ratio); h = Math.round(h * ratio);
            }
            var c = document.createElement("canvas");
            c.width = w; c.height = h;
            c.getContext("2d").drawImage(img, 0, 0, w, h);
            c.toBlob(function (r) { done(r && r.size > 0 ? r : blob); }, "image/jpeg", quality);
        };
        img.onerror = function () { done(blob); };
        setTimeout(function () { done(blob); }, 10000);
        img.src = url;
    });
}
