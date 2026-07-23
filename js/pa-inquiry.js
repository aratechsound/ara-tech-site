"use strict";

const form = document.querySelector("#pa-inquiry-form");
const result = document.querySelector("#prototype-result");
const summary = document.querySelector("#confirmation-summary");
const backToFormButton = document.querySelector("#back-to-form");
const sendInquiryButton = document.querySelector("#send-inquiry");
const submissionStatus = document.querySelector("#submission-status");
const sourceGuidance = document.querySelector("#source-guidance");
const formSource = document.querySelector("#form-source");
const formService = document.querySelector("#form-service");
const navToggle = document.querySelector(".navbar-toggle");
const siteNav = document.querySelector("#site-nav");

const timeUndecided = document.querySelector("#time-undecided");
const startTime = document.querySelector("#start-time");
const endTime = document.querySelector("#end-time");

const serviceCheckboxes = [...document.querySelectorAll("[data-service]")];
const serviceOther = document.querySelector("#service-other");
const serviceOtherField = document.querySelector("#service-other-field");
const serviceOtherDetail = document.querySelector("#service-other-detail");

const requesterRelation = document.querySelector("#requester-relation");
const requesterRelationOtherField = document.querySelector("#requester-relation-other-field");
const requesterRelationOther = document.querySelector("#requester-relation-other");
const requesterIdentityFields = document.querySelector("#requester-identity-fields");
const requesterCopyNote = document.querySelector("#requester-copy-note");
const requesterName = document.querySelector("#requester-name");
const requesterOrganization = document.querySelector("#requester-organization");

const organizerName = document.querySelector("#organizer-name");
const organizerNameLabelText = document.querySelector("#organizer-name-label-text");
const organizerTypeRadios = [...document.querySelectorAll('input[name="organizer_type"]')];
const organizerRepresentativeField = document.querySelector("#organizer-representative-field");
const organizerRepresentative = document.querySelector("#organizer-representative");
const organizerEmail = document.querySelector("#organizer-email");
const organizerPhone = document.querySelector("#organizer-phone");
const organizerEmailOptionalBadge = document.querySelector("#organizer-email-optional");
const organizerEmailRequiredBadge = document.querySelector("#organizer-email-required");
const organizerPhoneOptionalBadge = document.querySelector("#organizer-phone-optional");
const organizerPhoneRequiredBadge = document.querySelector("#organizer-phone-required");

const contactSourceRadios = [...document.querySelectorAll('input[name="contact_source"]')];
const contactCopyNote = document.querySelector("#contact-copy-note");
const contactNameField = document.querySelector("#contact-name-field");
const contactDetailFields = document.querySelector("#contact-detail-fields");
const contactName = document.querySelector("#contact-name");
const contactEmail = document.querySelector("#contact-email");
const contactPhone = document.querySelector("#contact-phone");

const payerSourceRadios = [...document.querySelectorAll('input[name="payer_source"]')];
const payerCopyNote = document.querySelector("#payer-copy-note");
const payerOtherFields = document.querySelector("#payer-other-fields");
const payerRequiredFields = [
    document.querySelector("#invoice-name"),
    document.querySelector("#payer-name"),
    document.querySelector("#payer-email")
];

const routeConfig = {
    "pa-rental": {
        serviceValue: "PA・音響",
        serviceLabel: "PAレンタル",
        guidance: "PAレンタルページからのご相談です。「PA・音響」を初期選択しています。"
    },
    "stage-production": {
        serviceValue: "ステージ制作・舞台設営",
        serviceLabel: "ステージ制作",
        guidance: "ステージ制作ページからのご相談です。「ステージ制作・舞台設営」を初期選択しています。"
    }
};

const applyRouteParameters = () => {
    const parameters = new URLSearchParams(window.location.search);
    const source = parameters.get("source") || "";
    const service = parameters.get("service") || "";
    const allowedSources = new Set(["contact", "pa-rental", "stage-production"]);
    const route = routeConfig[service];

    formSource.value = allowedSources.has(source) ? source : "direct";
    formService.value = route ? route.serviceLabel : "";

    if (route) {
        const serviceCheckbox = serviceCheckboxes.find((checkbox) => checkbox.value === route.serviceValue);
        if (serviceCheckbox) {
            serviceCheckbox.checked = true;
        }
        sourceGuidance.textContent = route.guidance;
    } else if (source === "contact") {
        sourceGuidance.textContent = "CONTACTページからのご相談です。希望する業務を選び、開催内容をご入力ください。";
    }
};

const setConditionalField = (container, input, visible) => {
    container.hidden = !visible;
    input.required = visible;
    if (!visible) {
        input.value = "";
    }
};

const updateTimeFields = () => {
    const isUndecided = timeUndecided.checked;
    [startTime, endTime].forEach((input) => {
        input.disabled = isUndecided;
        input.required = !isUndecided;
        if (isUndecided) {
            input.value = "";
        }
    });
};

