# Feature Requests for Even Hub SDK & Integrated Platforms (Heads Up Hackathon)

Observed directly while building and simulator-testing **Cue (`@evenrealities/even_hub_sdk@0.0.16`, `evenhub-simulator@0.9.5`, `evenhub-cli@0.2.0`)**:

1. **Native Binary Asset Helper for `ImageRawDataUpdate` (`updateImageRawData`)**
   - *Gap found:* Developers must manually generate `Gray8` luminance byte arrays (`width × height`) or encode monochrome PNG bytes while carefully matching container bounds (`20..288 × 20..144`), and the simulator's binary error message indicates `Gray8` / `Gray4` expectations are strict.
   - *Request:* Expose a lightweight `encodeGray8FromCanvas(canvas | ImageData)` helper inside `@evenrealities/even_hub_sdk` with automatic quantization & dimension assertion.

2. **Structured Simulation Input for Audio PCM Frames in `evenhub-simulator --automation-port`**
   - *Gap found:* `POST /api/input` supports `up`, `down`, `click`, `double_click`, `long_press`, `long_press_release`, and `context_menu`, which is fantastic for CI! However, automated E2E tests cannot yet inject a mock WAV/PCM clip into `AudioEvent` (`bridge.onEvenHubEvent`) via the automation HTTP API.
   - *Request:* Add `POST /api/input/audio` accepting base64 16kHz mono PCM chunks so voice-first Even G2 apps can run deterministic speech-to-intent CI tests without a physical microphone.

3. **Explicit `currentSelectItemIndex: 0` & `eventType` Normalization in Simulator Click Events**
   - *Gap found:* When clicking the first item of a `ListContainerProperty` inside `evenhub-simulator`, the incoming payload can omit `currentSelectItemIndex` (`undefined` instead of `0`) and `eventType`, requiring defensive `?? 0` normalization on every listener.
   - *Request:* Always populate `currentSelectItemIndex: 0` and `eventType: OsEventTypeList.CLICK_EVENT` consistently across hardware and simulator hosts.

4. **System-Level 3-Second Toast Slot / Persistent Mini-Status Header**
   - *Gap found:* Even G2 apps operate single-screen-at-a-time (`createStartUpPageContainer` / `rebuildPageContainer`). Showing an urgent confirmation/undo bar alongside any active screen requires managing dedicated container layout space (`cue-header` / `cue-footer`) or triggering a full page rebuild.
   - *Request:* Provide a lightweight `bridge.showTransientBanner({ text, durationMs })` OS overlay so time-critical safety guards (like Cue's 3s Undo countdown) don't require rebuilding user-facing containers.

5. **Telegram Bot API: Built-in Lightweight "Action Receipt" Thread Reply Flag Without Polling Overhead**
   - *Gap found:* Headless smart-glasses bridges using Bot tokens need clean one-step pairing (`/pair <code>`) and lightweight confirmation receipts without forcing end-users to self-host MTProto sessions or configure webhooks on localhost.
   - *Request:* First-class ephemeral deep-link pairing payloads (`https://t.me/<bot>?start=pair_<code>`) with automatic webhook-free local bridge support inside Telegram Mini Apps for wearables.
