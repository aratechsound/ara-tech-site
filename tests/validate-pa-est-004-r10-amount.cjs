const assert = require("node:assert/strict");
const { PDFDocument, StandardFonts } = require("pdf-lib");
const amount = require("../api/_pa-estimate-amount.cjs");

const high = (text, expected) => {
    const result = amount.extractEstimateAmountFromText(text);
    assert.equal(result.status, "HIGH_CONFIDENCE", text);
    assert.equal(result.amount_minor, expected, text);
};
high("御見積金額 ¥170,500", 170500);
high("見積金額 170,500円", 170500);
high("税込 192,500円", 192500);
high("小計 150,000円 消費税 15,000円 合計 165,000円", 165000);
high("御見積金額 ￥１７０，５００", 170500);
high("御 見 積 金 額  ￥170,500", 170500);
high("TOTAL 170,500 JPY", 170500);

const multiple = amount.extractEstimateAmountFromText("見積金額 A 170,500円\n見積金額 B 192,500円");
assert.equal(multiple.status, "AMBIGUOUS");
assert.deepEqual(multiple.candidates.map((item) => item.amount_minor), [170500, 192500]);
assert.equal(amount.extractEstimateAmountFromText("明細 100,000円\n消費税 10,000円").status, "NOT_FOUND");

(async () => {
    const document = await PDFDocument.create();
    const font = await document.embedFont(StandardFonts.Helvetica);
    const page = document.addPage([595, 842]);
    page.drawText("SUBTOTAL JPY 155,000", { x: 50, y: 760, size: 12, font });
    page.drawText("TAX JPY 15,500", { x: 50, y: 730, size: 12, font });
    page.drawText("TOTAL JPY 170,500", { x: 50, y: 700, size: 16, font });
    const extracted = await amount.extractEstimateAmount(Buffer.from(await document.save()));
    assert.equal(extracted.status, "HIGH_CONFIDENCE");
    assert.equal(extracted.amount_minor, 170500);

    const imageOnly = await PDFDocument.create();
    imageOnly.addPage([595, 842]);
    const notFound = await amount.extractEstimateAmount(Buffer.from(await imageOnly.save()));
    assert.equal(notFound.status, "NOT_FOUND");
    assert.equal(notFound.amount_minor, null);
    console.log("PASS PA-EST-004R10 amount extraction: labelled Japanese/JPY, subtotal-tax-total, ambiguity, no-label and image-only fallback");
})().catch((error) => { console.error(error); process.exitCode = 1; });
