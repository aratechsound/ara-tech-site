import { SUPABASE_ANON_KEY, SUPABASE_URL } from "./supabase-config.js";

const form = document.getElementById("consent-form");
const accessMessage = document.getElementById("access-message");
const accessMessageTitle = document.getElementById("access-message-title");
const accessMessageText = document.getElementById("access-message-text");
const caseContent = document.getElementById("case-content");
const confirmationPanel = document.getElementById("confirmation-panel");
const confirmationTitle = document.getElementById("confirmation-title");
const confirmationConditions = document.querySelector(".confirmation-conditions");
const confirmationCautionTitle = document.getElementById("confirmation-caution-title");
const confirmationCautionText = document.getElementById("confirmation-caution-text");
const editButton = document.getElementById("edit-button");
const completeButton = document.getElementById("complete-button");
const completionPanel = document.getElementById("completion-panel");
const completionTitle = document.getElementById("completion-title");
const completionStatus = document.getElementById("completion-status");
const completionDescription = document.getElementById("completion-description");
const reviewButton = document.getElementById("review-button");
const submissionStatus = document.getElementById("submission-status");
const errorSummary = document.getElementById("error-summary");
const errorList = document.getElementById("error-list");
const relationship = document.getElementById("relationship");
const relationshipOtherWrap = document.getElementById("relationship-other-wrap");
const relationshipOther = document.getElementById("relationship-other");
const authorityNotice = document.getElementById("authority-notice");
const questionDetailsWrap = document.getElementById("question-details-wrap");
const questionDetails = document.getElementById("question-details");
const agreementInputs = Array.from(document.querySelectorAll('input[name="agreement"]'));
const decisionInputs = Array.from(document.querySelectorAll('input[name="decision"]'));
const authorityInputs = Array.from(document.querySelectorAll('input[name="authority"]'));

const decisionLabels = {
    agree: "条件に同意し、日程調整を依頼する",
    decline: "条件に同意せず、日程調整を依頼しない",
    question: "内容についてARA-TECHへ確認したい"
};

const authorityLabels = {
    yes: "ある",
    no: "ない",
    unknown: "分からない"
};

const errorMap = [
    ["respondent-name", "respondent-name-error"],
    ["email", "email-error"],
    ["phone", "phone-error"],
    ["relationship", "relationship-error"],
    ["relationship-other", "relationship-other-error"],
    ["authority-group", "authority-error"],
    ["agreement-group", "agreements-error"],
    ["decision-group", "decision-error"],
    ["question-details", "question-details-error"],
    ["confirmation-name", "confirmation-name-error"]
];

const parameters = new URLSearchParams(window.location.search);
const accessToken = parameters.get("token") || "";
const submissionKey = crypto.randomUUID();
let caseRecord = null;

if (parameters.has("token")) {
    window.history.replaceState(null, "", window.location.pathname);
}

