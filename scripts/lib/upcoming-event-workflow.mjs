import { createHash } from 'node:crypto';

export const WORKFLOW_SCHEMA_VERSION = 1;
export const IMAGE_STATUSES = Object.freeze([
    'direct_success',
    'structure_analysis_success',
    'no_image_available',
    'human_action_required'
]);

export const OFFICIAL_SOURCE_TYPES = Object.freeze([
    'venue_official_web',
    'organizer_official_web',
    'artist_official_web',
    'venue_official_instagram',
    'organizer_official_instagram',
    'artist_official_social',
    'other_verified_official'
]);

const APPROVAL_TEXTS = new Set(['OK', '公開して', 'それでいい', 'この内容で公開して']);

const clean = (value) => String(value ?? '').trim();
const pad = (value) => String(value).padStart(2, '0');
const clone = (value) => JSON.parse(JSON.stringify(value));

const validDate = (value) => {
    const match = clean(value).match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!match) return false;
    const [, year, month, day] = match;
    const date = new Date(`${year}-${month}-${day}T00:00:00Z`);
    return date.getUTCFullYear() === Number(year)
        && date.getUTCMonth() + 1 === Number(month)
        && date.getUTCDate() === Number(day);
};

const normalizeDate = (value) => {
    const text = clean(value);
    const japanese = text.match(/(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/);
    if (japanese) return `${japanese[1]}-${pad(japanese[2])}-${pad(japanese[3])}`;
    const iso = text.match(/(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
    return iso ? `${iso[1]}-${pad(iso[2])}-${pad(iso[3])}` : '';
};

const normalizeForMatch = (value) => clean(value)
    .normalize('NFKC')
    .toLocaleLowerCase('ja-JP')
    .replace(/[\s　・･「」『』【】()[\]（）"'“”‘’.,，、／/\\_-]+/g, '');

const equivalentText = (left, right) => {
    const a = normalizeForMatch(left);
    const b = normalizeForMatch(right);
    return Boolean(a && b && (a === b || a.includes(b) || b.includes(a)));
};

const isHttpsUrl = (value) => {
    try { return new URL(clean(value)).protocol === 'https:'; } catch { return false; }
};

const todayInTokyo = (now = new Date()) => new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit'
}).format(now);

const formatJapaneseDate = (date) => {
    const [year, month, day] = clean(date).split('-');
    return year && month && day ? `${year}年${Number(month)}月${Number(day)}日` : clean(date);
};

const truncate = (value, length) => {
    const text = clean(value).replace(/\s+/g, ' ');
    return text.length <= length ? text : `${text.slice(0, length - 1).trim()}…`;
};

const slugify = (value) => clean(value)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 72);

const stableSort = (value) => {
    if (Array.isArray(value)) return value.map(stableSort);
    if (value && typeof value === 'object') {
        return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableSort(value[key])]));
    }
    return value;
};

const hashValue = (value) => createHash('sha256')
    .update(JSON.stringify(stableSort(value)))
    .digest('hex');

const assignmentFromText = (text) => {
    const source = clean(text);
    if (/アーティスト.*(?:PA|ＰＡ)|(?:PA|ＰＡ).*アーティスト/u.test(source)) return {
        service_types: ['artist_pa_operation'], label: 'アーティストPAオペレート'
    };
    if (/簡易照明/.test(source)) return {
        service_types: ['simple_lighting'], label: '簡易照明'
    };
    if (/ステージ照明/.test(source)) return {
        service_types: ['stage_lighting'], label: 'ステージ照明'
    };
    if (/LEDビジョン|映像/.test(source)) return {
        service_types: ['led_video'], label: 'LEDビジョン・映像'
    };
    if (/仮設.*ステージ|ステージ.*設営/.test(source)) return {
        service_types: ['temporary_stage_setup'], label: '仮設ステージ設営'
    };
    if (/トラス/.test(source)) return {
        service_types: ['truss_setup'], label: 'トラス設営'
    };
    if (/技術制作/.test(source)) return {
        service_types: ['event_technical_production'], label: 'イベント技術制作'
    };
    if (/施工|設備/.test(source)) return {
        service_types: ['system_design_construction'], label: 'システム設計・施工'
    };
    if (/PA|ＰＡ|音響/i.test(source)) return {
        service_types: ['pa_sound'], label: 'PA・音響'
    };
    return {
        service_types: [], label: source
    };
};

