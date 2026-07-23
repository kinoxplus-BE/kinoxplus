# KinoX+ Auth — React Native Integration Guide

Complete integration guide for the KinoX+ auth backend. Covers the 3-step signup wizard, login (with 2FA branch), Google sign-in, device / sessions management, password reset, and every error code. Everything below is production-live.

**Backend base URL:** `https://kinoxplus.onrender.com`
**Live Swagger:** `https://kinoxplus.onrender.com/api/docs`
**OpenAPI JSON (for codegen):** `https://kinoxplus.onrender.com/api/docs-json`
**Contact:** Abraham (backend) — ping on any 500, unexpected 4xx, or anything that reads like the docs are wrong.

---

## Contents

1. Install + codegen
2. Token storage
3. HTTP client with auto-refresh
4. Collecting device info
5. Login flow — handling the 2FA branch
6. The 3-step signup wizard
7. Google sign-in
8. 2FA setup / enable / disable
9. Sessions ("Manage devices" screen)
10. Profile + avatar upload
11. Password reset
12. Logout
13. Post-registration email verification
14. Error code catalog
15. Response envelope
16. Common footguns

---

## 1. Install + codegen

Skip writing `fetch` calls by hand — generate a typed React Query client from the OpenAPI spec.

```bash
npm i @tanstack/react-query axios
npm i @react-native-google-signin/google-signin
npx expo install expo-secure-store expo-device expo-application
npm i -D orval
```

Add `orval.config.ts` at the repo root:

```ts
import { defineConfig } from 'orval';

export default defineConfig({
  kinox: {
    input: 'https://kinoxplus.onrender.com/api/docs-json',
    output: {
      target: './src/api/generated.ts',
      client: 'react-query',
      httpClient: 'axios',
      override: {
        mutator: { path: './src/api/http.ts', name: 'http' },
      },
    },
  },
});
```

Add to `package.json`:

```json
"scripts": {
  "api:generate": "orval"
}
```

