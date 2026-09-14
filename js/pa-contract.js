(() => {
    "use strict";
    const renderer = window.PAContractRenderer;
    const byId = (id) => document.getElementById(id);
    const messages = { expired_link: "このURLの有効期限が切れています。ARA-TECHへ再発行をご依頼ください。", revoked_link: "この確認は失効しています。最新のご案内をご確認ください。", invalid_link: "このURLは利用できません。ARA-TECHへお問い合わせください。", case_unavailable: "現在この案件の回答を受け付けていません。ARA-TECHへお問い合わせください。", contract_changed: "確認内容が一致しません。案内されたURLを開き直してください。", consent_required: "同意と確認者氏名をご入力ください。", receipt_unavailable: "正式受注確認書は準備中です。時間をおいてお試しください。", rate_limited: "操作が集中しています。しばらくしてからお試しください。" };
    const previewMode = new URLSearchParams(location.search).get("mode") === "admin-pre-issue";
    let token = "", offer, busy = false, quoteFile = null, dialogReturn = null;

    if (previewMode) {
        document.body.classList.add("pre-issue-preview");
        byId("preview-only-banner").hidden = false;
        byId("status").textContent = "送信前プレビューを読み込んでいます。";
        window.addEventListener("message", (event) => {
            if (event.origin !== location.origin || event.source !== window.parent || event.data?.type !== "pa-contract-preview-model") return;
            try {
                renderer.fill(event.data.snapshot);
                byId("page").hidden = false;
                byId("status").textContent = "";
                for (const id of ["agree", "confirmer", "submit", "preview", "save-quote"]) byId(id).disabled = true;
            } catch { byId("status").textContent = "プレビュー内容を表示できません。"; }
        });
        window.parent.postMessage({ type: "pa-contract-preview-ready" }, location.origin);
        return;
    }

    token = location.hash.slice(1);
    history.replaceState(null, "", location.pathname);
    window.addEventListener("hashchange", () => { if (location.hash) location.reload(); });
    const datetime = (value) => new Date(value).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo", year: "numeric", month: "long", day: "numeric", weekday: "short", hour: "2-digit", minute: "2-digit" });
    async function request(action, extra = {}, binary = false) {
        const response = await fetch("/api/pa-contract", { method: "POST", headers: { "Content-Type": "application/json" }, cache: "no-store", referrerPolicy: "no-referrer", body: JSON.stringify({ action, token, ...extra }) });
        if (binary && response.ok) return response.blob();
        let data; try { data = await response.json(); } catch { /* handled below */ }
        if (!response.ok || !data?.ok) throw Error(data?.code || "service_unavailable");
        return data.result;
    }
    async function quoteBlob() {
        if (quoteFile) return quoteFile;
        const blob = await request("quote", {}, true);
        const hash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", await blob.arrayBuffer())), (value) => value.toString(16).padStart(2, "0")).join("");
        if (hash !== offer.snapshot.estimate.sha256) throw Error("contract_changed");
        quoteFile = { blob, url: URL.createObjectURL(blob) };
        return quoteFile;
    }
    async function save(action, filename, status) {
        try {
            const blob = action === "quote" ? (await quoteBlob()).blob : await request(action, {}, true), link = document.createElement("a"), url = action === "quote" ? (await quoteBlob()).url : URL.createObjectURL(blob);
            link.href = url; link.download = filename; link.click(); status.textContent = "PDFを保存しました。";
            if (action !== "quote") setTimeout(() => URL.revokeObjectURL(url), 1000);
        } catch (error) { status.textContent = messages[error.message] || "PDFを取得できません。ARA-TECHへお問い合わせください。"; }
    }
    function updateSubmit() { byId("submit").disabled = busy || !byId("agree").checked || !byId("confirmer").value.trim(); }
    function accepted() {
        const snapshot = offer.snapshot;
        byId("accepted").hidden = false; byId("confirm-area").hidden = true;
        byId("accepted-at").textContent = datetime(offer.confirmed_at || snapshot.acceptance.confirmed_at);
        byId("accepted-estimate").textContent = `見積 第${snapshot.estimate.revision_number || "—"}版／${renderer.money(snapshot.estimate.amount_minor, snapshot.estimate.currency)}`;
        byId("accepted-due").textContent = snapshot.terms.payment_due_date ? renderer.date(snapshot.terms.payment_due_date) : snapshot.terms.payment_terms;
        byId("save-receipt").onclick = () => save("customer_receipt", `正式受注確認書_${snapshot.case.event_name.replace(/[\\/:*?"<>|]/gu, "").replace(/\s+/gu, "")}.pdf`, byId("accepted-download-status"));
        byId("save-accepted-quote").onclick = () => save("quote", snapshot.estimate.original_filename, byId("accepted-download-status"));
    }
    async function load() {
        if (!/^[a-f0-9]{64}$/u.test(token)) throw Error("invalid_link");
        offer = await request("view"); renderer.fill(offer.snapshot); updateSubmit(); byId("page").hidden = false; byId("status").textContent = "";
        byId("save-quote").onclick = () => save("quote", offer.snapshot.estimate.original_filename, byId("quote-status"));
        byId("preview").onclick = async () => {
            byId("viewer-wrap").hidden = false; byId("quote-status").textContent = "見積書を読み込んでいます。";
            try { const file = await quoteBlob(); byId("pdf-viewer").src = `${file.url}#toolbar=1&navpanes=0&view=FitH`; byId("quote-status").textContent = "表示できない場合は「PDFを保存」からご確認ください。"; }
            catch (error) { byId("quote-status").textContent = messages[error.message] || "見積書を表示できません。"; }
        };
        if (offer.state === "accepted") accepted();
    }
    byId("agree").addEventListener("change", updateSubmit); byId("confirmer").addEventListener("input", updateSubmit);
    byId("accept-form").addEventListener("submit", (event) => {
        event.preventDefault(); if (byId("submit").disabled) return;
        const root = byId("dialog-facts"), snapshot = offer.snapshot; root.replaceChildren();
        renderer.addPair(root, "イベント", snapshot.case.event_name);
        renderer.addPair(root, "開催日時", renderer.date(snapshot.case.event_date) + (snapshot.case.event_time ? ` ${snapshot.case.event_time}` : ""));
        renderer.addPair(root, "見積版", `第${snapshot.estimate.revision_number || "—"}版`);
        renderer.addPair(root, "金額", renderer.money(snapshot.estimate.amount_minor, snapshot.estimate.currency));
        renderer.addPair(root, "支払期限", snapshot.terms.payment_due_date ? renderer.date(snapshot.terms.payment_due_date) : snapshot.terms.payment_terms);
        renderer.addPair(root, "確認者", byId("confirmer").value.trim()); dialogReturn = document.activeElement; byId("final-dialog").showModal(); byId("dialog-back").focus();
    });
    byId("final-dialog").addEventListener("close", () => { if (!busy) dialogReturn?.focus(); });
    byId("final-dialog").addEventListener("keydown", (event) => {
        if (event.key !== "Tab") return;
        const focusable = [byId("dialog-back"), byId("dialog-accept")].filter((item) => !item.disabled), first = focusable[0], last = focusable.at(-1);
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    });
    byId("dialog-accept").addEventListener("click", async (event) => {
        event.preventDefault(); if (busy) return; busy = true; byId("dialog-accept").disabled = true; byId("dialog-back").disabled = true; byId("dialog-status").textContent = "正式依頼を受け付けています。";
        try {
            const result = await request("accept", { offer_id: offer.offer_id, snapshot_sha256: offer.snapshot_sha256, confirmer_name: byId("confirmer").value.trim(), agree: byId("agree").checked });
            offer = await request("view"); dialogReturn = null; busy = false; byId("final-dialog").close(); accepted(); byId("accepted-download-status").textContent = result.email_status === "failed" ? "正式依頼は受け付けました。確認メールは再送準備中です。" : "";
        } catch (error) { byId("dialog-status").textContent = messages[error.message] || "受付結果を確認できません。ページを開き直し、回答受付済みかご確認ください。"; busy = false; byId("dialog-accept").disabled = false; byId("dialog-back").disabled = false; updateSubmit(); }
    });
    window.addEventListener("pagehide", () => { if (quoteFile) URL.revokeObjectURL(quoteFile.url); });
    load().catch((error) => { byId("status").textContent = messages[error.message] || "確認内容を読み込めません。しばらくしてから案内されたURLを開き直してください。"; });
})();
