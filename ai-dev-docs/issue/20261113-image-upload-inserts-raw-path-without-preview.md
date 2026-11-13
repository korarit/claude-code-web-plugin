# Issue: Image upload inserts a raw temporary file path into the prompt textarea with no thumbnail preview or remove chip

## 1. Problem Statement / Reproduction
- **Group**: Group 2 (New Session Composer, Harness Picker, Context Controls, Slash/File Autocomplete & Image Upload)
- **Harness**: All (`claude`, `agy`, `opencode`)
- **Category**: `ux-confusing`
- **Steps to Reproduce**:
  1. Open Harness Web New Session composer.
  2. Click the `Image` button and upload a valid PNG file (or paste an image into the textarea).
  3. Observe the composer footer on Desktop (`1440x900`) and Mobile (`390x844`).
- **Actual Result**:
  - `POST /api/chat/upload` succeeds (`200 OK`) and returns `{ path: "/tmp/e2e-harness-full/git-repo/.harness-web/uploads/<ts>-test-pixel.png", ... }`.
  - The UI directly appends that long raw server filesystem path into the `<textarea>` (`Footer image preview count: 0`).
  - There is no image thumbnail preview, no attachment pill/badge, and no one-click remove (`×`) button; on mobile (`390x844`), the raw path wraps across 3 lines inside the `rows={2}` textarea, obscuring the user's actual prompt text.
  - Screenshots: `/tmp/e2e-harness-full/artifacts/group2-composer-controls/05-after-image-upload.png`, `06-mobile-composer.png`.
- **Expected Result**:
  - Uploaded (or pasted) images display an attachment preview chip/thumbnail above the textarea (with filename, size, and a remove `×` button) while keeping the prompt textarea clean, and append/send the uploaded image path(s) cleanly when sending.

## 2. Root Cause Hypothesis
- `apps/web/src/features/chat/hooks/useChat.ts` lines 653–672 (`uploadImage`) immediately concatenate `uploaded.path` into `drafts[draftKey]` instead of tracking pending image attachments in state (`pendingAttachments` per draft key).
- `apps/web/src/features/chat/components/ChatPanel.tsx` lines 726–788 have no attachment preview strip above the `<textarea>`.

## 3. Proposed Fix(es)
### Option 1: Track `attachments` per `draftKey` in `useChat.ts` and render removable thumbnail chips above the textarea in `ChatPanel.tsx`
- Pros: Clean, familiar chat attachment UX; keeps prompt text readable on desktop and mobile; easy to remove an accidentally uploaded image; still appends the saved path(s) to the outgoing prompt on `send()` for CLI/server compatibility (and allows sending an image even without extra text if desired).
- Cons: Requires small state addition in `useChat.ts` and a static/raw image preview URL (e.g., `/api/workspace/files/raw?path=...` or local `URL.createObjectURL(file)`).

### Option 2: Keep inserting the path into `<textarea>` but show a small non-interactive thumbnail strip if the draft contains `.harness-web/uploads/...`
- Pros: Zero change to `send()` payload logic.
- Cons: Still clutters the textarea with 90+ character paths on mobile and makes removing an image tedious.

### Option 3: Insert a short markdown/token placeholder like `[image: test-pixel.png]` and expand to full path on send
- Pros: Shorter text in textarea.
- Cons: Fragile if user edits inside the token; still lacks visual thumbnail confirmation.

### Recommended: Option 1
- Store `attachments` (filename, server `path`, `previewUrl` via `URL.createObjectURL`, `size`) per `draftKey` in `useChat.ts`, render compact thumbnail + remove (`×`) chips in `ChatPanel.tsx` above the textarea, and include the attachment paths in `send()`.

## 4. File-Level Change Plan
- `apps/web/src/features/chat/hooks/useChat.ts` (lines 98, 482–533, 653–672): Track `pendingImages` per `draftKey`, expose `removeImage(path)`, and include image paths in `send()`.
- `apps/web/src/features/chat/components/ChatPanel.tsx` (near line 748): Render pending image thumbnail chips with remove buttons above the `<textarea>`.
- `apps/web/src/lib/i18n/locales/en.ts`: Add `removeAttachment` aria-label string.

## 5. Test / Verification Plan
- Playwright E2E (`group2-composer-controls.ts`): Upload a PNG via the `Image` button, assert `footer img` count is `1` and displays the uploaded image preview chip with a remove button, verify the textarea stays clean, and verify removing the chip detaches it.