const callRpc = async (functionName, payload) => {
    const response = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${functionName}`, {
        method: "POST",
        headers: {
            apikey: SUPABASE_ANON_KEY,
            authorization: `Bearer ${SUPABASE_ANON_KEY}`,
            "content-type": "application/json",
            accept: "application/json"
        },
        body: JSON.stringify(payload),
        cache: "no-store",
        credentials: "omit",
        referrerPolicy: "no-referrer"
    });

    if (!response.ok) {
        throw new Error(`request_failed_${response.status}`);
    }

    return response.json();
};

const formatDate = (value) => {
    if (!value) return "未設定";
    return new Intl.DateTimeFormat("ja-JP", {
        year: "numeric",
        month: "long",
        day: "numeric",
        weekday: "short",
        timeZone: "Asia/Tokyo"
    }).format(new Date(`${value}T00:00:00+09:00`));
};

const formatDateTime = (value) => {
    if (!value) return "未設定";
    return new Intl.DateTimeFormat("ja-JP", {
        year: "numeric",
        month: "long",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        timeZone: "Asia/Tokyo"
    }).format(new Date(value));
};

const setCaseValue = (name, value) => {
    const target = document.querySelector(`[data-case-value="${name}"]`);
    if (target) target.textContent = value || "未設定";
};

const showAccessState = (state) => {
    const messages = {
        invalid: [
            "この専用URLは使用できません",
            "URLが無効化されているか、正しくありません。ARA-TECHから届いた最新のURLをご確認ください。"
        ],
        expired: [
            "この専用URLの有効期限が切れています",
            "新しいURLの発行が必要です。ARA-TECHへご連絡ください。"
        ],
        answered: [
            "この専用URLは回答済みです",
            "重複回答を防ぐため、再送信できません。回答内容についてはARA-TECHへご確認ください。"
        ],
        unavailable: [
            "案件情報を確認できませんでした",
            "時間をおいて再度お試しいただくか、ARA-TECHへご連絡ください。"
        ]
    };
    const [title, text] = messages[state] || messages.invalid;
    accessMessageTitle.textContent = title;
    accessMessageText.textContent = text;
    accessMessage.hidden = false;
    caseContent.hidden = true;
};

const populateCase = (record) => {
    caseRecord = record;
    setCaseValue("reference", record.inquiry_number);
    setCaseValue("event", record.event_name);
    setCaseValue("date", formatDate(record.event_date));
    setCaseValue("time", record.event_time);
    setCaseValue("venue", record.venue);
    setCaseValue("addressee", record.public_addressee);
    setCaseValue("request", record.request_summary);
    setCaseValue("deadline", formatDateTime(record.response_deadline));

    const guidanceWrap = document.getElementById("case-guidance-wrap");
    const guidance = document.getElementById("case-guidance");
    guidanceWrap.hidden = !record.guidance;
    guidance.textContent = record.guidance || "";

    const conditionsWrap = document.getElementById("case-conditions-wrap");
    const conditions = document.getElementById("case-conditions");
    conditionsWrap.hidden = !record.conditions;
    conditions.textContent = record.conditions || "";

    accessMessage.hidden = true;
    caseContent.hidden = false;
};

const loadCase = async () => {
    if (!accessToken || !SUPABASE_URL || !SUPABASE_ANON_KEY) {
        showAccessState("invalid");
        return;
    }

    try {
        const rows = await callRpc("get_pa_schedule_case", { p_token: accessToken });
        const record = rows?.[0];
        if (!record || record.access_state !== "valid") {
            showAccessState(record?.access_state || "invalid");
            return;
        }
        populateCase(record);
    } catch {
        showAccessState("unavailable");
    }
};

const checkedValue = (name) =>
    form.querySelector(`input[name="${name}"]:checked`)?.value || "";

const normalizedName = (value) =>
    value.trim().replace(/[ 　]+/g, "").toLocaleLowerCase("ja");

const setInvalid = (target, invalid) => {
    target.setAttribute("aria-invalid", invalid ? "true" : "false");
};

const clearErrors = () => {
    errorMap.forEach(([targetId, errorId]) => {
        const target = document.getElementById(targetId);
        const error = document.getElementById(errorId);
        if (target) target.removeAttribute("aria-invalid");
        if (error) {
            error.hidden = true;
            error.textContent = "";
        }
    });
    errorList.replaceChildren();
    errorSummary.hidden = true;
};

const addError = (errors, targetId, errorId, message) => {
    const target = document.getElementById(targetId);
    const error = document.getElementById(errorId);
    if (target) setInvalid(target, true);
    if (error) {
        error.textContent = message;
        error.hidden = false;
    }
    errors.push({ targetId, message });
};

const renderErrorSummary = (errors) => {
    errorList.replaceChildren();
    errors.forEach((error) => {
        const item = document.createElement("li");
        const link = document.createElement("a");
        link.href = `#${error.targetId}`;
        link.textContent = error.message;
        link.addEventListener("click", (event) => {
            const target = document.getElementById(error.targetId);
            if (!target) return;
            event.preventDefault();
            target.scrollIntoView({ behavior: "smooth", block: "center" });
            target.focus();
        });
        item.append(link);
        errorList.append(item);
    });
    errorSummary.hidden = false;
    const firstTarget = document.getElementById(errors[0].targetId);
    if (firstTarget) {
        firstTarget.scrollIntoView({ behavior: "smooth", block: "center" });
        firstTarget.focus();
    } else {
        errorSummary.focus();
    }
};

