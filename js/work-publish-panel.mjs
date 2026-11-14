import { missingPublicationFields, publishReviewed, readWorksAdministrator } from './work-reviewed-publish.mjs';
import { getServiceTypeLabels } from './work-taxonomy.mjs';
import { validateFlyerFile } from './work-image-upload.mjs';

export async function verifyStoredPublicationImage(client, bucket, post) {
    if (!post.flyer_path || post.flyer_path.includes('..')) throw new Error('invalid_storage_path');
    const { data } = client.storage.from(bucket).getPublicUrl(post.flyer_path);
    const response = await fetch(data.publicUrl, { cache: 'no-store' });
    if (!response.ok || Number(response.headers.get('content-length')) > 10485760) throw new Error('stored_image_unavailable');
    const bytes = await response.arrayBuffer();
    if (!bytes.byteLength || bytes.byteLength > 10485760) throw new Error('image_size_invalid');
    const sha256 = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), b => b.toString(16).padStart(2, '0')).join('');
    if (sha256 !== post.public_image_sha256) throw new Error('image_sha256_mismatch');
    const file = new File([bytes], 'reviewed-image', { type: (response.headers.get('content-type') || '').split(';')[0] });
    await validateFlyerFile(file);
    return { sha256, decoded: true };
}

const stepNames = ['公演情報確認', '画像確認', '公開内容確認', '正式公開', '公開結果確認'];
const unresolved = new Set();
const element = (tag, value) => {
    const node = document.createElement(tag);
    node.textContent = value;
    return node;
};