export const parseInstruction = (instruction) => {
    const raw = clean(instruction);
    const eventDate = normalizeDate(raw);
    const parts = raw
        .replace(/[。．]+$/g, '')
        .split(/[、,，]/)
        .map(clean)
        .filter(Boolean);
    const withoutDate = parts.filter((part) => !normalizeDate(part));
    const actionPattern = /(開催予定.*(?:追加|入れて|登録)|追加して|登録して)/;
    const useful = withoutDate
        .map((part) => part.replace(actionPattern, '').replace(/[。．]+$/g, '').trim())
        .filter(Boolean);
    const assignmentIndex = useful.findIndex((part) => /(PA|ＰＡ|音響|照明|レンタル|施工|設備|担当)/i.test(part));
    const assignmentText = assignmentIndex >= 0 ? useful[assignmentIndex] : '';
    const remaining = useful.filter((_, index) => index !== assignmentIndex);
    const performerOrEventName = remaining[0] || '';
    const venue = remaining[1] || '';
    const assignment = assignmentFromText(assignmentText);
    return {
        event_date: validDate(eventDate) ? eventDate : '',
        performer_or_event_name: performerOrEventName,
        venue,
        ara_assignment_text: assignmentText,
        event_type: '',
        service_types: assignment.service_types,
        assignment_label: assignment.label
    };
};

export const createRequest = (instruction, { now = new Date() } = {}) => {
    const parsed = parseInstruction(instruction);
    const required = ['event_date', 'performer_or_event_name', 'venue', 'ara_assignment_text'];
    const missing = required.filter((field) => !clean(parsed[field]));
    const seed = `${parsed.event_date || todayInTokyo(now)}-${slugify(parsed.performer_or_event_name) || 'event'}-${slugify(parsed.venue) || 'venue'}`;
    return {
        schema_version: WORKFLOW_SCHEMA_VERSION,
        workflow_id: seed,
        status: missing.length ? 'INPUT_CLARIFICATION_REQUIRED' : 'RESEARCH_REQUIRED',
        instruction: clean(instruction),
        received_at: now.toISOString(),
        minimum_input: parsed,
        missing_fields: missing,
        production_mutation_permitted: false
    };
};

export const createResearchTemplate = (request) => ({
    schema_version: WORKFLOW_SCHEMA_VERSION,
    workflow_id: request.workflow_id,
    checked_on: todayInTokyo(new Date(request.received_at)),
    resolved: {
        title: request.minimum_input.performer_or_event_name,
        performer_name: request.minimum_input.performer_or_event_name,
        event_date: request.minimum_input.event_date,
        open_time: null,
        start_time: null,
        venue: request.minimum_input.venue,
        area: '',
        venue_address: '',
        organizer_name: null,
        ticket_information: null,
        official_announcement_url: ''
    },
    official_sources: [],
    conflicts: [],
    image: {
        status: 'no_image_available',
        acquisition_method: 'none',
        source_url: null,
        local_path: null,
        usage_permission: 'not_confirmed',
        alt: ''
    },
    research_notes: ''
});

export const buildResearchChecklist = (request) => {
    const input = request.minimum_input;
    return `# 公式情報調査ブリーフ\n\n`
        + `状態: \`${request.status}\`\n\n`
        + `- 開催日: ${input.event_date || '未取得'}\n`
        + `- アーティスト／イベント: ${input.performer_or_event_name || '未取得'}\n`
        + `- 会場: ${input.venue || '未取得'}\n`
        + `- ARA-TECH担当: ${input.ara_assignment_text || '未取得'}\n\n`
        + `## 公式情報の優先順位\n\n`
        + `1. 会場公式Webサイト\n2. 主催者公式Webサイト\n3. アーティスト公式Webサイト\n`
        + `4. 会場公式Instagram\n5. 主催者公式Instagram\n6. アーティスト公式SNS\n7. その他の明確な公式情報\n\n`
        + `日付、会場、アーティスト／イベント名を公式情報で照合する。第三者まとめサイトや検索結果だけを公開根拠にしない。\n\n`
        + `## 画像探索\n\n`
        + `img src → srcset → OGP → JSON/JSON-LD → 公開API → DOM → Browser Network → 公開CDN URLの順で確認する。`
        + `認証回避、CAPTCHA突破、アクセス制御回避は行わず、その場合は \`human_action_required\` とする。\n\n`
        + `画像を技術的に取得できても、利用確認がない場合は公開候補に含めない。\n`;
};

