# KinoX+ Video Call — Frontend Fix (React Native)

Backend is fine — the LiveKit token now explicitly permits `CAMERA` + `SCREEN_SHARE` alongside `MICROPHONE`. Since audio and chat work, the room connection is healthy. **Video needs three things on the client that audio doesn't**: OS-level camera permission, an explicit `setCameraEnabled(true)` call, and a `<VideoView>` component to render the tracks. Miss any one and video silently doesn't work.

This doc walks through fixing all three.

---

## 1. TL;DR — the three lines that make video work

After you're already connected to the LiveKit room (the same connection that made audio work):

```ts
// 1. Grant camera permission (must be done ONCE before the first video call)
const cameraGranted = await requestCameraPermission();
if (!cameraGranted) throw new Error('Camera permission denied');

// 2. Publish your camera track
await room.localParticipant.setCameraEnabled(true);

// 3. Render every participant's video (local + remote) with <VideoView />
```

Details for each step below.

---

## 2. Install the right packages

If you're **already using `@livekit/react-native`** for audio calls, skip this section — the same packages carry video. If not:

```bash
npm i @livekit/react-native @livekit/react-native-webrtc livekit-client
```

**Critical:** `livekit-client` (the browser SDK) alone WILL NOT WORK for video on-device. You must use `@livekit/react-native` and its native WebRTC binary via `@livekit/react-native-webrtc`. If audio "worked" but only in a browser-based Expo Go preview, that's why video fails on real devices.

### iOS extra step
```bash
cd ios && pod install && cd ..
```

### Expo (managed) extra step
Expo Go doesn't ship the native WebRTC binary. You need a **development build**:

```bash
npx expo prebuild --clean
eas build --profile development --platform ios       # or android
```

Then run the built dev client, not Expo Go.

---

## 3. Camera + microphone permissions

### iOS — `app.json` (Expo) or `Info.plist` (bare RN)

**Expo (`app.json` or `app.config.js`):**
```json
{
  "expo": {
    "ios": {
      "infoPlist": {
        "NSCameraUsageDescription": "KinoX+ needs your camera so friends can see you in Watch Rooms.",
        "NSMicrophoneUsageDescription": "KinoX+ needs your microphone so friends can hear you in Watch Rooms."
      }
    }
  }
}
```

**Bare RN (`ios/YourApp/Info.plist`):**
```xml
<key>NSCameraUsageDescription</key>
<string>KinoX+ needs your camera so friends can see you in Watch Rooms.</string>
<key>NSMicrophoneUsageDescription</key>
<string>KinoX+ needs your microphone so friends can hear you in Watch Rooms.</string>
```

Miss `NSCameraUsageDescription` → iOS App Store rejects the build AND the app instantly crashes when it tries to access the camera.

### Android — `app.json` (Expo) or `AndroidManifest.xml` (bare RN)

**Expo:**
```json
{
  "expo": {
    "android": {
      "permissions": ["CAMERA", "RECORD_AUDIO"]
    }
  }
}
```

**Bare RN (`android/app/src/main/AndroidManifest.xml`):**
```xml
<uses-permission android:name="android.permission.CAMERA" />
<uses-permission android:name="android.permission.RECORD_AUDIO" />
<uses-feature android:name="android.hardware.camera" android:required="false" />
```

### Runtime permission prompt

Declaring the manifest isn't enough on Android and modern iOS — you have to **request** at runtime, right before starting the video call:

```ts
import { PermissionsAndroid, Platform } from 'react-native';

async function requestCameraPermission(): Promise<boolean> {
  if (Platform.OS === 'ios') {
    // iOS: the system prompt fires automatically the first time you access
    // the camera — you just need NSCameraUsageDescription in Info.plist.
    return true;
  }

  const results = await PermissionsAndroid.requestMultiple([
    PermissionsAndroid.PERMISSIONS.CAMERA,
    PermissionsAndroid.PERMISSIONS.RECORD_AUDIO,
  ]);
  return (
    results[PermissionsAndroid.PERMISSIONS.CAMERA] === 'granted' &&
    results[PermissionsAndroid.PERMISSIONS.RECORD_AUDIO] === 'granted'
  );
}
```

