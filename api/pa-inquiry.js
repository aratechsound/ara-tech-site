const crypto = require("node:crypto");
const { sendAutomaticInquiryEmails } = require("./_pa-mail.cjs");

const DEFAULT_SUPABASE_URL = "https://kogbnremsouajxxsgxro.supabase.co";
const MAX_BODY_BYTES = 48_000;
const RATE_WINDOW_MS = 10 * 60 * 1000;
const RATE_LIMIT = 8;
const rateWindows = new Map();

const allowedServices = new Set([
    "PA・音響",
    "照明",
    "DJ機材",
    "バンド機材",
    "電源・発電機",
    "ステージ制作・舞台設営",
    "オペレーター・技術スタッフ",
    "その他"
]);

const allowedAttendance = new Set([
    "1〜20名",
    "21〜50名",
    "51〜100名",
    "101〜300名",
    "301〜500名",
    "501〜999名",
    "1,000名以上"
]);

const allowedRequesterRelations = new Set([
    "主催者本人",
    "主催団体の担当者",
    "制作・運営会社",
    "出演者・DJ",
    "連絡窓口のみ",
    "その他"
]);

const asText = (value, maxLength, { required = false } = {}) => {
    const text = typeof value === "string" ? value.trim() : "";
    if ((required && !text) || text.length > maxLength || /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/u.test(text)) {
        throw new ValidationError();
    }
    return text;
};

const asChoice = (value, choices, required = true) => {
    const text = asText(value, 120, { required });
    if (text && !choices.has(text)) throw new ValidationError();
    return text;
};

const asEmail = (value) => {
    const email = asText(value, 320, { required: true });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email)) throw new ValidationError();
    return email;
};

const asOptionalEmail = (value) => {
    const email = asText(value, 320);
    return email ? asEmail(email) : "";
};

const asPhone = (value) => {
    const phone = asText(value, 60, { required: true });
    if (!/^[0-9０-９+＋()（）\-ー－\s]{7,60}$/u.test(phone)) throw new ValidationError();
    return phone;
};

const asOptionalPhone = (value) => {
    const phone = asText(value, 60);
    return phone ? asPhone(phone) : "";
};

const asDate = (value) => {
    const date = asText(value, 10, { required: true });
    if (!/^\d{4}-\d{2}-\d{2}$/u.test(date)) throw new ValidationError();
    const parsed = new Date(`${date}T00:00:00Z`);
    if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) throw new ValidationError();
    return date;
};

const asTime = (value) => {
    const time = asText(value, 5, { required: true });
    if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/u.test(time)) throw new ValidationError();
    return time;
};

const asUuid = (value) => {
    const uuid = asText(value, 36, { required: true }).toLowerCase();
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(uuid)) {
        throw new ValidationError();
    }
    return uuid;
};

class ValidationError extends Error {
    constructor() {
        super("invalid inquiry");
        this.name = "ValidationError";
    }
}