const sourceConfirms = (sources, field, expected) => sources.some((source) => {
    const actual = source.confirms?.[field];
    if (field === 'event_date') return normalizeDate(actual) === expected;
    return equivalentText(actual, expected);
});

const sourcesConflict = (sources, field) => {
    const values = sources.map((source) => clean(source.confirms?.[field])).filter(Boolean);
    if (values.length < 2) return false;
    for (let left = 0; left < values.length; left += 1) {
        for (let right = left + 1; right < values.length; right += 1) {
            if (field === 'event_date') {
                if (normalizeDate(values[left]) !== normalizeDate(values[right])) return true;
            } else if (!equivalentText(values[left], values[right])) return true;
        }
    }
    return false;
};

const buildDescription = (event, assignmentLabel) => {
    const times = [event.open_time ? `OPEN ${event.open_time}` : '', event.start_time ? `START ${event.start_time}` : '']
        .filter(Boolean).join(' / ');
    const timeSentence = times ? ` ${times}予定です。` : '';
    return `${formatJapaneseDate(event.event_date)}、${event.venue}にて開催予定の「${event.title}」にて、ARA-TECHが${assignmentLabel}を担当予定です。${timeSentence}`
        + `公演・チケット等の詳細は会場・主催者の公式情報をご確認ください。`;
};

const normalizeImage = (image = {}, title = '') => {
    const status = IMAGE_STATUSES.includes(image.status) ? image.status : 'no_image_available';
    const successful = status === 'direct_success' || status === 'structure_analysis_success';
    const usagePermission = ['confirmed', 'not_confirmed', 'unknown'].includes(image.usage_permission)
        ? image.usage_permission : 'not_confirmed';
    const sourceUrl = isHttpsUrl(image.source_url) ? clean(image.source_url) : null;
    const localPath = clean(image.local_path) || null;
    const publicationAllowed = successful && usagePermission === 'confirmed' && Boolean(sourceUrl && localPath);
    return {
        status,
        acquisition_method: clean(image.acquisition_method) || (successful ? 'unspecified' : 'none'),
        source_url: sourceUrl,
        local_path: localPath,
        usage_permission: usagePermission,
        publication_allowed: publicationAllowed,
        alt: clean(image.alt) || `${title}のフライヤー`,
        note: publicationAllowed ? '利用確認済み。公開前レビュー対象。' : '公開ペイロードには画像を含めません。'
    };
};

export const candidateHash = (candidate) => {
    const value = clone(candidate);
    delete value.candidate_hash;
    return hashValue(value);
};