const emailLooksValid = (value) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);

const phoneLooksValid = (value) => {
    const digits = value.replace(/[^\d０-９]/g, "");
    return digits.length >= 8 && digits.length <= 15;
};

const hasConsentAuthority = () =>
    relationship.value !== "contact-only" && checkedValue("authority") === "yes";

const updateAuthorityNotice = () => {
    const authority = checkedValue("authority");
    const needsConfirmation = relationship.value === "contact-only"
        || authority === "no"
        || authority === "unknown";
    authorityNotice.hidden = !needsConfirmation;
};

const updateRelationshipFields = () => {
    relationshipOtherWrap.hidden = relationship.value !== "other";
    updateAuthorityNotice();
};

const updateDecisionFields = () => {
    const decision = checkedValue("decision");
    const previousDecision = reviewButton.dataset.decision || "";
    questionDetailsWrap.hidden = decision !== "question";

    if (previousDecision === "question" && decision !== "question") {
        questionDetails.value = "";
    }

    if (previousDecision === "agree" && decision !== "agree") {
        agreementInputs.forEach((input) => {
            input.checked = false;
        });
    }

    if (decision === "agree") {
        reviewButton.textContent = "条件に同意して日程調整を依頼する";
    } else if (decision === "decline") {
        reviewButton.textContent = "同意しない回答を確認する";
    } else if (decision === "question") {
        reviewButton.textContent = "ARA-TECHへの確認内容を確認する";
    } else {
        reviewButton.textContent = "回答内容を確認する";
    }
    reviewButton.dataset.decision = decision;
};

const validateForm = () => {
    clearErrors();
    const errors = [];
    const respondentName = document.getElementById("respondent-name");
    const email = document.getElementById("email");
    const phone = document.getElementById("phone");
    const confirmationName = document.getElementById("confirmation-name");
    const authority = checkedValue("authority");
    const decision = checkedValue("decision");

    if (!respondentName.value.trim()) {
        addError(errors, "respondent-name", "respondent-name-error", "回答者氏名を入力してください。");
    }

    if (!email.value.trim()) {
        addError(errors, "email", "email-error", "メールアドレスを入力してください。");
    } else if (!emailLooksValid(email.value.trim())) {
        addError(errors, "email", "email-error", "メールアドレスを正しい形式で入力してください。");
    }

    if (!phone.value.trim()) {
        addError(errors, "phone", "phone-error", "電話番号を入力してください。");
    } else if (!phoneLooksValid(phone.value.trim())) {
        addError(errors, "phone", "phone-error", "電話番号を8〜15桁の数字を含む形式で入力してください。");
    }

    if (!relationship.value) {
        addError(errors, "relationship", "relationship-error", "この案件との関係を選択してください。");
    }

    if (relationship.value === "other" && !relationshipOther.value.trim()) {
        addError(errors, "relationship-other", "relationship-other-error", "この案件との関係を入力してください。");
    }

    if (!authority) {
        addError(errors, "authority-group", "authority-error", "発注および条件同意の権限を選択してください。");
    }

    if (!decision) {
        addError(errors, "decision-group", "decision-error", "最終回答を選択してください。");
    }

    if (decision === "question" && !questionDetails.value.trim()) {
        addError(errors, "question-details", "question-details-error", "ARA-TECHへ確認したい内容を入力してください。");
    }

    if (!confirmationName.value.trim()) {
        addError(errors, "confirmation-name", "confirmation-name-error", "確認者氏名をもう一度入力してください。");
    } else if (
        respondentName.value.trim()
        && normalizedName(confirmationName.value) !== normalizedName(respondentName.value)
    ) {
        addError(errors, "confirmation-name", "confirmation-name-error", "回答者氏名と同じ氏名を入力してください。");
    }

    if (decision === "agree") {
        if (authority && !hasConsentAuthority()) {
            addError(
                errors,
                "authority-group",
                "authority-error",
                "正式同意には、条件同意の権限が「ある」ことと、連絡窓口のみではないことの確認が必要です。"
            );
        }

        const uncheckedCount = agreementInputs.filter((input) => !input.checked).length;
        if (uncheckedCount > 0) {
            addError(
                errors,
                "agreement-group",
                "agreements-error",
                `条件に同意する場合は、7項目すべてを個別に確認してください（未確認 ${uncheckedCount}項目）。`
            );
        }
    }

    return errors;
};

