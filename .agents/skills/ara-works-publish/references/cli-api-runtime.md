# ARA-TECH WORKS — Windows user-authorized CLI runtime (WKS-004)

## Goal

Supply the **missing authenticated execution surface** for WKS-003 without browser automation or a new gateway. The CLI signs in to the *existing* Supabase Auth project as an authorized user, checks the `work_admins` RLS view, and calls the *existing* `publish_work_candidate` RPC. It never writes `is_published` or approval fields directly.

## One-time login

Windows 11, Node.js 20+, repository checkout, and an authorized WORKS administrator account with password sign-in are required. The public `sb_publishable_` key is read from the existing repository's `js/supabase-config.js`; no elevated key is needed.

Run from the repository root in a Windows Terminal window **operated directly by the Owner**:

```powershell
node .agents/skills/ara-works-publish/scripts/works-publish-cli.mjs login --email aratechsound@gmail.com
```

At the hidden prompt, enter the password **only in the local Windows Terminal**. Do not paste it into Codex, ChatGPT, Git, Bridge, or logs. The CLI verifies the Supabase user ID and WORKS administrator membership and saves **only the refresh token** to `%LOCALAPPDATA%\ARA-TECH\works-publish-refresh.dpapi`, encrypted using Windows DPAPI CurrentUser. The plaintext password is never persisted. The token file is outside the repository. Re-login may be needed if revoked, expired, on another Windows user profile, or after relevant auth-policy changes.

Check the ready state and inspect the current authorized candidate (refresh token rotates securely):

```powershell
node .agents/skills/ara-works-publish/scripts/works-publish-cli.mjs status
node .agents/skills/ara-works-publish/scripts/works-publish-cli.mjs inspect --id 99
```

`AUTHORIZED` means the actual user and `work_admins` membership were verified. There is no SQL role fallback.

## Publish a reviewed candidate

The **Owner must explicitly approve publication of this exact event and the displayed candidate contents**. Codex first fresh-reads the candidate row and ensures identity/content/image match the approved review; the expected SHA must be pinned. Never silently replace a stale hash.

Example for AK-69 ID 99, using previously observed hash **only after fresh review**:

```powershell
node .agents/skills/ara-works-publish/scripts/works-publish-cli.mjs publish --id 99 --hash a78835e593b5e8d63bd404a6ad9ae137f912ebb795d367095dc234da08238216 --owner-ref "WKS-002 explicit Owner publication approval"
```

Processing:
1. Refresh personal session via Supabase Auth password/refresh grant API and immediately save the rotated refresh token encrypted using Windows DPAPI.
2. `GET /auth/v1/user` and `work_admins` user-JWT/RLS identity check.
3. Read ID + pinned candidate hash and publication state. Already-published matching items return `ALREADY_PUBLISHED`; wrong state or modified candidate fails closed.
4. Confirm image actor/time and Storage MIME, signature, maximum 10 MiB, SHA-256, and Windows-native decode. JPEG/PNG are supported; WebP decoder support varies. Intentionally omitted images must be `not_permitted` + public image OFF.
5. Read fresh candidate again and call `POST /rest/v1/rpc/publish_work_candidate` once with the authorized user's JWT. No `is_published` direct update, no service role, no arbitrary SQL.
6. Read back `is_published`, `approved_hash`, `approved_by`, `approved_at`. UNKNOWN RPC outcome is checked by readback without automatic re-execution.
7. Return safe JSON (no JWT or refresh token). Codex must separately check the live site URL, PC/mobile rendering and browser Return.

The CLI does not register new events, select official media, approve unrelated images, create API endpoints, or perform migrations. WKS-003 handles research/candidate/Storage; the CLI handles the final authenticated publication.

## Cost and security

No browser automated clicks for publishing, no new server infrastructure, no `service_role` or management SQL acting as Owner identity, no browser token/cookie/localStorage scraping. Run commands sequentially under the same Windows user (refresh-token rotation invalidates simultaneous refreshes). `logout` deletes the local encrypted token file. The Owner may revoke sign-ins in the official Supabase security settings. If password login has MFA/CAPTCHA or other additional controls, HOLD rather than weaken them.

## Verification

```powershell
node --test .agents/skills/ara-works-publish/scripts/works-publish-cli.test.mjs
```

Local tests are mock/safe-stop tests only; a real Windows E2E requires initial user login, actual RPC, independent Production readback and rendered PC/mobile verification. Login credentials and token files must never be uploaded or returned.
