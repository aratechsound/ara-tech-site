#!/usr/bin/env node
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import {
    buildCandidate,
    buildResearchChecklist,
    createApproval,
    createRequest,
    createResearchTemplate,
    exportPublication,
    renderReview,
    reviseCandidate
} from './lib/upcoming-event-workflow.mjs';

const args = process.argv.slice(2);
const command = args.shift();

const option = (name, fallback = '') => {
    const index = args.indexOf(`--${name}`);
    return index >= 0 ? args[index + 1] : fallback;
};

const required = (name) => {
    const value = option(name);
    if (!value) throw new Error(`--${name} is required.`);
    return value;
};

const readJson = async (path) => JSON.parse(await readFile(resolve(path), 'utf8'));
const writeText = async (path, value) => {
    const target = resolve(path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, value, 'utf8');
    return target;
};
const writeJson = (path, value) => writeText(path, `${JSON.stringify(value, null, 2)}\n`);

const parseNow = () => option('now') ? new Date(option('now')) : new Date();

const printHelp = () => console.log(`Usage:
  node scripts/add-upcoming-event.mjs init --instruction "2026年8月14日、BURK、Club L2、PA担当。開催予定に追加" [--out-dir work/upcoming-events/example]
  node scripts/add-upcoming-event.mjs prepare --request <request.json> --research <research.json> [--out-dir <dir>]
  node scripts/add-upcoming-event.mjs revise --candidate <candidate.json> --patch <patch.json> [--out-dir <dir>]
  node scripts/add-upcoming-event.mjs approve --candidate <candidate.json> --approval "OK" [--approved-by representative] [--out <approval.json>]
  node scripts/add-upcoming-event.mjs export --candidate <candidate.json> --approval-file <approval.json> [--out <publication-payload.json>]

The export command never writes to Supabase or Storage. Use the existing authenticated admin only after approval.`);

const main = async () => {
    if (!command || ['help', '--help', '-h'].includes(command)) { printHelp(); return; }
    if (command === 'init') {
        const now = parseNow();
        const request = createRequest(required('instruction'), { now });
        const outDir = resolve(option('out-dir', `work/upcoming-events/${request.workflow_id}`));
        const requestPath = await writeJson(`${outDir}/request.json`, request);
        await writeJson(`${outDir}/research.json`, createResearchTemplate(request));
        await writeText(`${outDir}/research-checklist.md`, buildResearchChecklist(request));
        console.log(JSON.stringify({ status: request.status, out_dir: outDir, request: requestPath }, null, 2));
        return;
    }
    if (command === 'prepare') {
        const requestPath = resolve(required('request'));
        const request = await readJson(requestPath);
        const research = await readJson(required('research'));
        const candidate = buildCandidate(request, research, { now: parseNow() });
        const outDir = resolve(option('out-dir', dirname(requestPath)));
        const candidatePath = await writeJson(`${outDir}/candidate.json`, candidate);
        const reviewPath = await writeText(`${outDir}/review.md`, renderReview(candidate));
        await writeJson(`${outDir}/state.json`, { status: candidate.status, candidate_hash: candidate.candidate_hash, blockers: candidate.blockers });
        console.log(JSON.stringify({ status: candidate.status, candidate: candidatePath, review: reviewPath }, null, 2));
        return;
    }
    if (command === 'revise') {
        const candidatePath = resolve(required('candidate'));
        const candidate = await readJson(candidatePath);
        const patch = await readJson(required('patch'));
        const revised = reviseCandidate(candidate, patch, { now: parseNow() });
        const outDir = resolve(option('out-dir', dirname(candidatePath)));
        const revisedPath = await writeJson(`${outDir}/candidate.json`, revised);
        await writeText(`${outDir}/review.md`, renderReview(revised));
        await writeJson(`${outDir}/state.json`, { status: revised.status, candidate_hash: revised.candidate_hash, blockers: revised.blockers });
        console.log(JSON.stringify({ status: revised.status, candidate: revisedPath }, null, 2));
        return;
    }
    if (command === 'approve') {
        const candidatePath = resolve(required('candidate'));
        const candidate = await readJson(candidatePath);
        const approval = createApproval(candidate, required('approval'), {
            approvedBy: option('approved-by', 'representative'), now: parseNow()
        });
        const target = option('out', `${dirname(candidatePath)}/approval.json`);
        console.log(JSON.stringify({ status: approval.status, approval: await writeJson(target, approval), candidate_hash: approval.candidate_hash }, null, 2));
        return;
    }
    if (command === 'export') {
        const candidatePath = resolve(required('candidate'));
        const candidate = await readJson(candidatePath);
        const approval = await readJson(required('approval-file'));
        const publication = exportPublication(candidate, approval, { now: parseNow() });
        const target = option('out', `${dirname(candidatePath)}/publication-payload.json`);
        console.log(JSON.stringify({ status: publication.status, publication: await writeJson(target, publication), candidate_hash: publication.candidate_hash }, null, 2));
        return;
    }
    throw new Error(`Unknown command: ${command}`);
};

main().catch((error) => {
    console.error(`add-upcoming-event: ${error.message}`);
    process.exitCode = 1;
});
