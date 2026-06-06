# Soundswitch → lightviz setup

How to get **Soundswitch's Art-Net DMX** into the lightviz bridge so you can
previz your rig while you design looks — no DMX hardware required.

> **The one rule that makes this work: run the bridge natively on Windows,
> not inside WSL.** Everything else follows from that. See "Why not WSL?" at
> the bottom if you care about the reasoning — it cost us an afternoon.

## TL;DR

1. **Soundswitch** → Preferences → **DMX & Art-Net**:
   - ☑ **Enable Art-Net**
   - ☑ **Localhost Art-Net Node**  ← this is the path that actually delivers DMX
2. Run the bridge **on Windows** (Node is already installed there):
   ```bat
   node "\\wsl.localhost\Ubuntu-26.04\home\grays\lightviz\server\index.js"
   ```
   (or double-click `lightviz-bridge.bat` in your Windows home — see below)
3. **Play a track in Soundswitch's editor.** Within a second the bridge logs:
   ```
   [artnet] first packet on universe 0 (...) from 127.0.0.1:6454, 512 slots
   [artnet] u0: 38 pkt/s · u1: 38 pkt/s from 127.0.0.1:6454
   ```
   That's it working.
4. Run the client (in WSL) and open it in your Windows browser:
   ```bash
   npm run client     # Vite dev server on :5173
   ```
   Patch fixtures to **universe 0 / 1** to match Soundswitch (see Universes).

## Soundswitch side, in detail

Preferences → **DMX & Art-Net**:

- **Enable Art-Net** — on.
- **Localhost Art-Net Node** — **on**. This is the supported way to feed a
  visualizer running on the *same machine*: Soundswitch emits DMX to
  `127.0.0.1:6454`, which the bridge listens for.
- The **interface list** may show a discovered node row (`lightviz, <ip>, 1`)
  with **Protocol: N/A** and a greyed-out **Test** button. **Ignore that row.**
  Soundswitch refuses to transmit Art-Net to its own machine IP, so the
  discovered-node path never carries data on a single-box setup. The bridge
  still answers Soundswitch's discovery polls (so the name appears), but the
  actual DMX comes via the Localhost node above, not this row. The "connected"
  indicator on that row is cosmetic — **trust the bridge's `pkt/s` log, not the
  Soundswitch UI.**

### DMX only flows while a track is playing

Edit mode *does* output DMX (it's what drives your hardware while you design).
But Art-Net is only emitted while a track is actually **playing** (playhead
moving) — a loaded-but-paused track sends nothing. That's expected and fine for
look-dev: hit play, scrub, watch the rig animate.

### Universes

Soundswitch's **"Universe One" = Art-Net universe 0**, **"Universe Two" =
Art-Net universe 1** (Soundswitch labels are 1-based; Art-Net is 0-based). The
bridge logs the actual integer it received — trust that and patch fixtures in
lightviz to match.

## Running the bridge on Windows

The bridge (`server/index.js`) only depends on `ws` (pure JS), so Windows Node
runs it directly from the WSL project path — no copy, no separate `npm install`:

```bat
node "\\wsl.localhost\Ubuntu-26.04\home\grays\lightviz\server\index.js"
```

A convenience launcher lives at `%UserProfile%\lightviz-bridge.bat` (created
during setup); double-click it or run it from a Windows terminal.

The bridge binds **both** `0.0.0.0:6454` and a dedicated `127.0.0.1:6454`
socket. The loopback socket is essential: Soundswitch is itself bound to
`0.0.0.0:6454`, and on Windows a loopback *unicast* to `127.0.0.1:6454` is
delivered to only one socket (shared-port "last binder wins"). Binding the
specific `127.0.0.1` address wins that delivery by longest-prefix match, which
is what makes same-machine capture reliable instead of flaky.

The client (Vite) keeps running in WSL — your Windows browser reaches both the
WSL dev server (`:5173`, via WSL's mirrored localhost) and the Windows bridge
(`:7777`, native).

## Verifying the stream

- **Bridge log** prints `[artnet] first packet on universe N (...)` on first
  packet, then per-second `uN: NN pkt/s from 127.0.0.1:6454`. A healthy
  Soundswitch stream is ~38 pkt/s per universe.
- **Client HUD** (top-left in the browser) shows `ws: open` and the universe
  count once data arrives.
- Drop a fixture in, patch it to universe 0/1 + the right start address, and it
  animates to the music.

### Self-test without Soundswitch

To prove the render/patch pipeline independent of Soundswitch, run the bridge
with synthetic DMX:

```bash
SYNTH=1 npm run server      # drives patched fixtures with a sine sweep
```

(Run that in WSL just to exercise the client; for real Soundswitch capture the
bridge must be the Windows process.)

## Why not WSL? (the trap)

The obvious setup — run the bridge in WSL, use mirrored networking so
Soundswitch's broadcast reaches it — **does not work**, and fails silently:

- In **mirrored** networking mode, WSL shares Windows' network namespace.
  Soundswitch (Windows) binds `0.0.0.0:6454`; the WSL bridge binding the same
  port is **shadowed** — it receives *nothing*, unicast or broadcast. Verified
  by sending the WSL bridge hand-built Art-Net packets that vanished into
  Soundswitch's bind.
- **NAT** mode gives WSL its own port namespace (no collision), but then
  Soundswitch can't easily target the WSL IP (its ArtPoll broadcast doesn't
  reach the WSL subnet, and inbound Windows→WSL UDP needs extra plumbing).

Running the bridge **natively on Windows** sidesteps all of it: it co-exists on
6454 with Soundswitch, hears the localhost output, and needs zero networking
config. That's why the bridge is a Windows process even though the repo lives
in WSL.

## Common pitfalls

- **Toggling "Enable Art-Net" off/on un-checks "Localhost Art-Net Node".** If
  DMX stops, re-check Localhost Art-Net Node.
- **Port 7777 already in use.** A leftover WSL bridge from a previous run holds
  the WebSocket port (mirrored mode shares it with Windows). Kill the stray
  `node server/index.js` in WSL before starting the Windows bridge.
- **Nothing in the log.** Make sure a track is actually *playing*, not paused.
- **Distro name in the path.** The `\\wsl.localhost\Ubuntu-26.04\...` path
  embeds your distro name — adjust if yours differs (`wsl -l -q` to check).
