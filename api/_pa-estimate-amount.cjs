const LABELS = [
    { label: "GRAND TOTAL", tier: "A", priority: 160 },
    { label: "合計（税込）", tier: "A", priority: 155 },
    { label: "御見積金額", tier: "A", priority: 150 },
    { label: "御見積額", tier: "A", priority: 148 },
    { label: "見積金額", tier: "A", priority: 147 },
    { label: "見積総額", tier: "A", priority: 146 },
    { label: "税込合計", tier: "A", priority: 144 },
    { label: "税込総額", tier: "A", priority: 142 },
    { label: "総合計", tier: "A", priority: 140 },
    { label: "合計金額", tier: "B", priority: 120 },
    { label: "税込", tier: "B", priority: 115 },
    { label: "合計", tier: "B", priority: 110 },
    { label: "TOTAL", tier: "B", priority: 105 }
];
const EXCLUDED_LABELS = ["税抜小計", "明細金額", "SUBTOTAL", "消費税", "値引額", "DISCOUNT", "単価", "税額", "TAX", "小計"];
const AMOUNT = /(?:[¥￥]\s*)?([0-9０-９]{1,3}(?:[,，][0-9０-９]{3})+|[0-9０-９]{1,10})(?:\s*(円|JPY))?/iu;

const normalizeDigits = (value) => String(value || "").replace(/[０-９]/gu, (digit) => String.fromCharCode(digit.charCodeAt(0) - 0xfee0));
const parseYen = (value) => {
    const normalized = normalizeDigits(value).replace(/[,，\s]/gu, "");
    if (!/^\d{1,10}$/u.test(normalized)) return null;
    const amount = Number(normalized);
    return Number.isSafeInteger(amount) && amount > 0 && amount <= 9_999_999_999 ? amount : null;
};
const escaped = (value) => value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
const labelPattern = (label) => {
    if (/^[A-Z ]+$/u.test(label)) return `(?<![A-Z])${escaped(label).replace(/ /gu, "\\s*")}(?![A-Z])`;
    return [...label].map((glyph) => /\s/u.test(glyph) ? "\\s*" : escaped(glyph)).join("\\s*");
};
const hasExcludedLabel = (value) => EXCLUDED_LABELS.some((label) => new RegExp(labelPattern(label), "iu").test(value));

const KNOWN_LABELS = [...LABELS.map((definition) => definition.label), ...EXCLUDED_LABELS];
const amountOccurrences = (line, start = 0, end = line.length) => {
    const section = line.slice(start, end);
    const expression = new RegExp(AMOUNT.source, `${AMOUNT.flags}g`);
    return [...section.matchAll(expression)].map((match) => ({
        amount_minor: parseYen(match[1]),
        currency_marked: /^[¥￥]/u.test(match[0].trim()) || Boolean(match[2]),
        comma_grouped: /[,，]/u.test(match[1]),
        index: start + (match.index || 0),
        raw: match[0]
    })).filter((match) => match.amount_minor != null && (match.currency_marked || match.comma_grouped));
};
const nextKnownLabelIndex = (line, after) => {
    let next = line.length;
    for (const label of KNOWN_LABELS) {
        const expression = new RegExp(labelPattern(label), "giu");
        let match;
        while ((match = expression.exec(line))) {
            if (match.index >= after && match.index < next) next = match.index;
        }
    }
    return next;
};
const amountForLabel = (lines, lineIndex, labelMatch) => {
    const line = lines[lineIndex];
    const labelEnd = labelMatch.index + labelMatch[0].length;
    const segmentEnd = nextKnownLabelIndex(line, labelEnd);
    const sameLine = amountOccurrences(line, labelEnd, segmentEnd).find((match) => match.index - labelEnd <= 32);
    if (sameLine) return { ...sameLine, same_line: true, distance: sameLine.index - labelEnd };

    const nextLine = lines[lineIndex + 1] || "";
    const nextAmounts = amountOccurrences(nextLine);
    if (!nextAmounts.length) return null;
    const nearest = nextAmounts.sort((left, right) => Math.abs(left.index - labelMatch.index) - Math.abs(right.index - labelMatch.index))[0];
    const distance = Math.abs(nearest.index - labelMatch.index);
    if (nextAmounts.length > 1 && distance > 32) return null;
    return { ...nearest, same_line: false, distance };
};

const labelledAmount = (lines, labels) => {
    for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
        const line = lines[lineIndex];
        for (const label of labels) {
            const match = new RegExp(labelPattern(label), "iu").exec(line);
            if (!match) continue;
            const amount = amountForLabel(lines, lineIndex, match);
            if (amount) return amount.amount_minor;
        }
    }
    return null;
};