Run `npm run api:generate` — you now have typed hooks: `useAuthRegister`, `useAuthLogin`, `useAuthGoogleSignIn`, `useAuth2faSetup`, `useUsersMeSessions`, etc. Re-run whenever the backend ships an API change (I'll flag them in commits).

---

## 2. Token storage — do NOT use AsyncStorage

Tokens (especially refresh tokens) are password-grade credentials. Use OS keychain:

```ts
// src/api/token-store.ts
import * as SecureStore from 'expo-secure-store';

const ACCESS = 'kinox.accessToken';
const REFRESH = 'kinox.refreshToken';

export const tokens = {
  get: async () => ({
    access: await SecureStore.getItemAsync(ACCESS),
    refresh: await SecureStore.getItemAsync(REFRESH),
  }),
  set: async (access: string, refresh: string) => {
    await SecureStore.setItemAsync(ACCESS, access);
    await SecureStore.setItemAsync(REFRESH, refresh);
  },
  clear: async () => {
    await SecureStore.deleteItemAsync(ACCESS);
    await SecureStore.deleteItemAsync(REFRESH);
  },
};
```

---

## 3. HTTP client with auto-refresh

```ts
// src/api/http.ts
import axios, { AxiosRequestConfig } from 'axios';
import { tokens } from './token-store';

const client = axios.create({
  baseURL: 'https://kinoxplus.onrender.com',
});

// Attach access token to every request.
client.interceptors.request.use(async (config) => {
  const { access } = await tokens.get();
  if (access) config.headers.Authorization = `Bearer ${access}`;
  return config;
});

// Auto-refresh on 401 TOKEN_EXPIRED — retry the original request once.
let refreshing: Promise<void> | null = null;
client.interceptors.response.use(
  (r) => r,
  async (error) => {
    const status = error.response?.status;
    const code = error.response?.data?.code;
    const original = error.config;

    if (status === 401 && code === 'TOKEN_EXPIRED' && !original._retried) {
      original._retried = true;
      refreshing ??= (async () => {
        const { refresh } = await tokens.get();
        if (!refresh) throw new Error('No refresh token');
        const res = await axios.post(
          'https://kinoxplus.onrender.com/auth/refresh',
          { refreshToken: refresh },
        );
        const { accessToken, refreshToken } = res.data.data;
        await tokens.set(accessToken, refreshToken);
      })();
      try {
        await refreshing;
      } finally {
        refreshing = null;
      }
      return client(original);
    }

    // TOKEN_REUSED = the backend detected token theft and revoked every
    // session — force the user back to login.
    if (status === 401 && code === 'TOKEN_REUSED') {
      await tokens.clear();
    }

    throw error;
  },
);

// orval mutator signature.
export const http = <T>(config: AxiosRequestConfig): Promise<T> =>
  client(config).then((r) => r.data);
```

**About refresh tokens:** every `/auth/refresh` call returns a **new** refresh token and invalidates the old one (token rotation). If you keep the old refresh token by accident, the backend detects reuse and revokes every session for that user on all devices. So: always overwrite storage with the fresh values.

---

## 4. Collecting device info

Every login endpoint accepts an optional `device` object. Send it — it powers the "Manage devices" screen.

```ts
// src/api/device-info.ts
import * as Device from 'expo-device';
import * as Application from 'expo-application';
import { Platform } from 'react-native';

export function getDeviceInfo() {
  return {
    deviceName: Device.deviceName ?? undefined,
    deviceModel: Device.modelName ?? undefined,
    platform: Platform.OS === 'ios'
      ? 'ios'
      : Platform.OS === 'android'
        ? 'android'
        : 'web',
    osVersion: Device.osVersion ?? undefined,
    appVersion: Application.nativeApplicationVersion ?? undefined,
  };
}
```

Use this on every login-adjacent request: `login`, `register`, `googleSignIn`, `2fa/challenge`, `changePassword`, `verifyOtp` (login purpose). **Refresh doesn't need it** — the backend inherits device info from the previous token automatically.

---

## 5. Login flow — handling the 2FA branch

`POST /auth/login` returns **one of two shapes**:

```ts
type LoginResult = AuthSession | TwoFactorRequired;

interface AuthSession {
  user: { id: string; email: string; username: string; /* ... */ };
  accessToken: string;
  refreshToken: string;
}

interface TwoFactorRequired {
  requiresTwoFactor: true;
  challengeToken: string;   // valid 5 min
  expiresIn: number;        // 300
}

function isTwoFactorRequired(r: LoginResult): r is TwoFactorRequired {
  return 'requiresTwoFactor' in r;
}
```

TypeScript will force you to discriminate — that's the point.

```ts
const { mutateAsync: login } = useAuthLogin();
const { mutateAsync: challenge } = useAuth2faChallenge();

async function handleLogin(identifier: string, password: string) {
  const res = await login({
    data: { identifier, password, device: getDeviceInfo() },
  });

  if (isTwoFactorRequired(res.data)) {
    // Push to 2FA screen carrying the challengeToken
    navigation.navigate('TwoFactor', {
      challengeToken: res.data.challengeToken,
    });
    return;
  }

  await tokens.set(res.data.accessToken, res.data.refreshToken);
  navigation.navigate('Home');
}

async function handleTwoFactorCode(challengeToken: string, code: string) {
  const res = await challenge({
    data: { challengeToken, code, device: getDeviceInfo() },
  });
  await tokens.set(res.data.accessToken, res.data.refreshToken);
  navigation.navigate('Home');
}
```

**`identifier`** is email OR E.164 phone (`+2348012345678`). The backend routes on the presence of `@`.

**`INVALID_CREDENTIALS` (401)** is the only error users see for wrong email or wrong password. Don't distinguish in the UI — the backend hides which is wrong on purpose (anti-enumeration).

---

## 6. The 3-step signup wizard

Choreography:

```
Step 1  (personal details)                              ← client state
Step 2  (categories)                                    ← client state
   └─ POST /auth/otp/request  { identifier: email, purpose: 'signup' }
"Check your email" screen
   └─ POST /auth/otp/verify   { identifier, code, purpose: 'signup' }
      → { verified: true, signupToken, expiresIn: 1800 }
Step 3  (username, avatarColor, bio)                    ← client state
"Create Account"
   └─ POST /auth/register     { ...all wizard fields, signupToken, device }
      → { user, accessToken, refreshToken }
→ dashboard
```

### Wizard state hook

```ts
type WizardState = {
  // step 1
  fullName?: string;
  email?: string;
  password?: string;
  dateOfBirth?: string;         // 'YYYY-MM-DD'
  // step 2
  preferredGenres?: string[];   // min 3
  // between 2 and 3
  signupToken?: string;
  // step 3
  username?: string;
  avatarColor?: string;         // '#3652D9'
  bio?: string;
};
```

### After step 2 → request OTP

```ts
const { mutateAsync: requestOtp } = useAuthOtpRequest();

await requestOtp({
  data: { identifier: state.email!, purpose: 'signup' },
});
navigation.navigate('CheckEmail');
```

- `409 EMAIL_EXISTS` → the email is already registered. Bounce to step 1 with an inline error and a "Log in instead" CTA.
- `429 OTP_COOLDOWN` → hit the button too fast (60s per identifier). Disable the button and show a countdown.

### Verify the code

```ts
const { mutateAsync: verifyOtp } = useAuthOtpVerify();

const res = await verifyOtp({
  data: { identifier: state.email!, code, purpose: 'signup' },
});
setSignupToken(res.data.signupToken); // valid 30 min
navigation.navigate('Step3');
```

Errors: `OTP_INVALID` (wrong code — message includes attempts remaining), `OTP_EXPIRED` (10-min OTP window elapsed), `OTP_MAX_ATTEMPTS` (3 wrong tries — force Resend).

### Resend code

Same endpoint. Disable the Resend button for 60s per identifier.

```ts
await requestOtp({
  data: { identifier: state.email!, purpose: 'signup' },
});
```

### Username availability on step 3

Debounce 300ms so you don't hammer the endpoint:

```ts
const [debouncedUsername] = useDebounce(username, 300);
const { data } = useAuthUsernameAvailable(
  { username: debouncedUsername },
  { query: { enabled: debouncedUsername.length >= 3 } },
);
// data?.available === true | false
```

Rate-limited 20/min per IP.

### Final submit

```ts
const { mutateAsync: register } = useAuthRegister();

const res = await register({
  data: {
    fullName: state.fullName!,
    email: state.email!,
    password: state.password!,
    dateOfBirth: state.dateOfBirth!,
    preferredGenres: state.preferredGenres!,
    signupToken: state.signupToken!,
    username: state.username!,
    avatarColor: state.avatarColor,
    bio: state.bio,
    device: getDeviceInfo(),
  },
});

const { user, accessToken, refreshToken } = res.data;
await tokens.set(accessToken, refreshToken);
navigation.navigate('Home');
```

Errors:
- `SIGNUP_TOKEN_INVALID` — the 30-min window elapsed. Send the user back to the OTP screen.
- `EMAIL_EXISTS` — someone claimed the email between steps 2 and 3 (rare race). Back to step 1.
- `USERNAME_TAKEN` — someone else registered the same username after your availability check. Stay on step 3, flag the field.
- `AGE_RESTRICTION` — under 13. Full stop.

---

## 7. Google sign-in

### Configure `@react-native-google-signin/google-signin`

At app startup:

```ts
import { GoogleSignin } from '@react-native-google-signin/google-signin';

GoogleSignin.configure({
  webClientId: 'YOUR_WEB_CLIENT_ID.apps.googleusercontent.com',
  // ↑ The SAME Client ID Abraham set as GOOGLE_CLIENT_ID on Render.
  // Even on iOS/Android native, use the WEB client ID here — the backend
  // validates audience against that.
});
```

Ask Abraham for the client ID when he creates it.

### The Sign-In With Google button

```ts
import { GoogleSignin, statusCodes } from '@react-native-google-signin/google-signin';

const { mutateAsync: googleSignIn } = useAuthGoogleSignIn();

async function onPressGoogle() {
  try {
    await GoogleSignin.hasPlayServices();
    const info = await GoogleSignin.signIn();
    const idToken = info.data?.idToken;
    if (!idToken) throw new Error('No idToken from Google');

    const res = await googleSignIn({
      data: { idToken, device: getDeviceInfo() },
    });

    // Same discrimination as regular login:
    if (isTwoFactorRequired(res.data)) {
      navigation.navigate('TwoFactor', { challengeToken: res.data.challengeToken });
      return;
    }
    await tokens.set(res.data.accessToken, res.data.refreshToken);

    // New Google users get a placeholder username like `user_a1b2c3d4`.
    // Nudge them to set a real one before they enter a Watch Room.
    if (res.data.user.username?.startsWith('user_')) {
      navigation.navigate('PickUsername');
    } else {
      navigation.navigate('Home');
    }
  } catch (e: any) {
    if (e.code === statusCodes.SIGN_IN_CANCELLED) return; // user backed out
    if (e.code === statusCodes.IN_PROGRESS) return;       // already prompting
    // Everything else → show a generic "Couldn't sign in with Google" toast
  }
}
```

Backend errors from `POST /auth/google`:
- `400 GOOGLE_NOT_CONFIGURED` — Abraham hasn't set the env var yet. Hide the button until it's live.
- `401 GOOGLE_TOKEN_INVALID` — bad audience / expired / signature. Retry.
- `401 GOOGLE_EMAIL_UNVERIFIED` — the user's Google account has no verified email (rare — corp accounts). Show a message pointing them to email+password signup.

New Google users get: `emailVerified: true`, a placeholder `username`, `displayName` and `avatarUrl` from Google, no password (they can set one later via password reset).

---

## 8. Two-factor authentication

Four endpoints in the settings screen: setup, enable, disable, and the challenge on login. Add a "Two-Factor Authentication" section in Settings → Security.

### Enable 2FA

```ts
// Step 1: generate secret + QR
const { mutateAsync: setup } = useAuth2faSetup();
const setupRes = await setup();
// { secret, otpauthUrl, qrCodeDataUrl }

// Show the QR:
<Image
  source={{ uri: setupRes.data.qrCodeDataUrl }}
  style={{ width: 240, height: 240 }}
/>
<Text>Or type this secret manually: {setupRes.data.secret}</Text>

// Step 2: user scans → opens Google Authenticator / 1Password / Authy →
// gets a 6-digit code → types it into your input → you commit:
const { mutateAsync: enable } = useAuth2faEnable();
const enableRes = await enable({ data: { code: userInput } });

// Show the backup codes ONCE — force user to copy them:
<Text>Save these backup codes. Each works once.</Text>
{enableRes.data.backupCodes.map(c => <Text key={c}>{c}</Text>)}
```

Errors: `TWO_FACTOR_ALREADY_ENABLED`, `TWO_FACTOR_INVALID_CODE`, `TWO_FACTOR_NOT_INITIALIZED` (if they hit `/enable` without calling `/setup` first — unlikely from your flow).

### Disable 2FA

Requires the current password AND a valid TOTP or backup code (defense in depth against someone with only the password).

```ts
const { mutateAsync: disable } = useAuth2faDisable();
await disable({ data: { password, code } });
// Success → strip 2FA from settings UI, delete stored backup codes reminder
```

### The 2FA challenge on login

Already covered in **Section 5** — after `login` or `otp/verify(login)` or `googleSignIn` returns `requiresTwoFactor`, route to a 2FA screen that calls `POST /auth/2fa/challenge`:

```ts
const res = await challenge({
  data: { challengeToken, code, device: getDeviceInfo() },
});
// code = 6-digit TOTP OR one of the 8-char backup codes
await tokens.set(res.data.accessToken, res.data.refreshToken);
```

Errors:
- `TWO_FACTOR_INVALID_CODE` (400) — message includes attempts remaining
- `TWO_FACTOR_MAX_ATTEMPTS` (403) — 3 wrong tries per challenge; force re-login from scratch
- `TWO_FACTOR_CHALLENGE_INVALID` (401) — challengeToken expired (5 min) or already consumed. Back to the login screen.

### 2FA UX tips
- Backup codes screen: force a "I've saved these" checkbox before continuing.
- When 2FA is enabled, show a "2FA on" indicator in Settings.
- Losing both phone + backup codes = locked out. There's no recovery flow yet — mention this on the enable screen.

---

## 9. Sessions — "Manage devices" screen

Two endpoints: list active sessions, revoke one.

```ts
// Settings → Security → Active devices
const { data: sessions } = useUsersMeSessions();

// sessions: SessionDto[]
// each row: id, deviceName, deviceModel, platform, osVersion,
//           appVersion, lastUsedAt, lastUsedIp, createdAt, expiresAt

const { mutateAsync: revoke } = useUsersMeSessionsIdDelete();

async function onRevoke(sessionId: string) {
  await revoke({ id: sessionId });
  // Optimistic: refetch the sessions list
  await queryClient.invalidateQueries({ queryKey: ['usersMeSessions'] });
}
```

Sample row for the UI:

```
📱 Samuel's iPhone
   iPhone 15 Pro · iOS 18.2 · KinoX+ 1.0.0
   Last used 3 minutes ago · from 105.119.24.106
                                       [ Sign out ]
```

**About revoking your own session:** the user's *own* device shows up in the list too (there's no "current" flag — the backend can't tell from the JWT alone which refresh token is yours). If they revoke it, they'll be kicked to the login screen the next time their access token expires (up to 15 min in prod). This is fine — Netflix does the same.

**"Sign out of all devices"** button (also in Security): call `POST /auth/logout-all` (bearer). Also emails the user a security notice.

---

## 10. Profile + avatar upload

### Get the current user

```ts
const { data: user } = useUsersMe();
```

Returns the full profile: `id`, `email`, `phone`, `username`, `displayName`, `avatarUrl`, `avatarColor`, `bio`, `dateOfBirth`, `preferredGenres`, `role`, `emailVerified`, `phoneVerified`, `createdAt`.

### Update text/URL fields

```ts
const { mutateAsync: updateProfile } = useUsersMePatch();

await updateProfile({
  data: {
    displayName: 'Ada L.',
    username: 'priyan',
    avatarColor: '#3652D9',
    bio: 'Movie nights are my religion.',
    preferredGenres: ['Comedy', 'Family', 'Fantasy'],
  },
});
```

All fields optional — send only what changed. Returns the updated user. Errors: `409 USERNAME_TAKEN`, `400` for field validation. Debounce a username availability check (§ signup wizard) before submit so `USERNAME_TAKEN` almost never fires.

**Not settable via this endpoint:**
- `email` / `phone` — need OTP verification of the new value (flow not built yet)
- `password` — use `POST /auth/change-password`
- `dateOfBirth` — locked after signup

### Upload or replace the avatar

```
POST /users/me/avatar
Authorization: Bearer <accessToken>
Content-Type: multipart/form-data
```

Single form field `file`. Max 5MB. Accepted MIME: `image/jpeg`, `image/png`, `image/webp`, `image/gif`, `image/heic`, `image/heif`.

The backend uploads to Cloudinary (400×400 face-crop, auto quality + format conversion — HEIC becomes WebP automatically), stores the URL on `avatarUrl`, and returns the updated user.

React Native flow — use `expo-image-picker`, then FormData:

```ts
import * as ImagePicker from 'expo-image-picker';
import { tokens } from './api/token-store';

async function pickAndUploadAvatar() {
  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ImagePicker.MediaTypeOptions.Images,
    allowsEditing: true,
    aspect: [1, 1],
    quality: 0.8,
  });
  if (result.canceled) return;

  const asset = result.assets[0];
  const form = new FormData();
  form.append('file', {
    uri: asset.uri,
    name: asset.fileName ?? 'avatar.jpg',
    type: asset.mimeType ?? 'image/jpeg',
  } as any);

  const { access } = await tokens.get();
  const res = await fetch(
    'https://kinoxplus.onrender.com/users/me/avatar',
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${access}` },
      body: form,
    },
  );
  const { data: updatedUser } = await res.json();
  await queryClient.invalidateQueries({ queryKey: ['usersMe'] });
  return updatedUser;
}
```

**Critical: don't set `Content-Type` manually on `fetch` when sending `FormData`.** React Native sets it correctly with the multipart boundary. Setting it yourself breaks the upload.

Once done, `updatedUser.avatarUrl` is a Cloudinary CDN URL — render in `<Image source={{ uri: user.avatarUrl }} />` directly, no further transformation needed.

### Remove the avatar

```
DELETE /users/me/avatar
Authorization: Bearer <accessToken>
```

Clears `avatarUrl` so the UI falls back to the `avatarColor` swatch. Returns the updated user.

Errors: `400 NO_FILE`, `400 INVALID_FILE_TYPE`, `400 UPLOADS_NOT_CONFIGURED`, `413` (file > 5MB — Multer rejects before the handler runs).

**Note on cleanup:** old avatars are NOT deleted from Cloudinary when replaced today. They accumulate. At $0.05/GB/month it's negligible until you're at ~100k users — we'll write a cleanup job before that becomes real money.

---

## 11. Password reset

Two-step flow — verify the OTP on one screen, set the new password on the next:

```ts
// Screen 1: user enters email
await requestOtp({ data: { identifier: email, purpose: 'reset' } });
// Response is always generic ("If an account exists, code has been sent")
// so no way to enumerate emails.