const selectedOptionText = (selectElement) =>
    selectElement.options[selectElement.selectedIndex]?.textContent.trim() || "";

const fillConfirmation = () => {
    const decision = checkedValue("decision");
    const authority = checkedValue("authority");
    const relationshipText = relationship.value === "other"
        ? `その他（${relationshipOther.value.trim()}）`
        : selectedOptionText(relationship);
    const respondentName = document.getElementById("respondent-name").value.trim();
    const organization = document.getElementById("organization").value.trim();
    const email = document.getElementById("email").value.trim();
    const phone = document.getElementById("phone").value.trim();
    const confirmationName = document.getElementById("confirmation-name").value.trim();

    document.getElementById("confirm-reference").textContent =
        document.querySelector('[data-case-value="reference"]').textContent.trim();
    document.getElementById("confirm-event").textContent =
        document.querySelector('[data-case-value="event"]').textContent.trim();
    document.getElementById("confirm-date").textContent =
        document.querySelector('[data-case-value="date"]').textContent.trim();
    document.getElementById("confirm-respondent").textContent =
        organization ? `${respondentName}（${organization}）` : respondentName;
    document.getElementById("confirm-email").textContent = email;
    document.getElementById("confirm-phone").textContent = phone;
    document.getElementById("confirm-relationship").textContent = relationshipText;
    document.getElementById("confirm-authority").textContent = authorityLabels[authority] || "";
    document.getElementById("confirm-confirmation-name").textContent = confirmationName;
    document.getElementById("confirm-decision").textContent = decisionLabels[decision] || "";

    const questionRow = document.getElementById("confirm-question-row");
    questionRow.hidden = decision !== "question";
    document.getElementById("confirm-question").textContent =
        decision === "question" ? questionDetails.value.trim() : "";

    const confirmationAgreements = document.getElementById("confirm-agreements");
    const confirmationAgreementsNote = document.getElementById("confirm-agreements-note");
    confirmationAgreements.replaceChildren();
    confirmationAgreements.hidden = decision !== "agree";
    confirmationAgreementsNote.hidden = decision === "agree";

    if (decision === "agree") {
        agreementInputs.forEach((input) => {
            const item = document.createElement("li");
            item.textContent = input.closest("label").textContent.trim();
            confirmationAgreements.append(item);
        });
        confirmationConditions.hidden = false;
        confirmationCautionTitle.textContent = "日程確保はまだ完了していません。";
        confirmationCautionText.textContent = "ARA-TECHから日程確保完了の連絡を受けるまでは、予約・日程確保は成立しません。";
        completeButton.textContent = "同意内容を送信する";
    } else if (decision === "question") {
        confirmationAgreementsNote.textContent = "この回答では、個別同意チェックを必須としていません。";
        confirmationConditions.hidden = true;
        confirmationCautionTitle.textContent = "条件への同意と日程調整の依頼は確定していません。";
        confirmationCautionText.textContent = "ARA-TECHへの確認希望として送信します。日程調整は開始されません。";
        completeButton.textContent = "確認希望を送信する";
    } else {
        confirmationAgreementsNote.textContent = "この回答では、個別同意チェックを必須としていません。";
        confirmationConditions.hidden = true;
        confirmationCautionTitle.textContent = "この回答では、日程調整を依頼していません。";
        confirmationCautionText.textContent = "条件への同意および日程調整の依頼は行われません。";
        completeButton.textContent = "見送り回答を送信する";
    }
};

