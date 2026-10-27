/* zip-lite.js - 极简 ZIP 打包 + 文件保存（替代 jszip / FileSaver 的 CDN 依赖）
 *
 * 背景：index.html 原来从 cdn.jsdelivr.net 加载 jszip 和 FileSaver，
 *       国内网络常常连不上，导出时就会报 "JSZip is not defined"。
 *       这里用本地实现替掉，不再依赖任何外网 CDN。
 *
 * 实现的接口（跟本 App 用到的 jszip 用法兼容）：
 *   var zip = new JSZip();
 *   var dir = zip.folder('汽运').folder('1.鲁Q297JE');
 *   dir.file('img_1.jpg', arrayBuffer);
 *   zip.generateAsync({type:'blob'}).then(function(blob){ ... });
 *   saveAs(blob, '汽运_2026-10-27.zip');
 *
 * 只用 STORE（不压缩）——照片本身已是 JPEG，压缩收益极小，和原来的
 * compression:'STORE' 行为一致。文件名按 UTF-8 编码（中文名不会乱码）。
 */
(function (global) {
    'use strict';

    /* ==================== CRC32 ==================== */
    var CRC_TABLE = null;

    function crcTable() {
        if (CRC_TABLE) return CRC_TABLE;
        var t = new Uint32Array(256);
        for (var n = 0; n < 256; n++) {
            var c = n;
            for (var k = 0; k < 8; k++) {
                c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
            }
            t[n] = c >>> 0;
        }
        CRC_TABLE = t;
        return t;
    }

    function crc32(bytes) {
        var t = crcTable();
        var crc = 0xFFFFFFFF;
        for (var i = 0; i < bytes.length; i++) {
            crc = (crc >>> 8) ^ t[(crc ^ bytes[i]) & 0xFF];
        }
        return (crc ^ 0xFFFFFFFF) >>> 0;
    }

    /* ==================== 字符串 / 字节 ==================== */
    function utf8Bytes(s) {
        if (global.TextEncoder) return new TextEncoder().encode(s);
        var out = [];
        for (var i = 0; i < s.length; i++) {
            var c = s.charCodeAt(i);
            if (c < 0x80) {
                out.push(c);
            } else if (c < 0x800) {
                out.push(0xC0 | (c >> 6), 0x80 | (c & 63));
            } else {
                out.push(0xE0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
            }
        }
        return new Uint8Array(out);
    }

    function toBytes(data) {
        if (data == null) return Promise.resolve(new Uint8Array(0));
        if (data instanceof Uint8Array) return Promise.resolve(data);
        if (data instanceof ArrayBuffer) return Promise.resolve(new Uint8Array(data));
        if (typeof data === 'string') return Promise.resolve(utf8Bytes(data));
        if (global.Blob && data instanceof global.Blob) {
            return new Promise(function (resolve, reject) {
                var fr = new FileReader();
                fr.onload = function () { resolve(new Uint8Array(fr.result)); };
                fr.onerror = function () { reject(new Error('读取文件失败')); };
                fr.readAsArrayBuffer(data);
            });
        }
        return Promise.resolve(new Uint8Array(0));
    }

    /* ==================== DOS 时间 ==================== */
    function dosDateTime(d) {
        var time = ((d.getHours() & 31) << 11) | ((d.getMinutes() & 63) << 5) | ((d.getSeconds() >> 1) & 31);
        var date = (((d.getFullYear() - 1980) & 127) << 9) | (((d.getMonth() + 1) & 15) << 5) | (d.getDate() & 31);
        return { time: time & 0xFFFF, date: date & 0xFFFF };
    }

    /* ==================== 打包 ==================== */
    /* list: [{path:'汽运/1.鲁Q297JE/a.jpg', bytes:Uint8Array}] */
    function buildZipBlob(list) {
        var dt = dosDateTime(new Date());
        var parts = [];
        var central = [];
        var offset = 0;
        var seenDir = {};

        function emit(nameStr, bytes, crc, isDir) {
            var nameBytes = utf8Bytes(nameStr);
            var size = isDir ? 0 : bytes.length;
            var flags = 0x0800;   /* bit 11：文件名按 UTF-8 */
            var method = 0;       /* 0 = 不压缩 */

            /* ---- 本地文件头 ---- */
            var lh = new Uint8Array(30 + nameBytes.length);
            var lv = new DataView(lh.buffer);
            lv.setUint32(0, 0x04034b50, true);
            lv.setUint16(4, 20, true);            /* version needed */
            lv.setUint16(6, flags, true);
            lv.setUint16(8, method, true);
            lv.setUint16(10, dt.time, true);
            lv.setUint16(12, dt.date, true);
            lv.setUint32(14, crc >>> 0, true);
            lv.setUint32(18, size, true);
            lv.setUint32(22, size, true);
            lv.setUint16(26, nameBytes.length, true);
            lv.setUint16(28, 0, true);            /* extra length */
            lh.set(nameBytes, 30);

            parts.push(lh);
            if (!isDir) parts.push(bytes);

            /* ---- 中央目录项 ---- */
            var cd = new Uint8Array(46 + nameBytes.length);
            var cv = new DataView(cd.buffer);
            cv.setUint32(0, 0x02014b50, true);
            cv.setUint16(4, 20, true);            /* version made by */
            cv.setUint16(6, 20, true);            /* version needed */
            cv.setUint16(8, flags, true);
            cv.setUint16(10, method, true);
            cv.setUint16(12, dt.time, true);
            cv.setUint16(14, dt.date, true);
            cv.setUint32(16, crc >>> 0, true);
            cv.setUint32(20, size, true);
            cv.setUint32(24, size, true);
            cv.setUint16(28, nameBytes.length, true);
            cv.setUint16(30, 0, true);            /* extra */
            cv.setUint16(32, 0, true);            /* comment */
            cv.setUint16(34, 0, true);            /* disk number */
            cv.setUint16(36, 0, true);            /* internal attrs */
            cv.setUint32(38, isDir ? 0x10 : 0, true);  /* external attrs：目录 */
            cv.setUint32(42, offset, true);       /* 本地头偏移 */
            cd.set(nameBytes, 46);
            central.push(cd);

            offset += lh.length + (isDir ? 0 : size);
        }

        for (var i = 0; i < list.length; i++) {
            var path = list[i].path;

            /* 自动补出父目录条目（解压时目录结构更规整） */
            var segs = path.split('/');
            var acc = '';
            for (var s = 0; s < segs.length - 1; s++) {
                acc += segs[s] + '/';
                if (!seenDir[acc]) {
                    seenDir[acc] = 1;
                    emit(acc, null, 0, true);
                }
            }

            var bytes = list[i].bytes;
            emit(path, bytes, crc32(bytes), false);
        }

        var cdSize = 0;
        for (var c = 0; c < central.length; c++) cdSize += central[c].length;

        var eocd = new Uint8Array(22);
        var ev = new DataView(eocd.buffer);
        ev.setUint32(0, 0x06054b50, true);
        ev.setUint16(4, 0, true);
        ev.setUint16(6, 0, true);
        ev.setUint16(8, central.length, true);
        ev.setUint16(10, central.length, true);
        ev.setUint32(12, cdSize, true);
        ev.setUint32(16, offset, true);
        ev.setUint16(20, 0, true);

        var all = parts.concat(central);
        all.push(eocd);
        return new Blob(all, { type: 'application/zip' });
    }

    /* ==================== JSZip 兼容壳 ==================== */
    function ZipNode(shared, prefix) {
        this._shared = shared || { files: [] };
        this._prefix = prefix || '';
    }

    ZipNode.prototype.folder = function (name) {
        var p = String(name).replace(/^\/+|\/+$/g, '');
        return new ZipNode(this._shared, this._prefix + p + '/');
    };

    ZipNode.prototype.file = function (name, data) {
        this._shared.files.push({ path: this._prefix + String(name), data: data });
        return this;
    };

    ZipNode.prototype.generateAsync = function () {
        var files = this._shared.files;
        var list = [];
        var chain = Promise.resolve();
        files.forEach(function (f) {
            chain = chain.then(function () {
                return toBytes(f.data).then(function (b) {
                    list.push({ path: f.path, bytes: b });
                });
            });
        });
        return chain.then(function () {
            if (!list.length) throw new Error('没有可打包的内容');
            return buildZipBlob(list);
        });
    };

    /* ==================== saveAs（FileSaver 兼容） ==================== */
    function saveAs(blob, filename) {
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url;
        a.download = filename || 'download';
        a.style.display = 'none';
        document.body.appendChild(a);
        try {
            a.click();
        } catch (e) {
            /* 少数老浏览器不支持 download 属性，退化成新窗口打开 */
            global.open(url, '_blank');
        }
        setTimeout(function () {
            URL.revokeObjectURL(url);
            if (a.parentNode) a.parentNode.removeChild(a);
        }, 60000);
    }

    global.JSZip = ZipNode;
    global.saveAs = saveAs;
    global.YcykZip = { build: buildZipBlob, crc32: crc32 };
})(typeof window !== 'undefined' ? window : this);
