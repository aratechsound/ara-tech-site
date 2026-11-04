const imageExtensions = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

export const validateFlyerFile = async (file, decode = (value) => createImageBitmap(value)) => {
    const extension = imageExtensions[file?.type];
    if (!extension || !file.size || file.size > 10 * 1024 * 1024) {
        throw new Error('画像は10MB以下のPNG/JPG/WebPを選択してください。');
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    const signatureMatches = file.type === 'image/jpeg'
        ? bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
        : file.type === 'image/png'
            ? [137, 80, 78, 71, 13, 10, 26, 10].every((byte, index) => bytes[index] === byte)
            : String.fromCharCode(...bytes.slice(0, 4)) === 'RIFF'
                && String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP';
    if (!signatureMatches) throw new Error('画像の形式と内容が一致しません。');
    let decoded;
    try {
        decoded = await decode(file);
        if (!(decoded.width > 0 && decoded.height > 0)) throw new Error();
    } catch {
        throw new Error('画像を読み込めません。正しい画像ファイルを選択してください。');
    } finally {
        decoded?.close();
    }
    return extension;
};

// A source URL records provenance; it is not evidence of a third-party licence.
export const imageSourceUrl = (value) => {
    if (!value) return null;
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password) {
        throw new Error('画像の出典にはHTTPSの公式URLを入力してください。');
    }
    return url.href;
};