Or with `expo-camera` if you already use it: `await Camera.requestCameraPermissionsAsync()`.

---

## 4. Connect + enable video

Assuming your token request already works (this is the endpoint that returned audio-working tokens):

```ts
import {
  Room,
  RoomEvent,
  Track,
  createLocalVideoTrack,
} from 'livekit-client';

async function joinVideoRoom(roomBackendId: string) {
  // 1. Ask backend for a token (existing code — no change needed)
  const { token, roomName, livekitUrl } = await fetch(
    `https://kinoxplus.onrender.com/rooms/${roomBackendId}/voice-token`,
    { method: 'POST', headers: { Authorization: `Bearer ${accessToken}` } },
  ).then((r) => r.json()).then((r) => r.data);

  // 2. Ensure camera permission BEFORE connecting
  const granted = await requestCameraPermission();
  if (!granted) throw new Error('Camera permission denied');

  // 3. Connect to LiveKit
  const room = new Room({
    adaptiveStream: true,
    dynacast: true,
    // Video codec — VP8 is safest for RN (H.264 hardware acceleration
    // can misbehave on older Android). Only override if you know why.
  });
  await room.connect(livekitUrl, token);

  // 4. Publish both mic AND camera. This is the line that makes you visible.
  await room.localParticipant.setMicrophoneEnabled(true);
  await room.localParticipant.setCameraEnabled(true);   // ⭐ this is what was missing

  // 5. Attach event handlers for remote participants' video
  room.on(RoomEvent.TrackSubscribed, (track, publication, participant) => {
    if (track.kind === Track.Kind.Video) {
      // A remote participant just started their camera. Trigger a re-render
      // so <VideoView> shows their track (see next section).
      forceRerender();
    }
  });

  room.on(RoomEvent.TrackUnsubscribed, (track) => {
    if (track.kind === Track.Kind.Video) {
      // They turned off their camera. Rerender to swap in the offline avatar.
      forceRerender();
    }
  });

  return room;
}
```

**Why `setCameraEnabled(true)` is the critical line:** LiveKit auto-publishes microphone tracks when you call `connect()` with default options. It does NOT auto-publish camera tracks — you have to opt in explicitly. This is by design (camera has bigger battery, bandwidth, and privacy cost than mic).

If Samuel skipped this line, everyone is connected and can hear each other, but nobody has a camera track to broadcast, so nobody sees anybody. Which matches exactly the reported symptom.

---

## 5. Render local + remote video

Import LiveKit's React Native components:

```tsx
import { VideoView, useTracks } from '@livekit/react-native';
import { Track } from 'livekit-client';

