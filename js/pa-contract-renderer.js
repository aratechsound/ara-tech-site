(() => {
    "use strict";
    const byId = (id) => document.getElementById(id);
    const date = (value) => new Date(`${value}T00:00:00Z`).toLocaleDateString("ja-JP", { timeZone: "UTC", year: "numeric", month: "long", day: "numeric", weekday: "short" });
    const money = (value, currency = "JPY") => `${new Intl.NumberFormat("ja-JP", { style: "currency", currency, currencyDisplay: "symbol", maximumFractionDigits: 0 }).format(Number(value))}（税込）`;
    const short = (value) => { const [year, month, day] = String(value).split("-"); return `${year}/${month}/${day}`; };
    const withHonorific = (value) => /様\s*$/u.test(String(value || "")) ? String(value) : `${String(value || "")} 様`;
    const addPair = (root, label, value) => { const term = document.createElement("dt"), description = document.createElement("dd"); term.textContent = label; description.textContent = value || "—"; root.append(term, description); };
    const fill = (snapshot) => {
        const event = snapshot.case, customer = snapshot.customer, estimate = snapshot.estimate, terms = snapshot.terms;
        byId("event").textContent = event.event_name;
        byId("datetime").textContent = date(event.event_date) + (event.event_time ? ` ${event.event_time}` : "");
        byId("organization").textContent = [customer.organization, customer.department].filter(Boolean).join(" ") || customer.display_name;
        byId("contact").textContent = withHonorific(customer.contact_name || customer.display_name);
        byId("quote-version").textContent = `見積 第${estimate.revision_number || "—"}版`;
        byId("quote-filename").textContent = estimate.original_filename;
        byId("amount").textContent = money(estimate.amount_minor, estimate.currency);
        const conditions = byId("conditions"), details = byId("condition-details-list");
        conditions.replaceChildren(); details.replaceChildren();
        addPair(conditions, "対象業務", event.service_scope);
        addPair(conditions, "対象見積", `第${estimate.revision_number || "—"}版／${estimate.original_filename}`);
        addPair(conditions, "請求書", terms.invoice_terms || "原則PDFにてご案内いたします。所定の会計手続きがある場合は事前にご相談ください。");
        addPair(conditions, "振込手数料", terms.transfer_fee_terms || "恐れ入りますが、お客様にてご負担をお願いいたします。");
        addPair(details, "天候・日程変更", terms.weather_change_terms || "天候や主催者様のご事情による変更・中止については、状況を確認のうえご相談させていただきます。");
        const labels = { "担当者・機材について": "担当者・機材", "内容変更について": "内容変更", "主催者様にお願いする事項": "主催者へのお願い", "安全上の対応": "安全", "持込音源・機材について": "特殊音源・機材", "責任について": "責任" };
        for (const section of terms.other_terms_sections || []) addPair(details, labels[section.title] || section.title, section.text);
        const bands = byId("cancel-bands"); bands.replaceChildren();
        if (terms.cancellation_bands?.length) {
            bands.hidden = false;
            for (const band of terms.cancellation_bands) { const cell = document.createElement("div"), label = document.createElement("span"), rate = document.createElement("strong"), dates = document.createElement("small"); label.textContent = band.label; rate.textContent = band.rate === 0 ? "無料" : `${band.rate}%`; dates.textContent = (band.from ? `${short(band.from)}〜` : "〜") + short(band.to); cell.append(label, rate, dates); bands.append(cell); }
            byId("cancel-text").hidden = true;
        } else { bands.hidden = true; byId("cancel-text").hidden = false; byId("cancel-text").textContent = terms.cancellation_terms; }
        byId("weather").textContent = terms.weather_change_terms || "天候・会場事情・日程変更など、通常のキャンセルとは異なる事情がある場合は、一律に判断せず状況を確認のうえご相談させていただきます。";
        byId("due-date").textContent = terms.payment_due_date ? date(terms.payment_due_date) : "個別の合意条件";
        byId("payment-summary").textContent = terms.payment_summary || terms.banking_day_treatment || terms.payment_terms;
        byId("payment-consult").textContent = terms.payment_consult_terms || "行政機関・法人・団体等の所定のお手続きにより、お支払時期の調整が必要な場合は事前にご相談ください。可能な範囲で対応いたします。";
        byId("confirmer").value = customer.contact_name || "";
    };
    window.PAContractRenderer = Object.freeze({ addPair, date, fill, money, withHonorific });
})();