export const buildCandidate = (request, research, { now = new Date() } = {}) => {
    const input = request.minimum_input || {};
    const resolved = research.resolved || {};
    const event = {
        title: clean(resolved.title) || clean(input.performer_or_event_name),
        performer_name: clean(resolved.performer_name) || clean(input.performer_or_event_name),
        event_date: normalizeDate(resolved.event_date) || clean(input.event_date),
        open_time: clean(resolved.open_time) || null,
        start_time: clean(resolved.start_time) || null,
        venue: clean(resolved.venue) || clean(input.venue),
        area: clean(resolved.area),
        venue_address: clean(resolved.venue_address) || null,
        organizer_name: clean(resolved.organizer_name) || null,
        ticket_information: clean(resolved.ticket_information) || null
    };
    const sources = (Array.isArray(research.official_sources) ? research.official_sources : [])
        .filter((source) => OFFICIAL_SOURCE_TYPES.includes(source.type) && isHttpsUrl(source.url))
        .map((source) => ({
            type: source.type,
            label: clean(source.label) || source.type,
            url: clean(source.url),
            confirms: source.confirms || {}
        }));
    const officialUrl = clean(resolved.official_announcement_url) || sources[0]?.url || '';
    const blockers = [];
    if (clean(research.workflow_id) !== clean(request.workflow_id)) blockers.push('workflow_id:mismatch');
    const required = {
        title: event.title,
        performer_name: event.performer_name,
        event_date: event.event_date,
        venue: event.venue,
        area: event.area,
        official_announcement_url: officialUrl,
        announcement_confirmed_on: research.checked_on,
        ara_assignment_text: input.ara_assignment_text
    };
    for (const [field, value] of Object.entries(required)) if (!clean(value)) blockers.push(`${field}:missing`);
    if (!validDate(event.event_date)) blockers.push('event_date:invalid');
    if (validDate(event.event_date) && event.event_date < todayInTokyo(now)) blockers.push('event_date:past');
    if (!validDate(research.checked_on) || research.checked_on > todayInTokyo(now)) blockers.push('checked_on:invalid');
    if (!isHttpsUrl(officialUrl) || !sources.some((source) => source.url === officialUrl)) blockers.push('official_announcement_url:not_verified_source');
    if (!sourceConfirms(sources, 'event_date', event.event_date)) blockers.push('official_source:event_date_unconfirmed');
    if (!sourceConfirms(sources, 'venue', event.venue)) blockers.push('official_source:venue_unconfirmed');
    if (!sourceConfirms(sources, 'performer_or_event_name', event.performer_name)
        && !sourceConfirms(sources, 'performer_or_event_name', event.title)) blockers.push('official_source:performer_or_event_unconfirmed');
    for (const field of ['event_date', 'venue', 'performer_or_event_name']) {
        if (sourcesConflict(sources, field)) blockers.push(`official_sources:${field}_conflict`);
    }
    if (input.event_date && input.event_date !== event.event_date) blockers.push('request_vs_official:event_date_conflict');
    if (input.venue && !equivalentText(input.venue, event.venue)) blockers.push('request_vs_official:venue_conflict');
    if (input.performer_or_event_name
        && !equivalentText(input.performer_or_event_name, event.performer_name)
        && !equivalentText(input.performer_or_event_name, event.title)) blockers.push('request_vs_official:performer_or_event_conflict');
    for (const conflict of Array.isArray(research.conflicts) ? research.conflicts : []) blockers.push(`research_conflict:${clean(conflict)}`);

    const image = normalizeImage(research.image, event.title);
    const assignmentLabel = clean(input.assignment_label) || clean(input.ara_assignment_text);
    const description = buildDescription(event, assignmentLabel);
    const slugBase = slugify(`${event.event_date.slice(0, 4)} ${event.title} ${event.venue}`)
        || `${event.event_date.slice(0, 4)}-upcoming-event`;
    const eventType = clean(input.event_type);
    const serviceTypes = Array.isArray(input.service_types) ? input.service_types : [];
    if (!eventType) blockers.push('event_type:required');
    if (!serviceTypes.length) blockers.push('service_types:required');
    const status = blockers.length ? 'RESEARCH_REVIEW_REQUIRED' : 'PUBLICATION_PENDING_APPROVAL';
    const databasePayload = {
        title: event.title,
        slug: slugBase,
        event_date: event.event_date,
        event_type: eventType || null,
        lifecycle_status: 'upcoming',
        performer_name: event.performer_name,
        area: event.area,
        venue_address: event.venue_address,
        organizer_name: event.organizer_name,
        official_announcement_url: officialUrl,
        announcement_confirmed_on: null,
        service_plan: null,
        participant_groups: null,
        system_setup: null,
        service_types: serviceTypes.length ? serviceTypes : null,
        operation_artists: serviceTypes.includes('artist_pa_operation') ? event.performer_name : null,
        artists: serviceTypes.includes('artist_pa_operation') ? event.performer_name : null,
        venue: event.venue,
        description,
        flyer_path: null,
        flyer_alt: null,
        is_published: false,
        publish_at: null
    };
    const candidate = {
        schema_version: WORKFLOW_SCHEMA_VERSION,
        workflow_id: request.workflow_id,
        status,
        generated_at: now.toISOString(),
        revision: 0,
        event,
        ara_assignment: {
            original_text: input.ara_assignment_text,
            display_label: assignmentLabel,
            event_type: eventType || null,
            service_types: serviceTypes
        },
        official_information: {
            announcement_url: officialUrl,
            checked_on: research.checked_on || null,
            sources,
            research_notes: clean(research.research_notes) || null
        },
        image,
        publication: {
            description,
            proposed_slug: slugBase,
            proposed_url: `https://ara-tech.cc/works/${slugBase}.html`,
            slug_uniqueness_check_required: true,
            publication_mode: 'now_after_approval'
        },
        seo: {
            title: `${event.title}｜${event.event_date.slice(0, 4)}年 ${event.venue}｜ARA-TECH 音響担当予定`,
            meta_description: truncate(description, 155)
        },
        database_payload: databasePayload,
        blockers,
        production_mutation_permitted: false
    };
    candidate.candidate_hash = candidateHash(candidate);
    return candidate;
};