const candidatesFromLines = (lines) => {
    const candidates = [];
    lines.forEach((line, lineIndex) => {
        for (const definition of LABELS) {
            const expression = new RegExp(labelPattern(definition.label), "giu");
            let labelMatch;
            while ((labelMatch = expression.exec(line))) {
                const amount = amountForLabel(lines, lineIndex, labelMatch);
                if (!amount) continue;
                candidates.push({ amount_minor: amount.amount_minor, label: definition.label, tier: definition.tier, line: lineIndex + 1,
                    score: definition.priority + (amount.same_line ? 15 : 5) + (amount.currency_marked ? 8 : 0) + (amount.comma_grouped ? 3 : 0) - Math.min(amount.distance, 12) });
            }
        }
    });
    return candidates;
};

const extractEstimateAmountFromText = (value) => {
    const lines = String(value || "").replace(/\r\n?/gu, "\n").split("\n")
        .map((line) => line.replace(/\t/gu, "    ").replace(/[\u00a0\u3000]/gu, " ").trimEnd())
        .filter((line) => line.trim());
    const found = candidatesFromLines(lines);
    const subtotal = labelledAmount(lines, ["税抜小計", "SUBTOTAL", "小計"]);
    const tax = labelledAmount(lines, ["消費税", "税額", "TAX"]);
    const diagnostic = { subtotal_minor: subtotal, tax_minor: tax, total_tax_included_minor: null };
    if (!found.length) return { status: "NOT_FOUND", amount_minor: null, currency: "JPY", candidates: [], ...diagnostic };
    const byAmount = new Map();
    for (const candidate of found) {
        const prior = byAmount.get(candidate.amount_minor);
        const arithmetic = subtotal != null && tax != null && subtotal + tax === candidate.amount_minor ? 12 : 0;
        const corroboration = found.filter((item) => item.tier === "A" && item.amount_minor === candidate.amount_minor).length > 1 ? 6 : 0;
        const scored = { ...candidate, score: candidate.score + arithmetic + corroboration };
        if (!prior || scored.score > prior.score) byAmount.set(candidate.amount_minor, scored);
    }
    const tierAAmounts = [...new Set(found.filter((candidate) => candidate.tier === "A").map((candidate) => candidate.amount_minor))];
    const ranked = [...byAmount.values()].sort((left, right) => right.score - left.score || left.line - right.line);
    const summary = ranked.slice(0, 5).map(({ amount_minor, label, tier, line, score }) => ({ amount_minor, label, tier, line, score }));
    if (tierAAmounts.length > 1) return { status: "AMBIGUOUS", amount_minor: null, currency: "JPY", candidates: summary, ...diagnostic };
    const top = tierAAmounts.length === 1 ? ranked.find((candidate) => candidate.amount_minor === tierAAmounts[0]) : ranked[0];
    const competing = ranked.find((candidate) => candidate.amount_minor !== top.amount_minor);
    if (!tierAAmounts.length && competing && competing.score >= top.score - 8) return { status: "AMBIGUOUS", amount_minor: null, currency: "JPY", candidates: summary, ...diagnostic };
    return { status: "HIGH_CONFIDENCE", amount_minor: top.amount_minor, currency: "JPY", matched_label: top.label, candidates: summary, ...diagnostic, total_tax_included_minor: top.amount_minor };
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
            for (const row of rows) {
                let line = "";
                for (const item of row.items.sort((left, right) => Number(left.transform?.[4] || 0) - Number(right.transform?.[4] || 0))) {
                    const targetColumn = Math.max(0, Math.round(Number(item.transform?.[4] || 0) / 4));
                    line += " ".repeat(Math.max(1, targetColumn - line.length)) + item.str;
                }
                lines.push(line);
            }
        }
        return lines;
    } finally { if (task) await task.destroy(); }
};
const extractEstimateAmount = async (bytes) => {
    try {
        const lines = await pdfTextLines(bytes);
        return { ...extractEstimateAmountFromText(lines.join("\n")), page_text_available: lines.some((line) => line.trim()) };
    } catch {
        return { status: "NOT_FOUND", amount_minor: null, currency: "JPY", candidates: [], page_text_available: false };
    }
};
module.exports = { LABELS, EXCLUDED_LABELS, candidatesFromLines, extractEstimateAmount, extractEstimateAmountFromText, parseYen, pdfTextLines, labelPattern, hasExcludedLabel };
