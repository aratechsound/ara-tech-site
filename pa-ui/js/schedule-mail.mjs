export function scheduleInvitationTemplate(currentCase, url, {formatDate, formatDateTime, fallbackDeadline}) {
    const addressee = currentCase.public_addressee || currentCase.customer_name;
    const eventName = currentCase.public_event_name || currentCase.event_name || "ご相談の案件";
    const eventDate = currentCase.public_event_date || currentCase.event_date;
    const deadline = fallbackDeadline || currentCase.response_deadline;
    const subject = `【ARA-TECH】開催日程についてのご確認／受付番号${currentCase.inquiry_number}`;
    const body = [
        `${addressee} 様`,
        "",
        "ARA-TECHへお問い合わせいただきありがとうございます。",
        "下記案件について、日程確保に必要な条件確認・同意をお願いいたします。",
        "",
        `問い合わせ番号：${currentCase.inquiry_number}`,
        `イベント名：${eventName}`,
        `開催希望日：${formatDate(eventDate)}`,
        `会場・開催場所：${currentCase.public_venue || currentCase.venue || "未設定"}`,
        "",
        "日程確保フォーム専用URL",
        url,
        "",
        `回答期限：${formatDateTime(deadline)}`,
        "",
        "専用URLを開き、表示された案件情報と条件をご確認・同意のうえ、ご回答ください。",
        "日程確保フォームへの回答だけでは、契約・予約または日程確保は確定しません。",
        "ARA-TECHが内容を確認し、日程確保完了の連絡をした時点で確保成立となります。",
        "",
        "ご不明点がございましたら、このメールへご返信ください。",
        ""
    ].join("\n");
    return {subject, body};
}

export function scheduleResultTemplate(currentCase, result, formatDate) {
    const addressee = currentCase.public_addressee || currentCase.contact_name || currentCase.customer_name;
    const summary = [
        `受付番号：${currentCase.inquiry_number}`,
        `開催希望日：${formatDate(currentCase.public_event_date || currentCase.event_date)}`,
        `会場・開催場所：${currentCase.public_venue || currentCase.venue || "未設定"}`
    ];
    if (result === "confirmed") {
        return {
            title: "日程を確保できました",
            subject: `【ARA-TECH】ご希望日の対応日程を確保しました／受付番号${currentCase.inquiry_number}`,
            body: [
                `${addressee} 様`,
                "",
                "ご希望日の対応日程を確保しました。",
                ...summary,
                "",
                "今後、イベント詳細やお見積りについて、ARA-TECHから改めてご連絡いたします。",
                "現段階では、見積承認、契約成立、正式予約完了ではありません。",
                "",
                "ご不明点がございましたら、このメールへご返信ください。",
                ""
            ].join("\n")
        };
    }
    return {
        title: "日程を確保できませんでした",
        subject: `【ARA-TECH】ご希望日の対応日程について／受付番号${currentCase.inquiry_number}`,
        body: [
            `${addressee} 様`,
            "",
            "既存予定の日程調整を行いましたが、ご希望日の対応日程を確保できませんでした。",
            ...summary,
            "",
            "恐れ入りますが、上記の開催希望日では受付できません。",
            "必要に応じて、別日程についてご相談いただけます。",
            "",
            "ご希望がございましたら、このメールへご返信ください。",
            ""
        ].join("\n")
    };
}