// Screen 2: user enters code → get resetToken
const verify = await verifyOtp({
  data: { identifier: email, code, purpose: 'reset' },
});
const resetToken = verify.data.resetToken; // valid 15 min

// Screen 3: user enters new password → reset
const { mutateAsync: resetPassword } = useAuthResetPassword();
await resetPassword({
  data: { identifier: email, resetToken, newPassword },
});
// All sessions on that account are revoked. Navigate to login.
```

Single-step is also supported (`code` instead of `resetToken` on the last call) if you'd rather have fewer screens.

Errors: `RESET_TOKEN_INVALID` (expired — back to OTP screen), same OTP errors as elsewhere.

---

## 12. Logout

```ts
// Single-session logout (this device)
const { refresh } = await tokens.get();
await useAuthLogout().mutateAsync({ data: { refreshToken: refresh! } });
await tokens.clear();

// Sign out of all devices — settings screen action
await useAuthLogoutAll().mutateAsync();
await tokens.clear();
// Also emails the user a "all sessions signed out" security notice.
```

---

## 13. Post-registration email verification

You probably won't need this in v1 — the signup wizard's `signup` OTP already verifies the email before the account exists. But if you ever add an email-change flow, use this pair:

```ts
// Send the code (public):
await requestOtp({ data: { identifier: newEmail, purpose: 'verify' } });

