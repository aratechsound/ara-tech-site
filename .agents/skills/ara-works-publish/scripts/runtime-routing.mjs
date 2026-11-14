// Route from observed capabilities. Host labels never grant a capability.
const verified = probe => probe?.status === 'verified' && Boolean(probe.evidence);

export function assessWorksRuntime(probes) {
    const authenticated = verified(probes.adminSession);
    const browserPanel = verified(probes.pcBrowser) && verified(probes.adminPanel);
    const canExecute = verified(probes.authenticatedApi);
    return {
        github: verified(probes.github),
        productionRead: verified(probes.productionRead),
        localArtifacts: verified(probes.localArtifacts),
        pcBrowser: verified(probes.pcBrowser),
        adminSession: authenticated,
        authenticatedApi: canExecute,
        publicationRoute: authenticated && browserPanel ? 'authenticated_browser_panel'
            : authenticated && canExecute ? 'authenticated_api'
            : 'handoff',
        browserReturn: verified(probes.browserReturn)
    };
}

export function prepareWorksHandoff({ taskId, parentTask, event, localHash, workId = null, databaseHash = null, lastRpc = 'not_attempted' }) {
    if (!taskId || !event?.title || !event.event_date || !event.venue || !event.performer_name
        || !/^[a-f0-9]{64}$/.test(localHash || '')
        || (workId !== null && (!Number.isSafeInteger(workId) || workId <= 0 || !/^[a-f0-9]{64}$/.test(databaseHash || '')))
        || (workId === null && databaseHash !== null)
        || !['not_attempted', 'unknown', 'verified'].includes(lastRpc)
        || (lastRpc !== 'not_attempted' && workId === null)) {
        throw new Error('handoff_scope_incomplete');
    }
    return {
        task_id: taskId, parent_task: parentTask || null, event, local_candidate_hash: localHash,
        work_id: workId, database_candidate_hash: databaseHash, last_rpc: lastRpc,
        resume: lastRpc === 'unknown' ? 'read_back_same_work_no_rpc'
            : lastRpc === 'verified' ? 'verify_production' : 'recheck_duplicates_and_existing_admin_session'
    };
}
