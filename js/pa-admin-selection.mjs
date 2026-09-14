const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export function resolveRequestedCase({ requestedCaseId, activeCaseIds = [], archivedCaseIds = [] }) {
    const id = String(requestedCaseId || "").trim();
    if (!id) return { state: "none", id: "" };
    if (!UUID.test(id)) return { state: "invalid", id };
    if (activeCaseIds.includes(id)) return { state: "active", id };
    if (archivedCaseIds.includes(id)) return { state: "archived", id };
    return { state: "missing", id };
}

export function withoutRequestedCase(href) {
    const url = new URL(href);
    url.searchParams.delete("case");
    return url.toString();
}