// Consume + mark verified (BEARER REQUIRED — proves you own the account
// you're marking, so a leaked OTP can't be used against you):
const { mutateAsync: verifyEmail } = useAuthVerifyEmail();
await verifyEmail({ data: { code } });
// First success also sends the welcome email.
```

---

## 14. Error code catalog

All errors are `{ code, message }`. Trust `code` for logic; show `message` verbatim (already user-friendly).

| Endpoint | HTTP | code | UX response |
|---|---|---|---|
| register | 400 | `SIGNUP_TOKEN_INVALID` | Back to OTP screen — re-verify |
| register | 400 | `AGE_RESTRICTION` | "Must be 13+" |
| register | 400 | `INVALID_DOB` | Field validation error |
| register | 409 | `EMAIL_EXISTS` | Back to step 1, offer "Log in instead" |
| register | 409 | `USERNAME_TAKEN` | Stay on step 3, flag username field |
| register | 409 | `PHONE_EXISTS` | Only if phone provided |
| login | 401 | `INVALID_CREDENTIALS` | Show "Email or password is wrong" — don't distinguish |
| google | 400 | `GOOGLE_NOT_CONFIGURED` | Hide the button (env var not set on server) |
| google | 401 | `GOOGLE_TOKEN_INVALID` | Retry the Google sign-in |
| google | 401 | `GOOGLE_EMAIL_UNVERIFIED` | Prompt user to use email+password instead |
| refresh | 401 | `TOKEN_EXPIRED` | Handled by the interceptor |
| refresh | 401 | `TOKEN_REUSED` | Force logout, wipe storage, back to login (security event) |
| refresh | 401 | `TOKEN_INVALID` | Force logout, back to login |
| otp/request | 409 | `EMAIL_EXISTS` (signup only) | Bounce back to step 1 |
| otp/request | 429 | `OTP_COOLDOWN` | Disable Resend button for 60s |
| otp/request | 429 | `OTP_DAILY_LIMIT` | "Try again tomorrow" |
| otp/verify | 400 | `OTP_INVALID` | Message includes remaining attempts |
| otp/verify | 400 | `OTP_EXPIRED` | Send them back to Resend |
| otp/verify | 403 | `OTP_MAX_ATTEMPTS` | Force Resend |
| reset-password | 400 | `RESET_TOKEN_INVALID` | Back to OTP verify screen |
| 2fa/setup | 400 | `TWO_FACTOR_ALREADY_ENABLED` | Show the disable button instead |
| 2fa/enable | 400 | `TWO_FACTOR_INVALID_CODE` | "Wrong code — check the time on your phone" |
| 2fa/enable | 400 | `TWO_FACTOR_NOT_INITIALIZED` | Called `/enable` without `/setup` — restart flow |
| 2fa/disable | 401 | `INVALID_CREDENTIALS` | Current password wrong |
| 2fa/disable | 400 | `TWO_FACTOR_INVALID_CODE` | Wrong TOTP or backup code |
| 2fa/challenge | 400 | `TWO_FACTOR_INVALID_CODE` | Message includes remaining attempts |
| 2fa/challenge | 403 | `TWO_FACTOR_MAX_ATTEMPTS` | Force re-login from scratch |
| 2fa/challenge | 401 | `TWO_FACTOR_CHALLENGE_INVALID` | Token expired (5 min) — back to login |
| users/me/sessions/:id (DELETE) | 404 | `SESSION_NOT_FOUND` | Already revoked or bad ID — refresh list |
| verify-email | 400 | `NO_EMAIL` | Account has no email (rare) |
| users/me/avatar (POST) | 400 | `NO_FILE` | Field missing — check FormData key is "file" |
| users/me/avatar (POST) | 400 | `INVALID_FILE_TYPE` | Not JPEG/PNG/WebP/GIF/HEIC — reject in the picker |
| users/me/avatar (POST) | 400 | `UPLOADS_NOT_CONFIGURED` | Server env vars missing (shouldn't happen in prod) |
| users/me/avatar (POST) | 413 | (no code — Multer 413) | File > 5MB — compress or resize in the picker |
| users/me (PATCH) | 409 | `USERNAME_TAKEN` | Debounce availability check to prevent this |

Any authenticated endpoint may also return `401 UNAUTHORIZED` (no bearer) or `401 TOKEN_INVALID` (bad bearer). The interceptor handles refresh; if it can't, kick to login.

---

## 15. Response envelope

Every response is wrapped:

```json
{ "success": true, "data": { ... }, "meta": {} }
```

Orval-generated hooks unwrap `.data` for you. If you're calling axios directly, remember `res.data.data`.

---

## 16. Common footguns

1. **Not overwriting the refresh token after refresh.** Rotates on every call. Old ones trigger family revocation. Always store the fresh pair. This is the #1 mistake in refresh-token-based auth systems.
2. **Storing tokens in AsyncStorage.** It's unencrypted disk. Use SecureStore.
3. **Ignoring `TOKEN_REUSED`.** Wipe storage, kick to login. It means the backend detected token theft.
4. **Sending OTP request more than once per 60s per identifier.** Cooldown returns 429 — debounce the Resend button and show a countdown.
5. **Not discriminating the login response.** `POST /auth/login`, `POST /auth/google`, and `POST /auth/otp/verify` (with `purpose: 'login'`) can return either an `AuthSession` or a `TwoFactorRequired`. TypeScript will force you — use the `isTwoFactorRequired()` helper.
6. **Using purpose `verify` on `/auth/otp/verify`.** That path was removed. Post-registration email verification lives at `POST /auth/verify-email` (bearer required).
7. **Forgetting device info.** Not sending `device` on login means the session shows up as untagged in the sessions list. Not a bug, just bad UX.
8. **Google — using the wrong client ID.** The `webClientId` in `GoogleSignin.configure()` MUST match the backend's `GOOGLE_CLIENT_ID` env var. Different mobile client IDs are also fine on iOS/Android in addition, but the backend verifies audience against the web one.
9. **Showing backup codes twice.** They're returned only from `/2fa/enable`. If the user closes the screen, they're gone. Force a "I saved them" confirmation.
10. **Trusting `emailVerified` from a JWT.** The JWT only has `sub` (userId) and `role` — check the `user` object from login/register/refresh responses instead.
11. **Setting `Content-Type: multipart/form-data` manually for avatar upload.** React Native's `fetch` sets it correctly (with the boundary) when you pass FormData. If you set it yourself, the boundary is missing and the server can't parse the body.

---

## Bonus: contract change protocol

Whenever the backend breaks the API contract, I'll:
1. Add a `## API changes` section to the commit message
2. Update this doc in the same PR
3. Ping you in Slack/wherever