const normalizeInquiry = (input) => {
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new ValidationError();
    if (Buffer.byteLength(JSON.stringify(input), "utf8") > MAX_BODY_BYTES) throw new ValidationError();

    const submissionKey = asUuid(input.submission_key);
    const website = asText(input.website, 200);
    if (website) throw new ValidationError();

    const eventDate = asDate(input.event_date);
    const eventName = asText(input.event_name, 240);
    const timeUndecided = input.time_undecided === "未定";
    const startTime = timeUndecided ? "" : asTime(input.start_time);
    const endTime = timeUndecided ? "" : asTime(input.end_time);
    const eventTime = timeUndecided ? "未定" : `${startTime}〜${endTime}`;
    const venueName = asText(input.venue_name, 160, { required: true });
    const venueAddress = asText(input.venue_address, 160, { required: true });
    const venueType = asChoice(input.venue_type, new Set(["屋内", "屋外", "未定"]));
    const attendance = asChoice(input.expected_attendance, allowedAttendance);
    const eventOverview = asText(input.event_overview, 5000, { required: true });
    const eventStatus = asChoice(input.event_status, new Set(["開催決定", "開催予定", "検討中"]));

    const serviceValues = Array.isArray(input.requested_services)
        ? input.requested_services
        : typeof input.requested_services === "string" ? [input.requested_services] : [];
    const requestedServices = [...new Set(serviceValues.map((value) => asChoice(value, allowedServices)))];
    if (!requestedServices.length || requestedServices.length > allowedServices.size) throw new ValidationError();
    const requestedServiceOther = asText(input.requested_service_other, 200, {
        required: requestedServices.includes("その他")
    });
    const requestedServicesDisplay = requestedServices.map((service) =>
        service === "その他" ? `その他（${requestedServiceOther}）` : service
    );

    const organizerType = asChoice(input.organizer_type, new Set(["個人", "団体・事業者"]));
    const organizerName = asText(input.organizer_name, 200, { required: true });
    const organizerRepresentative = asText(input.organizer_representative, 160, {
        required: organizerType === "団体・事業者"
    });
    const organizerEmail = asOptionalEmail(input.organizer_email);
    const organizerPhone = asOptionalPhone(input.organizer_phone);

    const requesterRelation = asChoice(input.requester_relation, allowedRequesterRelations);
    const requesterRelationOther = asText(input.requester_relation_other, 200, {
        required: requesterRelation === "その他"
    });
    const requesterIsOrganizer = requesterRelation === "主催者本人";
    const requesterName = requesterIsOrganizer
        ? (organizerRepresentative || organizerName)
        : asText(input.requester_name, 160, { required: true });
    const requesterOrganization = requesterIsOrganizer
        ? (organizerType === "団体・事業者" ? organizerName : "")
        : asText(input.requester_organization, 200);
    const requesterAuthority = asChoice(input.requester_authority, new Set(["ある", "ない", "分からない"]));

    const contactSource = asChoice(input.contact_source, new Set(["organizer", "requester", "other"]));
    let contactName;
    let contactEmail;
    let contactPhone;
    if (contactSource === "organizer") {
        contactName = organizerRepresentative || organizerName;
        contactEmail = asEmail(organizerEmail);
        contactPhone = asPhone(organizerPhone);
    } else if (contactSource === "requester") {
        contactName = requesterName;
        contactEmail = asEmail(input.contact_email);
        contactPhone = asPhone(input.contact_phone);
    } else {
        contactName = asText(input.contact_name, 160, { required: true });
        contactEmail = asEmail(input.contact_email);
        contactPhone = asPhone(input.contact_phone);
    }
    const preferredContactMethod = asChoice(
        input.preferred_contact_method,
        new Set(["メール", "電話", "どちらでもよい"])
    );

    const payerSource = asChoice(input.payer_source, new Set(["organizer", "requester", "contact", "other"]));
    const invoiceName = asText(input.invoice_name, 200, { required: payerSource === "other" });
    const payerName = asText(input.payer_name, 160, { required: payerSource === "other" });
    const payerOrganization = asText(input.payer_organization, 200);
    const payerEmail = payerSource === "other" ? asEmail(input.payer_email) : asOptionalEmail(input.payer_email);
    const payerPhone = asOptionalPhone(input.payer_phone);
    const estimateNotes = asText(input.estimate_notes, 5000);
    const questions = asText(input.questions, 5000);
    if (input.confirmation_consent !== "同意する") throw new ValidationError();

    const organizationName = organizerType === "団体・事業者" ? organizerName : "";
    const customerName = organizerType === "団体・事業者"
        ? (organizerRepresentative || contactName)
        : organizerName;
    const venue = `${venueName}（${venueAddress}）`;
    if (venue.length > 300) throw new ValidationError();

    const requestSummaryParts = [
        `希望業務：${requestedServicesDisplay.join("、")}`,
        `開催概要：${eventOverview}`,
        `開催状況：${eventStatus}`,
        `会場種別：${venueType}`,
        `想定来場者数：${attendance}`,
        estimateNotes ? `見積り・準備情報：${estimateNotes}` : "",
        questions ? `質問・連絡事項：${questions}` : ""
    ].filter(Boolean);
    const requestSummary = requestSummaryParts.join("\n");
    if (requestSummary.length > 20_000) throw new ValidationError();

    const contactSourceLabel = {
        organizer: "主催者と同じ",
        requester: "依頼者と同じ",
        other: "別の担当者"
    }[contactSource];
    const payerSourceLabel = {
        organizer: "主催者と同じ",
        requester: "依頼者と同じ",
        contact: "連絡窓口担当者と同じ",
        other: "その他"
    }[payerSource];

    const firstFormData = {
        form_source: asChoice(
            input.form_source || "direct",
            new Set(["direct", "contact", "pa-rental", "stage-production"])
        ),
        form_service: asChoice(input.form_service, new Set(["PAレンタル", "ステージ制作"]), false),
        event_name: eventName,
        event_date: eventDate,
        event_time: eventTime,
        venue_name: venueName,
        venue_address: venueAddress,
        venue_type: venueType,
        expected_attendance: attendance,
        event_overview: eventOverview,
        event_status: eventStatus,
        requested_services: requestedServicesDisplay,
        organizer_type: organizerType,
        organizer_name: organizerName,
        organizer_representative: organizerRepresentative,
        organizer_email: organizerEmail,
        organizer_phone: organizerPhone,
        requester_relation: requesterRelation === "その他"
            ? `その他（${requesterRelationOther}）`
            : requesterRelation,
        requester_name: requesterName,
        requester_organization: requesterOrganization,
        requester_authority: requesterAuthority,
        contact_source: contactSourceLabel,
        contact_name: contactName,
        contact_email: contactEmail,
        contact_phone: contactPhone,
        preferred_contact_method: preferredContactMethod,
        payer_source: payerSourceLabel,
        invoice_name: invoiceName,
        payer_name: payerName,
        payer_organization: payerOrganization,
        payer_email: payerEmail,
        payer_phone: payerPhone,
        estimate_notes: estimateNotes,
        questions,
        confirmation_consent: true
    };

    return {
        submission_key: submissionKey,
        submission_source: "public_form",
        status: "new",
        schedule_state: "unconfirmed",
        customer_name: customerName,
        organization_name: organizationName || null,
        contact_name: contactName,
        email: contactEmail,
        phone: contactPhone,
        event_name: eventName || null,
        event_date: eventDate,
        event_time: eventTime,
        venue,
        requested_services: requestedServicesDisplay,
        request_summary: requestSummary,
        first_form_data: firstFormData,
        public_addressee: contactName,
        public_event_name: eventName || null,
        public_event_date: eventDate,
        public_event_time: eventTime,
        public_venue: venue,
        public_request_summary: requestSummary
    };
};

