const CONTROL_OR_PATH = /[\p{Cc}\\/]/gu;

const safeOriginalFilename = (value) => {
    const cleaned = String(value || "attachment").replace(CONTROL_OR_PATH, "_");
    const filename = [...cleaned].slice(0, 255).join("");
    return filename.trim() && filename !== "." && filename !== ".." ? filename : "attachment";
};

const decodeBytes = (bytes, charset) => {
    const encoding = String(charset || "utf-8").trim().toLowerCase();
    try {
        return new TextDecoder(encoding, { fatal: true }).decode(bytes);
    } catch {
        try { return Buffer.from(bytes).toString(encoding === "iso-8859-1" || encoding === "latin1" ? "latin1" : "utf8"); }
        catch { return ""; }
    }
};

const decodePercentBytes = (value) => {
    const bytes = [];
    for (let index = 0; index < value.length;) {
        const encoded = value.slice(index).match(/^%([0-9a-f]{2})/iu);
        if (encoded) {
            bytes.push(Number.parseInt(encoded[1], 16));
            index += 3;
            continue;
        }
        const plain = Buffer.from(value[index], "utf8");
        bytes.push(...plain);
        index += 1;
    }
    return Uint8Array.from(bytes);
};

const decodeExtendedValue = (value) => {
    const raw = String(value || "").trim();
    const match = raw.match(/^([^']*)'[^']*'(.*)$/su);
    const charset = match?.[1] || "utf-8";
    const encoded = match?.[2] ?? raw;
    try { return decodeBytes(decodePercentBytes(encoded), charset) || raw; }
    catch { return raw; }
};

const decodeMimeWords = (value) => {
    const raw = String(value || "");
    let matched = false;
    const decoded = raw.replace(/=\?([^?\s]+)\?([bq])\?([^?]*)\?=/giu, (_word, charset, kind, body) => {
        try {
            const bytes = kind.toLowerCase() === "b"
                ? Buffer.from(body, "base64")
                : Buffer.from(body.replace(/_/gu, " ").replace(/=([0-9a-f]{2})/giu, (_token, hex) => String.fromCharCode(Number.parseInt(hex, 16))), "latin1");
            const result = decodeBytes(bytes, charset);
            if (!result) return _word;
            matched = true;
            return result;
        } catch {
            return _word;
        }
    });
    return matched ? decoded.replace(/(?<=[^\x00-\x7f])\s+(?=[^\x00-\x7f])/gu, "") : raw;
};

const parseParameters = (headerValue) => {
    const parameters = new Map();
    const source = String(headerValue || "").replace(/\r?\n[ \t]+/gu, " ");
    const expression = /;\s*([^=;\s]+)\s*=\s*(?:"((?:\\.|[^"])*)"|([^;]*))/gu;
    let match;
    while ((match = expression.exec(source))) {
        const key = match[1].toLowerCase();
        const value = match[2] === undefined ? String(match[3] || "").trim() : match[2].replace(/\\(["\\])/gu, "$1");
        parameters.set(key, value);
    }
    return parameters;
};

const decodedParameter = (headerValue, name) => {
    const parameters = parseParameters(headerValue);
    const key = String(name).toLowerCase();
    if (parameters.has(`${key}*`)) return decodeMimeWords(decodeExtendedValue(parameters.get(`${key}*`)));
    const pieces = [];
    for (let index = 0; parameters.has(`${key}*${index}`) || parameters.has(`${key}*${index}*`); index += 1) {
        const encoded = parameters.has(`${key}*${index}*`);
        pieces.push({ encoded, value: parameters.get(encoded ? `${key}*${index}*` : `${key}*${index}`) });
    }
    if (pieces.length) {
        const joined = pieces.map((piece) => piece.value).join("");
        return decodeMimeWords(pieces.some((piece) => piece.encoded) ? decodeExtendedValue(joined) : joined);
    }
    return parameters.has(key) ? decodeMimeWords(parameters.get(key)) : "";
};

const partHeaders = (part) => Object.fromEntries((part?.headers || []).map((header) => [
    String(header?.name || "").toLowerCase(), String(header?.value || "")
]));

const originalFilenameFromPart = (part) => {
    const headers = partHeaders(part);
    const apiFilename = decodeMimeWords(part?.filename || "");
    const headerFilename = decodedParameter(headers["content-disposition"], "filename")
        || decodedParameter(headers["content-type"], "name");
    const apiHasUnicode = /[^\x00-\x7f]/u.test(apiFilename);
    const headerHasUnicode = /[^\x00-\x7f]/u.test(headerFilename);
    if (apiHasUnicode) return safeOriginalFilename(apiFilename);
    // Gmail sometimes exposes only an ASCII compatibility name in the payload
    // while retaining the real Unicode name in the MIME parameters. A decoded
    // Unicode MIME value is more faithful whenever the API value is not itself
    // Unicode; an API-provided Unicode name still has first priority above.
    if (headerHasUnicode) return safeOriginalFilename(headerFilename);
    if (apiFilename) return safeOriginalFilename(apiFilename);
    if (headerFilename) return safeOriginalFilename(headerFilename);
    return null;
};

const encodeMimeParameterValue = (value) => encodeURIComponent(value)
    .replace(/[!'()*]/gu, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);

const extendedMimeParameter = (name, value) => {
    const encoded = encodeMimeParameterValue(value);
    const tokens = encoded.match(/%[0-9A-F]{2}|./gu) || [];
    const segments = [];
    let segment = "";
    for (const token of tokens) {
        if (segment && segment.length + token.length > 48) {
            segments.push(segment);
            segment = "";
        }
        segment += token;
    }
    if (segment || !segments.length) segments.push(segment);
    if (segments.length === 1) return `${name}*=UTF-8''${segments[0]}`;
    return segments.map((part, index) => `${name}*${index}*=${index === 0 ? "UTF-8''" : ""}${part}`).join(";\r\n ");
};

const asciiFallback = (value) => {
    const filename = safeOriginalFilename(value);
    const extension = filename.match(/\.[A-Za-z0-9]{1,12}$/u)?.[0] || "";
    const stem = filename.slice(0, extension ? -extension.length : undefined).normalize("NFKD")
        .replace(/[^A-Za-z0-9._ -]/gu, "").replace(/\s+/gu, " ").trim().slice(0, 80);
    return `${stem || "attachment"}${extension}`.replace(/["\\]/gu, "_");
};

const attachmentFilenameParameters = (name, value) => {
    const filename = safeOriginalFilename(value);
    const extended = extendedMimeParameter(name, filename);
    if (!/^[\x20-\x7e]+$/u.test(filename) || filename.length > 50) return extended;
    return `${name}="${filename.replace(/["\\]/gu, "_")}";\r\n ${extended}`;
};

const attachmentContentDisposition = (value) => {
    const filename = safeOriginalFilename(value);
    const extended = `filename*=UTF-8''${encodeMimeParameterValue(filename)}`;
    if (!/^[\x20-\x7e]+$/u.test(filename)) return `attachment; ${extended}`;
    return 'attachment; filename="' + filename.replace(/["\\]/gu, "_") + '"; ' + extended;
};

module.exports = {
    asciiFallback,
    attachmentContentDisposition,
    attachmentFilenameParameters,
    decodeExtendedValue,
    decodeMimeWords,
    decodedParameter,
    originalFilenameFromPart,
    safeOriginalFilename
};