export function createReviewedPublishPanel({ client, bucket, container, reload, prepareImage, readReviewImage, canProceed, workUrl }) {
    let post;
    let step;
    let error;
    let busy = false;
    let imageChoice;
    let displayed;
    let imageUrl;
    let imageError;
    let result;
    let renderingGeneration = 0;

    const render = (focus = false) => {
        container.replaceChildren();
        const heading = element('h2', `STEP ${step + 1}　${stepNames[step]}`);
        heading.tabIndex = -1;
        container.append(heading, element('h3', `ID ${post.id}　${post.title}`));
        const add = (label, value) => container.append(element('p', `${label}　${value || '未設定'}`));
        const button = (label, action, secondary = false) => {
            const node = element('button', label);
            node.type = 'button';
            node.className = secondary ? 'button button--secondary' : 'button';
            node.disabled = busy;
            node.addEventListener('click', event => {
                if (event.isTrusted && !busy) action();
            });
            return node;
        };
        if (step === 0 || step === 2 || step === 3) {
            add('開催日・会場', [post.event_date, post.venue, post.venue_address || post.area].filter(Boolean).join(' ｜ '));
            add('出演', post.performer_name);
            add('担当', getServiceTypeLabels(post.service_types).join('、') || (post.role_type ?? post.assignment_items?.join('、')));
            add('開場 / 開演', [post.open_time, post.start_time].map(value => value?.slice(0, 5) || '—').join(' / '));
            add('公式告知', post.official_announcement_url);
        }
        if (step === 1) {
            if (imageUrl) {
                const picture = element('img', '');
                picture.src = imageUrl;
                picture.alt = post.flyer_alt || post.title;
                picture.className = 'publication-step-image';
                container.append(picture);
            }
            if (imageError) add('画像確認エラー', imageError);
            if (displayed) {
                add('確認画像のSHA-256', displayed.sha256);
                if (post.review_image_url || post.public_image_source_url) add('画像出典', post.review_image_url || post.public_image_source_url);
                container.append(button('転載許諾を確認済み・画像ありで進む', () => { imageChoice = true; next(); }, true));
            }
            container.append(button('画像なしで進む', () => { imageChoice = false; next(); }, true));
        }
        if (step === 2 || step === 3) {
            add('掲載文章', post.description);
            add('SEO title', post.seo_title || '自動生成');
            add('meta description', post.meta_description || '自動生成');
            add('公開画像', post.use_image_on_public_page ? '掲載する' : '掲載しない');
            if (post.use_image_on_public_page && imageUrl) {
                const picture = element('img', '');
                picture.src = imageUrl;
                picture.alt = post.flyer_alt || post.title;
                picture.className = 'publication-step-image';
                container.append(picture);
            }
            add('候補SHA-256', post.candidate_hash);
        }
        if (step === 3) {
            const publish = button('この公演を正式公開', publishCurrent);
            publish.disabled ||= unresolved.has(post.id);
            container.append(publish);
        }
        if (step === 4) {
            const url = workUrl(result.slug);
            add('公開URL', url);
            const link = element('a', '公開ページを見る');
            link.href = url;
            link.target = '_blank';
            link.rel = 'noopener noreferrer';
            container.append(link);
        }

        const status = element('p', busy ? '確認中…' : error || '');
        status.setAttribute('role', 'status');
        container.append(status);
        const controls = element('div', '');
        controls.className = 'actions publication-step-controls';
        if (step > 0 && step < 4) controls.append(button('戻る', () => {
            error = '';
            step -= 1;
            render(true);
            if (step === 1) loadImage();
        }, true));
        if (step < 3) {
            const advance = button('次へ', next);
            advance.disabled ||= step === 1 && imageChoice === undefined;
            controls.append(advance);
        }
        container.append(controls);
        if (focus) heading.focus();
    };

    const loadImage = async () => {
        const generation = ++renderingGeneration;
        const current = post;
        if (!post.review_image_url && !post.flyer_path) return;
        try {
            const image = await readReviewImage(post);
            if (generation !== renderingGeneration || post !== current || step !== 1 || busy) return;
            displayed = image;
            imageError = undefined;
            if (imageUrl) URL.revokeObjectURL(imageUrl);
            imageUrl = URL.createObjectURL(image.file);
        } catch (cause) {
            if (generation !== renderingGeneration || post !== current || step !== 1 || busy) return;
            displayed = undefined;
            if (imageUrl) URL.revokeObjectURL(imageUrl);
            imageUrl = undefined;
            imageError = cause.message;
        }
        render();
    };

    async function next() {
        error = canProceed(post);
        if (error) return render();
        if (step === 0) {
            const missing = missingPublicationFields(post);
            if (missing.length) {
                error = `編集・保存してください。不足項目　${missing.join('、')}`;
                return render();
            }
            step = 1;
            render(true);
            loadImage();
            return;
        }
        if (step === 1) {
            if (imageChoice === undefined || (imageChoice && !displayed)) return;
            busy = true;
            render();
            try {
                const actor = await readWorksAdministrator(client);
                if (actor.status !== 'ready') throw new Error('WORKS管理者権限を確認できません。');
                post = await prepareImage(post, imageChoice, displayed);
                step = 2;
            } catch (cause) {
                error = cause.message;
            } finally {
                busy = false;
            }
        } else if (step === 2) {
            step = 3;
        }
        render(true);
    }

    async function publishCurrent() {
        const attemptKey = `works:publication-attempt:${post.id}:${post.candidate_hash}`;
        const storage = globalThis.sessionStorage;
        if (unresolved.has(post.id) || storage?.getItem(attemptKey)) {
            error = '公開結果をDBで確認してください。公開APIの再送は停止しています。';
            return render();
        }
        error = canProceed(post);
        if (error) return render();
        busy = true;
        render();
        try {
            const actor = await readWorksAdministrator(client);
            if (actor.status !== 'ready') throw new Error('WORKS管理者権限を確認できません。');
            storage?.setItem(attemptKey, '1');
            result = await publishReviewed({
                client, pin: post,
                authorization: {
                    workId: post.id, candidateHash: post.candidate_hash, actorId: actor.user.id,
                    instructionRef: 'WORKS管理画面の認証済み管理者による対象候補の正式公開操作',
                    publish: true, image: imageChoice === true
                },
                verifyImage: candidate => verifyStoredPublicationImage(client, bucket, candidate)
            });
            if (result.status === 'needs_readback') {
                unresolved.add(post.id);
                error = '公開結果をDBで確認してください。公開APIの再送は停止しています。';
            } else {
                storage?.removeItem(attemptKey);
                if (result.status === 'published' || result.status === 'already_published') step = 4;
                else error = `公開を停止しました。候補を再確認してください（${result.reason}）。`;
            }
        } catch (cause) {
            error = cause.message;
        } finally {
            busy = false;
            render(true);
        }
        if (step === 4) {
            try { await reload(post.id); }
            catch {
                error = '公開済みです。一覧の再読み込みに失敗しました。';
                render();
            }
        }
    }

    return {
        open(candidate) {
            if (busy) return;
            if (imageUrl) URL.revokeObjectURL(imageUrl);
            post = structuredClone(candidate);
            step = 0;
            error = imageError = imageUrl = displayed = imageChoice = result = undefined;
            container.classList.remove('hidden');
            render(true);
            container.scrollIntoView({ block: 'start' });
        }
    };
}