function RoomVideoGrid({ room }: { room: Room }) {
  // Grabs every camera track (local + remote) as a flat list
  const cameraTracks = useTracks([Track.Source.Camera], { onlySubscribed: true });

  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap' }}>
      {cameraTracks.map((trackRef) => (
        <View
          key={trackRef.publication?.trackSid}
          style={{ width: '50%', aspectRatio: 16 / 9 }}
        >
          <VideoView
            style={StyleSheet.absoluteFill}
            trackRef={trackRef}
            objectFit="cover"
            // Mirror only your own camera preview — remote video is not mirrored
            mirror={trackRef.participant.isLocal}
          />
          <Text style={{ position: 'absolute', bottom: 6, left: 8, color: 'white' }}>
            {trackRef.participant.identity}
          </Text>
        </View>
      ))}
    </View>
  );
}
```

**Or manually without hooks:**

```tsx
function ParticipantVideo({ participant }: { participant: Participant }) {
  const cameraPub = participant.getTrackPublication(Track.Source.Camera);
  const videoTrack = cameraPub?.videoTrack;

  if (!videoTrack) {
    // Camera off — show avatar or color swatch
    return <AvatarFallback user={participant.identity} />;
  }

  return (
    <VideoView
      videoTrack={videoTrack}
      style={{ width: '100%', aspectRatio: 16 / 9 }}
      objectFit="cover"
      mirror={participant.isLocal}
    />
  );
}
```

**Critical:** if you don't render `<VideoView>`, the video track is being received and playing in the background — you just can't see it. Audio "just plays" through the speaker without any component; video does not.

---

## 6. Toggle camera / switch front-back / cleanup

### Toggle camera on/off
```ts
async function toggleCamera(room: Room) {
  const enabled = room.localParticipant.isCameraEnabled;
  await room.localParticipant.setCameraEnabled(!enabled);
}
```

### Switch front ↔ back
```ts
async function switchCamera(room: Room) {
  const cameraPub = room.localParticipant.getTrackPublication(Track.Source.Camera);
  const track = cameraPub?.videoTrack;
  if (track) {
    await track.restartTrack({ facingMode: 'environment' }); // or 'user'
  }
}
```

### Cleanup on unmount
```ts
useEffect(() => {
  return () => {
    room?.disconnect();
  };
}, [room]);
```

If you don't disconnect, the camera stays hot after the user leaves the room screen — battery drain + privacy indicator stays on. Users will not-hire you for this.

---

## 7. Troubleshooting checklist

Match the symptom to the fix:

| Symptom | Most likely cause | Fix |
|---|---|---|
| Camera indicator light **never** turns on | Missing `setCameraEnabled(true)` call | Add it after `room.connect()` |
| Camera light turns on, but no one (including you) sees video | Missing `<VideoView>` render | Wire the render loop from §5 |
| App crashes when trying to enable camera | Missing `NSCameraUsageDescription` (iOS) or `CAMERA` permission (Android) | Add manifest entries from §3 |
| Camera works in Expo Go, doesn't work in real build | Missing `pod install` (iOS) or dev build (Expo) | Follow §2 native setup |
| `setCameraEnabled` throws "device not found" | Camera hardware not available (simulator) or another app holding the camera | Test on a real device; kill other apps |
| Only I see myself, no remotes | `TrackSubscribed` handler missing → no re-render when remote publishes | Wire the event handlers from §4 |
| Video is upside-down or mirrored wrong | `mirror` prop misconfigured | `mirror={participant.isLocal}` — mirror your OWN feed, not others' |
| Video freezes after ~30 seconds | Adaptive stream not enabled, poor network | `adaptiveStream: true, dynacast: true` in the `Room` constructor |
| First join works, second join fails | Not calling `room.disconnect()` on unmount → LiveKit still has the old connection | See cleanup in §6 |
| Everything on iOS, nothing on Android | Missing Android permissions in manifest | See §3 Android block |

---

## 8. One-shot verification

After all changes, this test proves the whole path works:

1. Grant camera permission (system prompt should fire)
2. Join a room from device A
3. Join the same room from device B (or an Android emulator)
4. Both should call `setCameraEnabled(true)` after connect
5. Each should render the other via `<VideoView>`
6. Toggle camera off on A → B's VideoView should switch to your fallback avatar
7. Toggle back on → B's VideoView should re-appear

If step 1-2 fails: permission issue. If 3-4 fails: SDK setup or backend token (unlikely — audio works). If 5 fails: render code. If 6-7 fails: event handlers.

---

## 9. Diagnostic to send back to backend

If after all of the above video still doesn't work, capture this and send to Abraham (backend):

```ts
room.on(RoomEvent.ConnectionStateChanged, (state) => console.log('LiveKit state', state));
room.on(RoomEvent.MediaDevicesError, (e) => console.error('Media devices error', e));
room.localParticipant.on('trackPublished', (pub) => console.log('Published', pub.kind, pub.source));
room.localParticipant.on('trackPublicationFailed', (e) => console.error('Publish failed', e));
```

Paste whatever comes out and Abraham can pinpoint whether the failure is at connect, permission, publish, or subscribe.

---

## What Abraham already fixed on the backend

Just so you know the backend side is definitely not the blocker anymore, the LiveKit token now explicitly grants:

- `canPublishSources: [MICROPHONE, CAMERA, SCREEN_SHARE, SCREEN_SHARE_AUDIO]`
- `canPublishData: true` (data channel for metadata)
- `canUpdateOwnMetadata: true` (camera on/off state sync)

So if video fails after this doc's fixes, ping Abraham with the diagnostic logs from §9 and it's back on him.
