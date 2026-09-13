const LABELS = [
    { label: "御見積金額", priority: 120 },
    { label: "見積金額", priority: 115 },
    { label: "税込合計", priority: 110 },
    { label: "合計金額", priority: 105 },
    { label: "税込", priority: 100 },
    { label: "合計", priority: 90 },
    { label: "TOTAL", priority: 85 }
];
const AMOUNT = /(?:[¥￥]\s*)?([0-9０-９]{1,3}(?:[,，][0-9０-９]{3})+|[0-9０-９]{1,10})(?:\s*(円|JPY))?/iu;

const normalizeDigits = (value) => String(value || "").replace(/[０-９]/gu, (digit) => String.fromCharCode(digit.charCodeAt(0) - 0xfee0));
const parseYen = (value) => {
    const normalized = normalizeDigits(value).replace(/[,，\s]/gu, "");
    if (!/^\d{1,10}$/u.test(normalized)) return null;
    const amount = Number(normalized);
    return Number.isSafeInteger(amount) && amount > 0 && amount <= 9_999_999_999 ? amount : null;
};

const candidatesFromLines = (lines) => {
    const candidates = [];
    lines.forEach((line, lineIndex) => {
        const nextLine = lines[lineIndex + 1] || "";
        for (const definition of LABELS) {
            const escaped = definition.label.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
            // PDF text layers frequently split Japanese glyphs into separate
            // text items. Allow whitespace introduced between label glyphs,
            // while keeping ASCII labels on a strict word boundary.
            const labelPattern = /^[A-Z]+$/u.test(definition.label)
                ? `\\b${escaped}\\b`
                : [...escaped].join("\\s*");
            const expression = new RegExp(labelPattern, "giu");
            let labelMatch;
            while ((labelMatch = expression.exec(line))) {
                const sameLineTail = line.slice(labelMatch.index + labelMatch[0].length, labelMatch.index + labelMatch[0].length + 64);
                let amountMatch = sameLineTail.match(AMOUNT);
                let sameLine = true;
                let distance = amountMatch?.index ?? 999;
                if (!amountMatch) {
                    amountMatch = nextLine.slice(0, 64).match(AMOUNT);
                    sameLine = false;
                    distance = amountMatch?.index ?? 999;
                }
                if (!amountMatch || distance > 32) continue;
                const amount = parseYen(amountMatch[1]);
                if (amount == null) continue;
                const currencyMarked = /^[¥￥]/u.test(amountMatch[0].trim()) || Boolean(amountMatch[2]);
                const commaGrouped = /[,，]/u.test(amountMatch[1]);
                if (!currencyMarked && !commaGrouped && distance > 8) continue;
                candidates.push({
                    amount_minor: amount,
                    label: definition.label,
                    line: lineIndex + 1,
                    score: definition.priority + (sameLine ? 15 : 5) + (currencyMarked ? 8 : 0) + (commaGrouped ? 3 : 0) - Math.min(distance, 12)
                });
            }
        }
    });
    return candidates;
};

const extractEstimateAmountFromText = (value) => {
    const lines = String(value || "").replace(/\r\n?/gu, "\n").split("\n").map((line) => line.replace(/\s+/gu, " ").trim()).filter(Boolean);
    const found = candidatesFromLines(lines);
    if (!found.length) return { status: "NOT_FOUND", amount_minor: null, currency: "JPY", candidates: [] };
    const byAmount = new Map();
    for (const candidate of found) {
        const prior = byAmount.get(candidate.amount_minor);
        if (!prior || candidate.score > prior.score) byAmount.set(candidate.amount_minor, candidate);
    }
    const ranked = [...byAmount.values()].sort((left, right) => right.score - left.score || left.line - right.line);
    const top = ranked[0];
    const competing = ranked[1];
    const summary = ranked.slice(0, 5).map(({ amount_minor, label, line, score }) => ({ amount_minor, label, line, score }));
    if (competing && competing.score >= top.score - 8) {
        return { status: "AMBIGUOUS", amount_minor: null, currency: "JPY", candidates: summary };
    }
    return { status: "HIGH_CONFIDENCE", amount_minor: top.amount_minor, currency: "JPY", matched_label: top.label, candidates: summary };
};

let pdfJsPromise;
const pdfJs = async () => {
    if (!pdfJsPromise) pdfJsPromise = import("pdfjs-dist/legacy/build/pdf.mjs").then((module) => {
        module.GlobalWorkerOptions.workerSrc = require("node:url").pathToFileURL(require.resolve("pdfjs-dist/legacy/build/pdf.worker.mjs")).href;
        return module;
    });
    return pdfJsPromise;
};

const pdfTextLines = async (bytes) => {
    let task;
    try {
        const { getDocument } = await pdfJs();
        task = getDocument({ data: new Uint8Array(bytes), verbosity: 0, useWorkerFetch: false, useSystemFonts: false, disableFontFace: true, isEvalSupported: false });
        const document = await task.promise;
        const lines = [];
        for (let pageNumber = 1; pageNumber <= Math.min(document.numPages, 20); pageNumber += 1) {
            const page = await document.getPage(pageNumber);
            const content = await page.getTextContent();
            const rows = [];
            for (const item of content.items || []) {
                if (!item?.str) continue;
                const y = Number(item.transform?.[5] || 0);
                let row = rows.find((entry) => Math.abs(entry.y - y) < 1);
                if (!row) { row = { y, items: [] }; rows.push(row); }
                row.items.push(item);
            }
            rows.sort((left, right) => right.y - left.y);
            for (const row of rows) lines.push(row.items.sort((left, right) => Number(left.transform?.[4] || 0) - Number(right.transform?.[4] || 0)).map((item) => item.str).join(" "));
        }
        return lines;
    } finally {
        if (task) await task.destroy();
    }
};

const extractEstimateAmount = async (bytes) => {
    try {
        const lines = await pdfTextLines(bytes);
        return { ...extractEstimateAmountFromText(lines.join("\n")), page_text_available: lines.some((line) => line.trim()) };
    } catch {
        return { status: "NOT_FOUND", amount_minor: null, currency: "JPY", candidates: [], page_text_available: false };
    }
};

module.exports = { LABELS, extractEstimateAmount, extractEstimateAmountFromText, parseYen, pdfTextLines };