Your side: re-run `npm run api:generate`, let TypeScript flag broken call sites, ship.

---

## Quick reference — the whole auth surface

```
POST   /auth/register                — 3-step wizard submit
POST   /auth/login                   — email/phone + password
POST   /auth/google                  — Google ID token exchange
POST   /auth/refresh                 — rotate tokens
POST   /auth/logout                  — revoke current session
POST   /auth/logout-all              — revoke all sessions
GET    /auth/username-available      — signup step 3 inline check
POST   /auth/otp/request             — send OTP (signup/login/verify/reset)
POST   /auth/otp/verify              — consume OTP (signup/login/reset)
POST   /auth/verify-email            — post-registration email verify (bearer)
POST   /auth/change-password         — bearer
POST   /auth/reset-password          — OTP or resetToken + newPassword
POST   /auth/2fa/setup               — bearer, returns QR
POST   /auth/2fa/enable              — bearer, returns backup codes
POST   /auth/2fa/disable             — bearer + password + code
POST   /auth/2fa/challenge           — challengeToken + code → tokens

GET    /users/me                     — current user profile
PATCH  /users/me                     — update profile fields
POST   /users/me/avatar              — upload / replace avatar (multipart)
DELETE /users/me/avatar              — remove avatar (fall back to color)
POST   /users/me/devices             — register FCM token for push
GET    /users/me/sessions            — list active sessions
DELETE /users/me/sessions/:id        — revoke one session

GET    /catalog/genres               — canonical genre list (public)
GET    /catalog/titles               — public
GET    /catalog/titles/:slug         — public
GET    /health                       — public
```