export const renderReview = (candidate) => {
    const event = candidate.event;
    const sources = candidate.official_information.sources
        .map((source) => `- ${source.label}: ${source.url}`).join('\n') || '- なし';
    const imagePath = candidate.image.publication_allowed ? candidate.image.local_path : '画像なしで公開予定';
    return `# 公開予定内容\n\n`
        + `状態: \`${candidate.status}\`\n`
        + `候補ハッシュ: \`${candidate.candidate_hash}\`\n\n`
        + `- 開催日: ${event.event_date || '未確定'}\n`
        + `- 公演名: ${event.title || '未確定'}\n`
        + `- 出演者／イベント: ${event.performer_name || '未確定'}\n`
        + `- 会場: ${event.venue || '未確定'}\n`
        + `- 地域: ${event.area || '未確定'}\n`
        + `- 住所: ${event.venue_address || '未取得'}\n`
        + `- OPEN / START: ${event.open_time || '未取得'} / ${event.start_time || '未取得'}\n`
        + `- ARA-TECH担当: ${candidate.ara_assignment.display_label || '未確定'}\n`
        + `- 掲載文章: ${candidate.publication.description}\n`
        + `- 公式URL: ${candidate.official_information.announcement_url || '未確定'}\n`
        + `- 公式情報調査日: ${candidate.official_information.checked_on || '未確定'}\n`
        + `- 告知解禁確認日（本番登録）: 代表承認日\n`
        + `- 使用予定画像: ${imagePath}\n`
        + `- 画像取得状態: ${candidate.image.status}\n`
        + `- 画像取得方法: ${candidate.image.acquisition_method}\n`
        + `- 画像取得元: ${candidate.image.source_url || 'なし'}\n`
        + `- 画像利用確認: ${candidate.image.usage_permission}\n`
        + `- 公開URL案: ${candidate.publication.proposed_url}\n`
        + `- SEO title: ${candidate.seo.title}\n`
        + `- meta description: ${candidate.seo.meta_description}\n\n`
        + `## 公式情報元\n\n${sources}\n\n`
        + (candidate.blockers.length ? `## 確認が必要な項目\n\n${candidate.blockers.map((item) => `- ${item}`).join('\n')}\n\n` : '')
        + `## 公開確認\n\n**この内容で公開してよいか、明示的に確認してください。**\n\n`
        + `承認されるまで本番DB・Storageには一切反映しません。\n`;
};

const mergeSection = (target, patch, key) => {
    if (patch[key] && typeof patch[key] === 'object') target[key] = { ...target[key], ...patch[key] };
};