const updateServices = () => {
    const hasSelection = serviceCheckboxes.some((checkbox) => checkbox.checked);
    serviceCheckboxes[0].required = !hasSelection;
    setConditionalField(serviceOtherField, serviceOtherDetail, serviceOther.checked);
};

const updateOrganizerType = () => {
    const selected = organizerTypeRadios.find((radio) => radio.checked)?.value ?? "";
    const isPersonal = selected === "個人";
    const isOrganization = selected === "団体・事業者";

    organizerNameLabelText.textContent = isPersonal
        ? "主催者名"
        : isOrganization
            ? "主催団体名"
            : "主催者・主催団体名";
    organizerName.autocomplete = isPersonal ? "name" : "organization";
    organizerRepresentativeField.hidden = !isOrganization;
    organizerRepresentative.disabled = !isOrganization;
    organizerRepresentative.required = isOrganization;
};

const updateRequesterRelation = () => {
    setConditionalField(
        requesterRelationOtherField,
        requesterRelationOther,
        requesterRelation.value === "その他"
    );

    const isOrganizer = requesterRelation.value === "主催者本人";
    requesterIdentityFields.hidden = isOrganizer;
    requesterCopyNote.hidden = !isOrganizer;
    requesterName.disabled = isOrganizer;
    requesterOrganization.disabled = isOrganizer;
    requesterName.required = !isOrganizer;
    updateContactSource();
};

const setOrganizerContactRequirement = (required) => {
    organizerEmail.required = required;
    organizerPhone.required = required;
    organizerEmailOptionalBadge.hidden = required;
    organizerEmailRequiredBadge.hidden = !required;
    organizerPhoneOptionalBadge.hidden = required;
    organizerPhoneRequiredBadge.hidden = !required;
};

const updateContactSource = () => {
    const selected = contactSourceRadios.find((radio) => radio.checked)?.value ?? "";
    const usesOrganizer = selected === "organizer";
    const usesRequester = selected === "requester";
    const isOther = selected === "other";
    const needsOwnContactDetails = usesRequester || isOther;

    contactNameField.hidden = !isOther;
    contactDetailFields.hidden = !needsOwnContactDetails;
    contactName.disabled = !isOther;
    contactEmail.disabled = !needsOwnContactDetails;
    contactPhone.disabled = !needsOwnContactDetails;
    contactName.required = isOther;
    contactEmail.required = needsOwnContactDetails;
    contactPhone.required = needsOwnContactDetails;
    setOrganizerContactRequirement(usesOrganizer);

    if (usesOrganizer) {
        contactCopyNote.textContent = "主催者情報の担当者名・メールアドレス・電話番号を連絡窓口として使用します。";
        contactCopyNote.hidden = false;
    } else if (usesRequester) {
        contactCopyNote.textContent = "依頼者名を担当者名として使用します。連絡用のメールアドレスと電話番号だけご入力ください。";
        contactCopyNote.hidden = false;
    } else {
        contactCopyNote.textContent = "";
        contactCopyNote.hidden = true;
    }
};

const updatePayerFields = () => {
    const selected = payerSourceRadios.find((radio) => radio.checked)?.value ?? "";
    const isOther = selected === "other";
    const isSamePerson = selected !== "" && !isOther;

    payerOtherFields.hidden = !isOther;
    payerCopyNote.hidden = !isSamePerson;
    payerRequiredFields.forEach((input) => {
        input.required = isOther;
        if (!isOther) {
            input.value = "";
        }
    });
    if (!isOther) {
        document.querySelector("#payer-organization").value = "";
        document.querySelector("#payer-phone").value = "";
    }
};

const getValue = (selector) => document.querySelector(selector)?.value.trim() || "未入力";

const getCheckedValue = (name) =>
    document.querySelector(`input[name="${name}"]:checked`)?.value || "未選択";

const payerSourceLabel = () => {
    const labels = {
        organizer: "主催者と同じ",
        requester: "依頼者と同じ",
        contact: "連絡窓口担当者と同じ",
        other: "その他"
    };
    return labels[getCheckedValue("payer_source")] || "未選択";
};

const requestedServicesLabel = () => {
    const selected = serviceCheckboxes
        .filter((checkbox) => checkbox.checked)
        .map((checkbox) => {
            if (checkbox.value === "その他") {
                return `その他（${serviceOtherDetail.value.trim()}）`;
            }
            return checkbox.value;
        });
    return selected.join("、") || "未選択";
};

const eventTimeLabel = () => {
    if (timeUndecided.checked) {
        return "未定";
    }
    return `${startTime.value || "未入力"} ～ ${endTime.value || "未入力"}`;
};

const relationLabel = () => {
    if (requesterRelation.value === "その他") {
        return `その他（${requesterRelationOther.value.trim()}）`;
    }
    return requesterRelation.value || "未選択";
};

const organizerDisplayName = () => {
    if (getCheckedValue("organizer_type") === "団体・事業者") {
        return organizerRepresentative.value.trim() || organizerName.value.trim() || "未入力";
    }
    return organizerName.value.trim() || "未入力";
};