const requestOriginMatchesHost = (request) => {
    const origin = request.headers?.origin;
    if (!origin) return true;
    try {
        const originUrl = new URL(origin);
        const forwardedHost = String(request.headers?.["x-forwarded-host"] || request.headers?.host || "")
            .split(",")[0]
            .trim()
            .toLowerCase();
        return originUrl.host.toLowerCase() === forwardedHost
            && (originUrl.protocol === "https:" || process.env.NODE_ENV !== "production");
    } catch {
        return false;
    }
};

const getClientHash = (request) => {
    const forwarded = String(request.headers?.["x-forwarded-for"] || "").split(",")[0].trim();
    const source = forwarded || String(request.socket?.remoteAddress || "unknown");
    return crypto.createHash("sha256").update(source).digest("hex");
};

const isRateLimited = (request, submissionKey) => {
    const now = Date.now();
    const clientHash = getClientHash(request);
    let window = rateWindows.get(clientHash);
    if (!window || window.expiresAt <= now) {
        window = { expiresAt: now + RATE_WINDOW_MS, keys: new Set() };
        rateWindows.set(clientHash, window);
    }
    window.keys.add(submissionKey);
    if (rateWindows.size > 1000) {
        for (const [key, value] of rateWindows) {
            if (value.expiresAt <= now) rateWindows.delete(key);
        }
    }
    return window.keys.size > RATE_LIMIT;
};

const parseBody = (request) => {
    if (request.body && typeof request.body === "object" && !Buffer.isBuffer(request.body)) return request.body;
    if (typeof request.body !== "string") throw new ValidationError();
    try {
        return JSON.parse(request.body);
    } catch {
        throw new ValidationError();
    }
};

