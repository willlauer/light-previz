# Soundswitch → lightviz (WSL) setup

This is the path from **Soundswitch on Windows** to the **Node bridge running
inside WSL2**. The hard part isn't Soundswitch — it's getting Windows-side
UDP Art-Net packets into the WSL virtual network.

You only have to set this up once. There are two viable approaches; mirrored
networking is much less fiddly, so try that first.

## 0. Soundswitch side

In Soundswitch:
1. **Settings → DMX Output → Art-Net**.
2. Enable it. Set **Universe 0** (or whatever you want — just remember the
   number; the patching UI in lightviz needs to match).
3. **Output Mode**:
   - **Broadcast** (`255.255.255.255` or your subnet's broadcast) — works
     with mirrored networking (Path A).
   - **Unicast** — set the destination IP to the WSL2 instance's IP
     (Path B). Use this if mirrored networking is unavailable.

Verify Soundswitch is actually emitting: in the SS Art-Net settings panel
there's usually a "packets sent" counter. If that doesn't tick when a song
is playing, Soundswitch itself isn't outputting yet.

## Path A — Mirrored networking (Windows 11 22H2+, recommended)

This makes WSL2 share the Windows host's network stack, so Soundswitch
broadcasting on `0.0.0.0:6454` reaches WSL2 directly.

1. On the Windows host, edit `%UserProfile%\.wslconfig` (create it if
   missing):

   ```ini
   [wsl2]
   networkingMode=mirrored
   firewall=true

   [experimental]
   hostAddressLoopback=true
   ```

2. From an *elevated* PowerShell:

   ```powershell
   wsl --shutdown
   ```

3. Open a new WSL shell and confirm the WSL IP matches a real Windows
   adapter:

   ```bash
   ip addr show | grep inet
   ```

   You should see your Windows LAN IP (e.g. `192.168.1.x`) listed inside
   WSL — that means mirrored mode is active.

4. Add a Windows Defender Firewall **inbound** rule for UDP 6454 (run in
   elevated PowerShell):

   ```powershell
   New-NetFirewallRule -DisplayName "Art-Net to WSL" `
       -Direction Inbound -Protocol UDP -LocalPort 6454 `
       -Action Allow -Profile Any
   ```

5. Start the bridge inside WSL: `npm run server`. You should see
   `[artnet] listening on 0.0.0.0:6454 (UDP)`.

6. Play something in Soundswitch. Within a second the server log should
   start emitting per-second summaries like:

   ```
   [artnet] u0: 44 pkt/s from 192.168.1.23:6454
   ```

## Path B — Unicast fallback (any WSL2 version)

If you don't have mirrored networking, configure Soundswitch to **unicast**
directly to WSL2's IP. UDP port-forwarding via `netsh portproxy` doesn't
work (TCP only), so this is the practical alternative.

1. Get WSL2's IP from inside WSL:

   ```bash
   ip addr show eth0 | grep -oP 'inet \K[0-9.]+'
   ```

   You'll see something like `172.21.42.183`. This IP is **regenerated on
   every WSL reboot** by default; expect to redo the Soundswitch destination
   IP step after restarting Windows.

2. In Soundswitch's Art-Net output, set the **destination IP** to that
   value (`172.21.42.183` in the example). Leave port at the default 6454.

3. Add a Windows firewall inbound rule allowing UDP 6454 (same command as
   Path A step 4).

4. Start the bridge inside WSL: `npm run server`. Look for the per-second
   `[artnet] u0: N pkt/s from <ip>` lines once Soundswitch is playing.

If you need to pin WSL2's IP so step 2 doesn't drift, see Microsoft's docs
on WSL static IPs (involves either `wsl.conf` networking tweaks or a
startup script). Easier is just to live with `ip a` after reboots.

## Verifying the stream

Once Soundswitch is outputting and the bridge is listening:

- **Server logs** should show `[artnet] first packet on universe 0 (...)`
  on the first packet, then per-second `pkt/s` summaries.
- **Client HUD** (top-left in the browser) shows `universes: 0` once any
  universe has been seen, and `ws: open` confirms the browser is connected
  to the bridge.
- Drop a fixture into the scene, patch it to match Soundswitch's universe
  and start address (outliner sidebar → click fixture → patch row), and it
  should animate to the song.

## Common pitfalls

- **Firewall blocks Soundswitch's broadcast.** If you don't add the
  inbound rule, Windows quietly drops the UDP frames before they reach
  WSL. Symptom: bridge log stays empty, even with mirrored mode.
- **Multiple network interfaces.** If Windows has both Wi-Fi and Ethernet
  active, Soundswitch may pick one and broadcast won't reach WSL via the
  other. In SS, pin the Art-Net output to the same adapter you expect WSL
  to see (under "Output Interface").
- **Universe / address mismatch.** Soundswitch's "Universe 1" vs Art-Net
  "universe 0" — different vendors index from 0 or 1. The bridge logs the
  actual integer it received; trust that, then patch fixtures in lightviz
  to match.
- **WSL2 mirrored mode but no packets.** Confirm with `tcpdump -i any
  udp port 6454 -nn` from inside WSL while playing — if tcpdump sees
  packets but the bridge doesn't, something else is binding port 6454.