const showConfirmation = () => {
    fillConfirmation();
    submissionStatus.textContent = "";
    form.hidden = true;
    completionPanel.hidden = true;
    confirmationPanel.hidden = false;
    confirmationTitle.focus();
    confirmationPanel.scrollIntoView({ behavior: "smooth", block: "start" });
};

const responsePayload = () => ({
    respondent_name: document.getElementById("respondent-name").value.trim(),
    organization: document.getElementById("organization").value.trim(),
    email: document.getElementById("email").value.trim(),
    phone: document.getElementById("phone").value.trim(),
    relationship: relationship.value,
    relationship_other: relationshipOther.value.trim(),
    authority: checkedValue("authority"),
    decision: checkedValue("decision"),
    agreements: agreementInputs.filter((input) => input.checked).map((input) => input.value),
    question_details: questionDetails.value.trim(),
    confirmation_name: document.getElementById("confirmation-name").value.trim(),
    terms_version: "ARA-20260723-002"
});

const showCompletion = () => {
    const decision = checkedValue("decision");
    if (decision === "agree") {
        completionStatus.textContent = "日程調整の依頼を受け付けました。";
        completionDescription.textContent = "日程確保は完了していません。ARA-TECHから「日程確保完了」の連絡をした時点で、予約・日程確保が成立します。";
    } else if (decision === "question") {
        completionStatus.textContent = "ARA-TECHへの確認希望を受け付けました。";
        completionDescription.textContent = "ARA-TECHが内容を確認し、あらためてご連絡します。";
    } else {
        completionStatus.textContent = "日程調整を依頼しない回答を受け付けました。";
        completionDescription.textContent = "この回答では、ARA-TECHへ日程調整を依頼していません。";
    }

    confirmationPanel.hidden = true;
    completionPanel.hidden = false;
    completionTitle.focus();
    completionPanel.scrollIntoView({ behavior: "smooth", block: "start" });
};

const submitResponse = async () => {
    if (!caseRecord || !accessToken) return;
    completeButton.disabled = true;
    submissionStatus.textContent = "送信しています。画面を閉じずにお待ちください。";

    try {
        const rows = await callRpc("submit_pa_schedule_response", {
            p_token: accessToken,
            p_response: responsePayload(),
            p_submission_key: submissionKey
        });
        const result = rows?.[0]?.result;
        if (result === "accepted") {
            showCompletion();
            return;
        }
        if (result === "already_answered") {
            showAccessState("answered");
            return;
        }
        if (result === "expired") {
            showAccessState("expired");
            return;
        }
        showAccessState("invalid");
    } catch {
        submissionStatus.textContent = "送信できませんでした。通信状況をご確認のうえ、もう一度お試しください。";
        completeButton.disabled = false;
    }
};

form.addEventListener("submit", (event) => {
    event.preventDefault();
    const errors = validateForm();
    if (errors.length > 0) {
        renderErrorSummary(errors);
        return;
    }
    showConfirmation();
});

relationship.addEventListener("change", updateRelationshipFields);
authorityInputs.forEach((input) => input.addEventListener("change", updateAuthorityNotice));
decisionInputs.forEach((input) => input.addEventListener("change", updateDecisionFields));

editButton.addEventListener("click", () => {
    confirmationPanel.hidden = true;
    form.hidden = false;
    clearErrors();
    document.getElementById("decision-group").scrollIntoView({ behavior: "smooth", block: "center" });
    form.querySelector('input[name="decision"]:checked')?.focus();
});

completeButton.addEventListener("click", submitResponse);

updateRelationshipFields();
updateDecisionFields();
loadCase();