const requesterDisplayName = () => {
    if (requesterRelation.value === "主催者本人") {
        return organizerDisplayName();
    }
    return requesterName.value.trim() || "未入力";
};

const contactDisplayName = () => {
    const source = getCheckedValue("contact_source");
    if (source === "organizer") {
        return organizerDisplayName();
    }
    if (source === "requester") {
        return requesterDisplayName();
    }
    return contactName.value.trim() || "未入力";
};

const contactDisplayEmail = () =>
    getCheckedValue("contact_source") === "organizer"
        ? organizerEmail.value.trim() || "未入力"
        : contactEmail.value.trim() || "未入力";

const createSummary = () => {
    const items = [
        ["イベント名・案件名", getValue("#event-name")],
        ["開催希望日", getValue("#event-date")],
        ["開催時間", eventTimeLabel()],
        ["会場", `${getValue("#venue-name")} / ${getValue("#venue-address")}`],
        ["開催場所・状況", `${getCheckedValue("venue_type")} / ${getCheckedValue("event_status")}`],
        ["希望する業務", requestedServicesLabel()],
        ["主催者", getValue("#organizer-name")],
        ["依頼者", `${requesterDisplayName()} / ${relationLabel()}`],
        ["発注・同意権限", getCheckedValue("requester_authority")],
        ["連絡窓口", `${contactDisplayName()} / ${contactDisplayEmail()}`],
        ["希望する連絡方法", getCheckedValue("preferred_contact_method")],
        ["支払責任者", payerSourceLabel()]
    ];

    summary.replaceChildren();
    items.forEach(([term, description]) => {
        const dt = document.createElement("dt");
        const dd = document.createElement("dd");
        dt.textContent = term;
        dd.textContent = description;
        summary.append(dt, dd);
    });
};

const submitInquiry = async () => {
    sendInquiryButton.disabled = true;
    submissionStatus.classList.remove("is-error");
    submissionStatus.textContent = "送信しています。画面を閉じずにお待ちください。";

    const submission = new FormData(form);
    submission.set("希望する業務（確認用）", requestedServicesLabel());
    submission.set("開催時間（確認用）", eventTimeLabel());
    submission.set("依頼者（確認用）", requesterDisplayName());
    submission.set("連絡窓口（確認用）", `${contactDisplayName()} / ${contactDisplayEmail()}`);
    submission.set("支払責任者（確認用）", payerSourceLabel());

    try {
        const response = await fetch(form.action, {
            method: "POST",
            body: submission,
            headers: { Accept: "application/json" }
        });

        if (!response.ok) {
            throw new Error(`Form submission failed: ${response.status}`);
        }

        window.location.assign("thanks.html?sent=1&form=pa-inquiry");
    } catch (error) {
        console.error("PA inquiry submission error", error);
        submissionStatus.textContent = "送信できませんでした。通信状況をご確認のうえ、もう一度お試しください。";
        submissionStatus.classList.add("is-error");
        sendInquiryButton.disabled = false;
        sendInquiryButton.focus();
    }
};

navToggle.addEventListener("click", () => {
    const isOpen = navToggle.getAttribute("aria-expanded") === "true";
    navToggle.setAttribute("aria-expanded", String(!isOpen));
    navToggle.querySelector(".visually-hidden").textContent = isOpen ? "メニューを開く" : "メニューを閉じる";
    siteNav.classList.toggle("is-open", !isOpen);
});

siteNav.addEventListener("click", (event) => {
    if (event.target.matches("a")) {
        navToggle.setAttribute("aria-expanded", "false");
        navToggle.querySelector(".visually-hidden").textContent = "メニューを開く";
        siteNav.classList.remove("is-open");
    }
});

timeUndecided.addEventListener("change", updateTimeFields);
serviceCheckboxes.forEach((checkbox) => checkbox.addEventListener("change", updateServices));
organizerTypeRadios.forEach((radio) => radio.addEventListener("change", updateOrganizerType));
requesterRelation.addEventListener("change", updateRequesterRelation);
contactSourceRadios.forEach((radio) => radio.addEventListener("change", updateContactSource));
payerSourceRadios.forEach((radio) => radio.addEventListener("change", updatePayerFields));

form.addEventListener("submit", (event) => {
    event.preventDefault();
    createSummary();
    form.hidden = true;
    result.hidden = false;
    result.focus();
    result.scrollIntoView({ behavior: "smooth", block: "start" });
});

backToFormButton.addEventListener("click", () => {
    result.hidden = true;
    form.hidden = false;
    document.querySelector("#form-title").scrollIntoView({ behavior: "smooth", block: "start" });
    document.querySelector("#event-name").focus({ preventScroll: true });
});

sendInquiryButton.addEventListener("click", submitInquiry);

applyRouteParameters();
updateTimeFields();
updateServices();
updateOrganizerType();
updateRequesterRelation();
updateContactSource();
updatePayerFields();