export const reviseCandidate = (candidate, patch, { now = new Date() } = {}) => {
    if (candidate.candidate_hash !== candidateHash(candidate)) throw new Error('Candidate hash does not match its content.');
    const next = clone(candidate);
    for (const key of ['event', 'ara_assignment', 'official_information', 'image', 'publication', 'seo']) mergeSection(next, patch, key);
    if (patch.image && Object.hasOwn(patch.image, 'source_url') && !Object.hasOwn(patch.image, 'local_path')) {
        next.image.local_path = null;
    }
    const coreChanged = Boolean(
        patch.event && ['title', 'performer_name', 'event_date', 'open_time', 'start_time', 'venue', 'area', 'venue_address', 'organizer_name', 'ticket_information']
            .some((key) => Object.hasOwn(patch.event, key))
        || patch.official_information && ['announcement_url', 'checked_on', 'sources']
            .some((key) => Object.hasOwn(patch.official_information, key))
    );
    const retainedBlockers = (Array.isArray(candidate.blockers) ? [...candidate.blockers] : [])
        .filter((blocker) => !['event_type:required', 'service_types:required'].includes(blocker));
    next.revision = Number(candidate.revision || 0) + 1;
    next.generated_at = now.toISOString();
    next.production_mutation_permitted = false;
    if (patch.image) next.image = normalizeImage(next.image, next.event.title);
    const eventType = clean(next.ara_assignment.event_type);
    const serviceTypes = Array.isArray(next.ara_assignment.service_types) ? next.ara_assignment.service_types : [];
    if (!eventType) retainedBlockers.push('event_type:required');
    if (!serviceTypes.length) retainedBlockers.push('service_types:required');
    next.status = coreChanged
        ? 'RESEARCH_RECHECK_REQUIRED'
        : retainedBlockers.length ? 'RESEARCH_REVIEW_REQUIRED' : 'PUBLICATION_PENDING_APPROVAL';
    next.database_payload = {
        ...next.database_payload,
        title: next.event.title,
        slug: next.publication.proposed_slug,
        event_date: next.event.event_date,
        event_type: eventType || null,
        venue: next.event.venue,
        performer_name: next.event.performer_name,
        area: next.event.area,
        venue_address: next.event.venue_address,
        organizer_name: next.event.organizer_name,
        official_announcement_url: next.official_information.announcement_url,
        description: next.publication.description,
        service_types: serviceTypes.length ? serviceTypes : null,
        operation_artists: serviceTypes.includes('artist_pa_operation') ? next.event.performer_name : null,
        artists: serviceTypes.includes('artist_pa_operation') ? next.event.performer_name : null,
        is_published: false,
        publish_at: null
    };
    next.blockers = coreChanged ? ['revision:official_information_recheck_required'] : retainedBlockers;
    next.candidate_hash = candidateHash(next);
    return next;
};

export const createApproval = (candidate, approvalText, {
    approvedBy = 'representative', now = new Date()
} = {}) => {
    if (candidate.status !== 'PUBLICATION_PENDING_APPROVAL' || candidate.blockers?.length) {
        throw new Error(`Candidate is not approvable: ${candidate.status}`);
    }
    const text = clean(approvalText);
    if (!APPROVAL_TEXTS.has(text)) throw new Error('Explicit approval text is required.');
    const currentHash = candidateHash(candidate);
    if (candidate.candidate_hash !== currentHash) throw new Error('Candidate hash does not match its content.');
    return {
        schema_version: WORKFLOW_SCHEMA_VERSION,
        workflow_id: candidate.workflow_id,
        status: 'APPROVED',
        candidate_hash: currentHash,
        approval_text: text,
        approved_by: clean(approvedBy) || 'representative',
        approved_at: now.toISOString()
    };
};

export const exportPublication = (candidate, approval, { now = new Date() } = {}) => {
    const currentHash = candidateHash(candidate);
    if (candidate.candidate_hash !== currentHash) throw new Error('Candidate hash does not match its content.');
    if (candidate.status !== 'PUBLICATION_PENDING_APPROVAL') throw new Error('Candidate is not pending approval.');
    if (candidate.blockers?.length) throw new Error('Candidate still has blockers.');
    if (approval?.status !== 'APPROVED' || approval.candidate_hash !== currentHash) {
        throw new Error('A matching approval receipt is required.');
    }
    return {
        schema_version: WORKFLOW_SCHEMA_VERSION,
        workflow_id: candidate.workflow_id,
        status: 'READY_FOR_EXISTING_ADMIN_PUBLICATION',
        exported_at: now.toISOString(),
        candidate_hash: currentHash,
        approval,
        admin_url: 'https://ara-tech.cc/admin.html',
        publication_mode: 'now',
        image_upload: candidate.image.publication_allowed ? {
            local_path: candidate.image.local_path,
            source_url: candidate.image.source_url,
            acquisition_method: candidate.image.acquisition_method,
            alt: candidate.image.alt,
            usage_permission: candidate.image.usage_permission
        } : null,
        payload: {
            ...candidate.database_payload,
            flyer_alt: candidate.image.publication_allowed ? candidate.image.alt : null,
            announcement_confirmed_on: todayInTokyo(new Date(approval.approved_at)),
            is_published: true,
            publish_at: null
        },
        safety: {
            use_existing_authenticated_admin: true,
            verify_slug_uniqueness_before_save: true,
            direct_service_role_usage_permitted: false,
            post_publication_verification_required: true
        }
    };
};