const supabaseHeaders = (serviceRoleKey, prefer) => ({
    apikey: serviceRoleKey,
    authorization: `Bearer ${serviceRoleKey}`,
    "content-type": "application/json",
    accept: "application/json",
    ...(prefer ? { prefer } : {})
});

const registerInquiry = async (record, fetchImpl = fetch) => {
    const supabaseUrl = String(process.env.SUPABASE_URL || DEFAULT_SUPABASE_URL).replace(/\/+$/u, "");
    const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!serviceRoleKey) throw new Error("configuration");

    const insertUrl = new URL(`${supabaseUrl}/rest/v1/pa_inquiries`);
    insertUrl.searchParams.set("on_conflict", "submission_key");
    insertUrl.searchParams.set("select", "id,inquiry_number,received_at");
    const insertResponse = await fetchImpl(insertUrl, {
        method: "POST",
        headers: supabaseHeaders(serviceRoleKey, "return=representation,resolution=ignore-duplicates"),
        body: JSON.stringify(record)
    });
    if (!insertResponse.ok) throw new Error("database");
    const inserted = await insertResponse.json();
    if (Array.isArray(inserted) && inserted[0]) return { ...inserted[0], duplicate: false };

    const lookupUrl = new URL(`${supabaseUrl}/rest/v1/pa_inquiries`);
    lookupUrl.searchParams.set("submission_key", `eq.${record.submission_key}`);
    lookupUrl.searchParams.set("select", "id,inquiry_number,received_at");
    lookupUrl.searchParams.set("limit", "1");
    const lookupResponse = await fetchImpl(lookupUrl, {
        headers: supabaseHeaders(serviceRoleKey)
    });
    if (!lookupResponse.ok) throw new Error("database");
    const existing = await lookupResponse.json();
    if (!Array.isArray(existing) || !existing[0]) throw new Error("database");
    return { ...existing[0], duplicate: true };
};

const sendJson = (response, status, payload) => {
    response.setHeader("Content-Type", "application/json; charset=utf-8");
    response.setHeader("Cache-Control", "private, no-store, max-age=0");
    response.setHeader("X-Content-Type-Options", "nosniff");
    return response.status(status).json(payload);
};

module.exports = async (request, response) => {
    if (request.method !== "POST") {
        response.setHeader("Allow", "POST");
        return sendJson(response, 405, { ok: false, code: "method_not_allowed" });
    }
    if (!requestOriginMatchesHost(request)) {
        return sendJson(response, 403, { ok: false, code: "invalid_origin" });
    }

    try {
        const record = normalizeInquiry(parseBody(request));
        if (isRateLimited(request, record.submission_key)) {
            return sendJson(response, 429, { ok: false, code: "rate_limited" });
        }
        const result = await registerInquiry(record);
        let customerReceiptStatus = "unchanged";
        let internalNotificationStatus = "unchanged";
        if (!result.duplicate) {
            const deliveries = await sendAutomaticInquiryEmails({
                ...record,
                ...result
            }).catch(() => []);
            customerReceiptStatus = deliveries.find((item) => item.message_type === "customer_receipt")?.status || "failed";
            internalNotificationStatus = deliveries.find((item) => item.message_type === "internal_new_inquiry")?.status || "failed";
        }
        return sendJson(response, 200, {
            ok: true,
            inquiry_number: result.inquiry_number,
            received_at: result.received_at,
            duplicate: result.duplicate,
            customer_receipt_status: customerReceiptStatus,
            internal_notification_status: internalNotificationStatus
        });
    } catch (error) {
        if (error instanceof ValidationError) {
            return sendJson(response, 400, { ok: false, code: "invalid_input" });
        }
        const code = error?.message === "configuration" ? "service_unavailable" : "registration_failed";
        console.error("pa-inquiry registration failed", code);
        return sendJson(response, 503, { ok: false, code });
    }
};

module.exports.ValidationError = ValidationError;
module.exports.normalizeInquiry = normalizeInquiry;
module.exports.registerInquiry = registerInquiry;
module.exports.requestOriginMatchesHost = requestOriginMatchesHost;
